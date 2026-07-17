import * as THREE from "three";

export type InfoTrack = { title: string; thumb?: string };

/**
 * Hai màn hình LED ở khu FOH sau khán đài:
 * - Trái: "đang phát" — ảnh bìa + tên bài + thanh tiến độ (thay cho iframe,
 *   vì WebGL không nhúng được iframe và tránh phát chồng tiếng).
 * - Phải: playlist — danh sách bài, bài đang phát sáng lên.
 * Nội dung vẽ bằng CanvasTexture, cập nhật khi dữ liệu đổi + tiến độ ~2fps.
 */
export class InfoScreens {
  readonly group = new THREE.Group();

  private nowCanvas = document.createElement("canvas");
  private nowCtx: CanvasRenderingContext2D;
  private nowTex: THREE.CanvasTexture;

  private listCanvas = document.createElement("canvas");
  private listCtx: CanvasRenderingContext2D;
  private listTex: THREE.CanvasTexture;

  private nowTitle = "";
  private thumbUrl: string | null = null;
  private thumbImg: HTMLImageElement | null = null;
  private time = 0;
  private duration = 0;
  private redrawAcc = 0;

  private items: InfoTrack[] = [];
  private current = -1;

  constructor(centerZ: number) {
    this.nowCanvas.width = 640;
    this.nowCanvas.height = 384;
    this.nowCtx = this.nowCanvas.getContext("2d")!;
    this.nowTex = new THREE.CanvasTexture(this.nowCanvas);
    this.nowTex.colorSpace = THREE.SRGBColorSpace;

    this.listCanvas.width = 384;
    this.listCanvas.height = 448;
    this.listCtx = this.listCanvas.getContext("2d")!;
    this.listTex = new THREE.CanvasTexture(this.listCanvas);
    this.listTex.colorSpace = THREE.SRGBColorSpace;

    const bezelMat = new THREE.MeshStandardMaterial({
      color: 0x0a0d16,
      metalness: 0.6,
      roughness: 0.5,
      emissive: 0x0a0d16,
      emissiveIntensity: 0.4,
    });

    // Hai màn hình trên bàn FOH: trái ngang "đang phát", phải dọc "playlist".
    // Hai mặt (DoubleSide) để đọc được từ cả phía sau lẫn các góc chếch.
    const left = this.makePanel(3.0, 1.8, this.nowTex, bezelMat);
    left.position.set(-2.0, 2.7, centerZ);
    left.rotation.x = -0.22;
    const right = this.makePanel(1.9, 2.24, this.listTex, bezelMat);
    right.position.set(1.9, 2.85, centerZ);
    right.rotation.x = -0.22;
    this.group.add(left, right);

    this.drawNow();
    this.drawList();
  }

  private makePanel(
    w: number,
    h: number,
    tex: THREE.Texture,
    bezelMat: THREE.Material,
  ): THREE.Group {
    const g = new THREE.Group();
    const bezel = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.14, h + 0.14, 0.08),
      bezelMat,
    );
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
    );
    screen.position.z = 0.05;
    g.add(bezel, screen);
    return g;
  }

  setNowPlaying(title: string, thumb?: string) {
    this.nowTitle = title || "";
    const t = thumb ?? null;
    if (t !== this.thumbUrl) {
      this.thumbUrl = t;
      this.thumbImg = null;
      if (t) {
        const img = new Image();
        // Cần CORS để không "làm bẩn" canvas (WebGL sẽ từ chối texture bẩn)
        img.crossOrigin = "anonymous";
        img.onload = () => {
          if (this.thumbUrl === t) {
            this.thumbImg = img;
            this.drawNow();
          }
        };
        img.onerror = () => {};
        img.src = t;
      }
    }
    this.drawNow();
  }

  setPlaylist(items: InfoTrack[], current: number) {
    this.items = items;
    this.current = current;
    this.drawList();
  }

  /** Gọi mỗi frame — cập nhật thanh tiến độ, tự giới hạn ~2fps cho nhẹ. */
  update(dt: number, progress: { time: number; duration: number } | null) {
    this.time = progress?.time ?? 0;
    this.duration = progress?.duration ?? 0;
    this.redrawAcc += dt;
    if (this.redrawAcc >= 0.5) {
      this.redrawAcc = 0;
      this.drawNow();
    }
  }

  private drawNow() {
    const c = this.nowCtx;
    const W = this.nowCanvas.width;
    const H = this.nowCanvas.height;
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#0b1020");
    g.addColorStop(1, "#05070f");
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);

    // Ảnh bìa bên trái (khung 16:9)
    const thumbW = 300;
    const thumbH = 169;
    const tx = 28;
    const ty = 40;
    c.fillStyle = "#11172a";
    c.fillRect(tx, ty, thumbW, thumbH);
    if (this.thumbImg) {
      const ir = this.thumbImg.width / this.thumbImg.height;
      const fr = thumbW / thumbH;
      let dw = thumbW;
      let dh = thumbH;
      let ox = 0;
      let oy = 0;
      if (ir > fr) {
        dh = thumbH;
        dw = dh * ir;
        ox = (thumbW - dw) / 2;
      } else {
        dw = thumbW;
        dh = dw / ir;
        oy = (thumbH - dh) / 2;
      }
      c.save();
      c.beginPath();
      c.rect(tx, ty, thumbW, thumbH);
      c.clip();
      c.drawImage(this.thumbImg, tx + ox, ty + oy, dw, dh);
      c.restore();
    } else {
      c.fillStyle = "#25f4ee";
      c.font = "600 64px system-ui, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("♪", tx + thumbW / 2, ty + thumbH / 2);
    }

    // Nhãn "ĐANG PHÁT"
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.fillStyle = "#fe2c55";
    c.font = "700 26px system-ui, sans-serif";
    c.fillText("● ĐANG PHÁT", 352, 66);

    // Tên bài (bọc 2 dòng)
    c.fillStyle = "#ffffff";
    c.font = "700 34px system-ui, sans-serif";
    this.wrapText(c, this.nowTitle || "—", 352, 112, 258, 40, 2);

    // Thanh tiến độ
    const barX = 28;
    const barY = 280;
    const barW = W - 56;
    c.fillStyle = "rgba(255,255,255,0.15)";
    c.fillRect(barX, barY, barW, 10);
    const frac =
      this.duration > 0 ? Math.min(1, this.time / this.duration) : 0;
    c.fillStyle = "#25f4ee";
    c.fillRect(barX, barY, barW * frac, 10);
    c.fillStyle = "rgba(255,255,255,0.6)";
    c.font = "500 22px system-ui, sans-serif";
    c.fillText(this.fmt(this.time), barX, barY + 42);
    c.textAlign = "right";
    c.fillText(this.fmt(this.duration), barX + barW, barY + 42);
    c.textAlign = "left";

    this.nowTex.needsUpdate = true;
  }

  private drawList() {
    const c = this.listCtx;
    const W = this.listCanvas.width;
    const H = this.listCanvas.height;
    c.fillStyle = "#070a14";
    c.fillRect(0, 0, W, H);
    c.fillStyle = "#ffc94d";
    c.font = "700 26px system-ui, sans-serif";
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.fillText("🎵 PLAYLIST", 20, 40);
    c.strokeStyle = "rgba(255,255,255,0.12)";
    c.beginPath();
    c.moveTo(20, 54);
    c.lineTo(W - 20, 54);
    c.stroke();

    const rowH = 46;
    const top = 78;
    const maxRows = Math.floor((H - top) / rowH);
    // Cuộn để bài đang phát luôn trong khung
    let start = 0;
    if (this.current >= 0 && this.items.length > maxRows) {
      start = Math.min(
        Math.max(0, this.current - Math.floor(maxRows / 2)),
        this.items.length - maxRows,
      );
    }
    for (let i = 0; i < maxRows && start + i < this.items.length; i++) {
      const idx = start + i;
      const item = this.items[idx];
      const y = top + i * rowH;
      const on = idx === this.current;
      if (on) {
        c.fillStyle = "rgba(37,244,238,0.16)";
        c.fillRect(12, y - 26, W - 24, rowH - 8);
      }
      c.fillStyle = on ? "#25f4ee" : "rgba(255,255,255,0.55)";
      c.font = `${on ? "700" : "500"} 22px system-ui, sans-serif`;
      const label = `${on ? "▶" : idx + 1 + "."} ${item.title}`;
      c.fillText(this.ellipsis(c, label, W - 40), 20, y);
    }
    if (!this.items.length) {
      c.fillStyle = "rgba(255,255,255,0.35)";
      c.font = "500 22px system-ui, sans-serif";
      c.fillText("Chưa có bài nào", 20, top + 10);
    }
    this.listTex.needsUpdate = true;
  }

  private wrapText(
    c: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxW: number,
    lineH: number,
    maxLines: number,
  ) {
    const words = text.split(" ");
    let line = "";
    let lines = 0;
    for (let i = 0; i < words.length; i++) {
      const test = line ? `${line} ${words[i]}` : words[i];
      if (c.measureText(test).width > maxW && line) {
        c.fillText(line, x, y + lines * lineH);
        line = words[i];
        lines++;
        if (lines >= maxLines - 1) {
          // Dòng cuối: cắt "…" nếu còn dư
          let rest = words.slice(i).join(" ");
          rest = this.ellipsis(c, rest, maxW);
          c.fillText(rest, x, y + lines * lineH);
          return;
        }
      } else {
        line = test;
      }
    }
    c.fillText(line, x, y + lines * lineH);
  }

  private ellipsis(
    c: CanvasRenderingContext2D,
    text: string,
    maxW: number,
  ): string {
    if (c.measureText(text).width <= maxW) return text;
    let s = text;
    while (s.length > 1 && c.measureText(`${s}…`).width > maxW) {
      s = s.slice(0, -1);
    }
    return `${s}…`;
  }

  private fmt(sec: number): string {
    if (!Number.isFinite(sec) || sec <= 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
}
