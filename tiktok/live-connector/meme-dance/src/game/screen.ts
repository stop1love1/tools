import * as THREE from "three";
import type { Beat } from "./player";

const W = 1024;
const H = 320;

/**
 * Màn hình LED to phía trên bàn DJ: tên bài đang phát + cột EQ theo phổ tần
 * thật của nhạc. Khi chưa có nhạc: hướng dẫn mở Cài đặt để phát.
 */
export type ScreenControl = "prev" | "toggle" | "next";

// Nút điều khiển vẽ trên màn LED: (x tâm, bán kính) — y cố định
const BTN_Y = 158;
const BTN_R = 26;
const BUTTONS: Array<{ id: ScreenControl; x: number }> = [
  { id: "prev", x: W / 2 - 92 },
  { id: "toggle", x: W / 2 },
  { id: "next", x: W / 2 + 92 },
];

export class NowPlayingScreen {
  readonly mesh: THREE.Mesh;
  /** Trạng thái tạm dừng — để vẽ ▶ / ⏸ đúng. */
  paused = false;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private title = "";
  private acc = 0;

  constructor(width: number, height: number, position: THREE.Vector3) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: this.texture }),
    );
    this.mesh.position.copy(position);
    this.draw(null, { index: 0, pulse: 0 });
  }

  setTitle(title: string) {
    this.title = title;
  }

  /** Đổi tọa độ UV (raycast) ra nút bấm — null nếu không trúng nút nào. */
  hitTest(u: number, v: number): ScreenControl | null {
    const x = u * W;
    const y = (1 - v) * H;
    for (const btn of BUTTONS) {
      const dx = x - btn.x;
      const dy = y - BTN_Y;
      if (dx * dx + dy * dy <= (BTN_R + 10) * (BTN_R + 10)) return btn.id;
    }
    return null;
  }

  private drawControls() {
    const c = this.ctx;
    for (const btn of BUTTONS) {
      c.beginPath();
      c.arc(btn.x, BTN_Y, BTN_R, 0, Math.PI * 2);
      c.fillStyle = "rgba(255,255,255,0.08)";
      c.fill();
      c.strokeStyle = "rgba(37,244,238,0.55)";
      c.lineWidth = 2;
      c.stroke();

      c.fillStyle = "#cfd6ff";
      const x = btn.x;
      const y = BTN_Y;
      c.beginPath();
      if (btn.id === "prev") {
        // ⏮ phát lại: vạch + tam giác trái
        c.fillRect(x - 12, y - 10, 4, 20);
        c.moveTo(x + 12, y - 10);
        c.lineTo(x - 4, y);
        c.lineTo(x + 12, y + 10);
        c.closePath();
        c.fill();
      } else if (btn.id === "toggle") {
        if (this.paused || !this.title) {
          // ▶
          c.moveTo(x - 7, y - 11);
          c.lineTo(x + 12, y);
          c.lineTo(x - 7, y + 11);
          c.closePath();
          c.fill();
        } else {
          // ⏸
          c.fillRect(x - 10, y - 11, 7, 22);
          c.fillRect(x + 3, y - 11, 7, 22);
        }
      } else {
        // ⏭ bài kế: tam giác phải + vạch
        c.moveTo(x - 12, y - 10);
        c.lineTo(x + 4, y);
        c.lineTo(x - 12, y + 10);
        c.closePath();
        c.fill();
        c.fillRect(x + 8, y - 10, 4, 20);
      }
    }
  }

  update(dt: number, spectrum: Uint8Array<ArrayBuffer> | null, beat: Beat) {
    this.acc += dt;
    if (this.acc < 0.08) return; // ~12fps đủ cho màn LED
    this.acc = 0;
    this.draw(spectrum, beat);
  }

  private drawFrame() {
    const c = this.ctx;
    // Nền gradient tối + viền neon 2 lớp
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0b0d1c");
    bg.addColorStop(0.55, "#05060d");
    bg.addColorStop(1, "#0a0716");
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);
    c.strokeStyle = "#2a3054";
    c.lineWidth = 6;
    c.strokeRect(3, 3, W - 6, H - 6);
    c.strokeStyle = "rgba(37,244,238,0.35)";
    c.lineWidth = 2;
    c.strokeRect(10, 10, W - 20, H - 20);
  }

  private drawEq(spectrum: Uint8Array<ArrayBuffer> | null, kick: number) {
    const c = this.ctx;
    const bars = 36;
    const barW = (W - 80) / bars;
    for (let i = 0; i < bars; i++) {
      let v = 0.06 + kick * 0.08;
      if (spectrum) {
        const a = spectrum[1 + i * 2] ?? 0;
        const b = spectrum[2 + i * 2] ?? 0;
        v = (a + b) / 510;
      } else {
        // Sóng chờ nhẹ nhàng khi chưa có nhạc
        v = 0.05 + 0.04 * Math.sin(performance.now() / 400 + i * 0.5);
      }
      const h = Math.max(5, v * 110);
      const hue = (188 + i * 4.6) % 360;
      const x = 40 + i * barW;
      const grad = c.createLinearGradient(0, H - 24 - h, 0, H - 24);
      grad.addColorStop(0, `hsl(${hue} 95% ${58 + v * 25}%)`);
      grad.addColorStop(1, `hsl(${hue} 80% 30%)`);
      c.fillStyle = grad;
      c.beginPath();
      c.roundRect(x, H - 24 - h, barW * 0.68, h, 3);
      c.fill();
    }
  }

  private draw(spectrum: Uint8Array<ArrayBuffer> | null, beat: Beat) {
    const c = this.ctx;
    const kick = Math.max(0, 1 - beat.pulse * 3);
    this.drawFrame();

    if (!this.title) {
      // Màn chờ: chỉ nốt nhạc pulse + sóng EQ nhẹ — không chữ hướng dẫn
      // (người xem stream không thấy text kiểu developer)
      const t = performance.now() / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(t * 1.8);
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.font = "700 96px system-ui, sans-serif";
      c.shadowColor = "rgba(37,244,238,0.8)";
      c.shadowBlur = 18 + pulse * 26;
      c.fillStyle = `rgba(143,151,196,${0.5 + pulse * 0.4})`;
      c.fillText("♪", W / 2, H / 2 - 62);
      c.shadowBlur = 0;
      this.drawControls();
      this.drawEq(null, 0);
      this.texture.needsUpdate = true;
      return;
    }

    // Tên bài chính giữa, glow nhẹ nhấp nháy theo beat
    let label = `♪ ${this.title}`;
    c.font = "700 58px system-ui, sans-serif";
    while (c.measureText(label).width > W - 90 && label.length > 6) {
      label = `${label.slice(0, -2)}…`;
    }
    const hue = (347 + beat.index * 7) % 360;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.shadowColor = `hsl(${hue} 95% 60%)`;
    c.shadowBlur = 14 + kick * 22;
    c.fillStyle = `hsl(${hue} 95% ${64 + kick * 16}%)`;
    c.fillText(label, W / 2, H / 2 - 62);
    c.shadowBlur = 0;

    this.drawControls();
    this.drawEq(spectrum, kick);
    this.texture.needsUpdate = true;
  }
}
