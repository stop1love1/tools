import * as THREE from "three";
import type { Beat } from "./player";

const W = 1024;
const H = 320;

export type ScreenControl = "prev" | "toggle" | "next";
export type ScreenHit = ScreenControl | { seek: number };

const BTN_Y = 150;
const BTN_R = 30;
const BUTTONS: Array<{ id: ScreenControl; x: number }> = [
  { id: "prev", x: W / 2 - 100 },
  { id: "toggle", x: W / 2 },
  { id: "next", x: W / 2 + 100 },
];

const BAR_X = 120;
const BAR_W = W - BAR_X * 2;
const BAR_Y = 208;

export type Progress = { time: number; duration: number } | null;

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class NowPlayingScreen {
  readonly mesh: THREE.Mesh;
  paused = false;
  /** Requester's nickname, shown under the title when someone ordered it. */
  orderedBy: string | null = null;
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
    this.draw(null, { index: 0, pulse: 1 }, null);
  }

  setTitle(title: string) {
    this.title = title;
  }

  hitTest(u: number, v: number): ScreenHit | null {
    const x = u * W;
    const y = (1 - v) * H;
    for (const btn of BUTTONS) {
      const dx = x - btn.x;
      const dy = y - BTN_Y;
      if (dx * dx + dy * dy <= (BTN_R + 12) * (BTN_R + 12)) return btn.id;
    }
    if (this.title && y >= BAR_Y - 22 && y <= BAR_Y + 24 && x >= BAR_X - 10 && x <= BAR_X + BAR_W + 10) {
      return { seek: Math.min(1, Math.max(0, (x - BAR_X) / BAR_W)) };
    }
    return null;
  }

  private drawControls() {
    const c = this.ctx;
    for (const btn of BUTTONS) {
      const active = btn.id === "toggle";
      c.beginPath();
      c.arc(btn.x, BTN_Y, active ? BTN_R + 4 : BTN_R, 0, Math.PI * 2);
      c.fillStyle = active ? "rgba(37,244,238,0.14)" : "rgba(255,255,255,0.08)";
      c.fill();
      c.strokeStyle = active ? "rgba(37,244,238,0.9)" : "rgba(37,244,238,0.45)";
      c.lineWidth = active ? 3 : 2;
      c.stroke();

      c.fillStyle = "#e8ecff";
      const x = btn.x;
      const y = BTN_Y;
      c.beginPath();
      if (btn.id === "prev") {
        c.fillRect(x - 13, y - 11, 4, 22);
        c.moveTo(x + 13, y - 11);
        c.lineTo(x - 5, y);
        c.lineTo(x + 13, y + 11);
        c.closePath();
        c.fill();
      } else if (btn.id === "toggle") {
        if (this.paused || !this.title) {
          c.moveTo(x - 8, y - 13);
          c.lineTo(x + 14, y);
          c.lineTo(x - 8, y + 13);
          c.closePath();
          c.fill();
        } else {
          c.fillRect(x - 11, y - 13, 8, 26);
          c.fillRect(x + 4, y - 13, 8, 26);
        }
      } else {
        c.moveTo(x - 13, y - 11);
        c.lineTo(x + 5, y);
        c.lineTo(x - 13, y + 11);
        c.closePath();
        c.fill();
        c.fillRect(x + 9, y - 11, 4, 22);
      }
    }
  }

  private drawProgress(progress: Progress, kick: number) {
    const c = this.ctx;
    if (!progress) return;
    const frac = Math.min(1, progress.time / progress.duration);

    c.fillStyle = "rgba(255,255,255,0.12)";
    c.beginPath();
    c.roundRect(BAR_X, BAR_Y - 5, BAR_W, 10, 5);
    c.fill();

    if (frac > 0.003) {
      const grad = c.createLinearGradient(BAR_X, 0, BAR_X + BAR_W, 0);
      grad.addColorStop(0, "#25f4ee");
      grad.addColorStop(1, "#fe2c55");
      c.fillStyle = grad;
      c.beginPath();
      c.roundRect(BAR_X, BAR_Y - 5, Math.max(10, BAR_W * frac), 10, 5);
      c.fill();
    }

    const knobX = BAR_X + BAR_W * frac;
    c.beginPath();
    c.arc(knobX, BAR_Y, 9 + kick * 3, 0, Math.PI * 2);
    c.fillStyle = "#ffffff";
    c.shadowColor = "rgba(37,244,238,0.9)";
    c.shadowBlur = 10;
    c.fill();
    c.shadowBlur = 0;

    c.font = "600 26px system-ui, sans-serif";
    c.textBaseline = "middle";
    c.fillStyle = "rgba(223,230,255,0.85)";
    c.textAlign = "right";
    c.fillText(formatTime(progress.time), BAR_X - 18, BAR_Y + 1);
    c.textAlign = "left";
    c.fillText(formatTime(progress.duration), BAR_X + BAR_W + 18, BAR_Y + 1);
  }

  update(dt: number, spectrum: Uint8Array<ArrayBuffer> | null, beat: Beat, progress: Progress = null) {
    this.acc += dt;
    if (this.acc < 0.08) return;
    this.acc = 0;
    this.draw(spectrum, beat, progress);
  }

  private drawFrame(kick: number) {
    const c = this.ctx;
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0b0d1c");
    bg.addColorStop(0.55, "#05060d");
    bg.addColorStop(1, "#0a0716");
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);
    c.strokeStyle = "#2a3054";
    c.lineWidth = 6;
    c.strokeRect(3, 3, W - 6, H - 6);
    c.strokeStyle = `rgba(37,244,238,${0.3 + kick * 0.4})`;
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
        v = 0.05;
      }
      const h = Math.max(4, v * 66);
      const hue = (188 + i * 4.6) % 360;
      const x = 40 + i * barW;
      const grad = c.createLinearGradient(0, H - 14 - h, 0, H - 14);
      grad.addColorStop(0, `hsl(${hue} 95% ${58 + v * 25}%)`);
      grad.addColorStop(1, `hsl(${hue} 80% 30%)`);
      c.fillStyle = grad;
      c.beginPath();
      c.roundRect(x, H - 14 - h, barW * 0.68, h, 3);
      c.fill();
    }
  }

  private draw(spectrum: Uint8Array<ArrayBuffer> | null, beat: Beat, progress: Progress) {
    const c = this.ctx;
    const kick = this.paused ? 0 : Math.max(0, 1 - beat.pulse * 3);
    this.drawFrame(kick);

    if (!this.title) {
      const t = performance.now() / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(t * 1.8);
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.font = "700 72px system-ui, sans-serif";
      c.shadowColor = "rgba(37,244,238,0.8)";
      c.shadowBlur = 14 + pulse * 20;
      c.fillStyle = `rgba(143,151,196,${0.5 + pulse * 0.4})`;
      c.fillText("♪", W / 2, 62);
      c.shadowBlur = 0;
      c.font = "600 30px system-ui, sans-serif";
      c.fillStyle = "rgba(223,230,255,0.55)";
      c.fillText("Chưa có nhạc — nhấn S → Nhạc (playlist) để thêm bài", W / 2, 236);
      this.drawControls();
      this.drawEq(null, 0);
      this.texture.needsUpdate = true;
      return;
    }

    let label = `♪ ${this.title}`;
    c.font = "700 54px system-ui, sans-serif";
    while (c.measureText(label).width > W - 90 && label.length > 6) {
      label = `${label.slice(0, -2)}…`;
    }
    const hue = (347 + beat.index * 7) % 360;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.shadowColor = `hsl(${hue} 95% 60%)`;
    c.shadowBlur = 12 + kick * 20;
    c.fillStyle = `hsl(${hue} 95% ${64 + kick * 16}%)`;
    c.fillText(label, W / 2, this.orderedBy ? 52 : 62);
    c.shadowBlur = 0;

    if (this.orderedBy) {
      let by = `🎧 Order bởi ${this.orderedBy}`;
      c.font = "600 27px system-ui, sans-serif";
      while (c.measureText(by).width > W - 120 && by.length > 6) {
        by = `${by.slice(0, -2)}…`;
      }
      c.fillStyle = "rgba(37,244,238,0.9)";
      c.fillText(by, W / 2, 100);
    }

    this.drawControls();
    this.drawProgress(progress, kick);
    this.drawEq(spectrum, kick);
    this.texture.needsUpdate = true;
  }
}
