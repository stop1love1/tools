import type { Beat } from "./player";

/**
 * Phát nhạc + bắt nhịp thật bằng Web Audio:
 * - đo năng lượng dải bass mỗi frame
 * - vượt ngưỡng trung bình trượt → tính là 1 phách (onset)
 * - khoảng cách giữa các phách cho ra BPM; pha (pulse) = thời gian từ phách cuối
 * Khi không có nhạc, game rơi về nhịp auto 128 BPM.
 */
export class MusicPlayer {
  private audio: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;

  title = "";
  /** Năng lượng bass 0..1 đã làm mượt — dùng cho hiệu ứng. */
  level = 0;
  /** Độ nhạy beat: năng lượng phải > trung bình × sensitivity (admin chỉnh). */
  sensitivity = 1.35;
  /** Gọi khi bài hát kết thúc (để HUD chuyển bài). */
  onEndedCb: (() => void) | null = null;

  private loBin = 1;
  private hiBin = 8;

  private beatIndex = 0;
  private lastOnset = 0;
  private lastRealOnset = 0;
  private interval = 60 / 128; // giây / phách, cập nhật theo nhạc thật
  private history: number[] = [];

  get playing(): boolean {
    return !!this.audio && !this.audio.paused && !this.audio.ended;
  }

  /** Gọi từ sự kiện bấm nút (trình duyệt yêu cầu user gesture để phát audio). */
  async play(url: string, title: string) {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.loop = false;
      this.audio.crossOrigin = "anonymous";
      this.ctx = new AudioContext();
      const source = this.ctx.createMediaElementSource(this.audio);
      this.analyser = this.ctx.createAnalyser();
      // fftSize lớn để chia bin mịn, bắt đúng dải kick drum 20–150Hz
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;
      source.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      const hzPerBin = this.ctx.sampleRate / this.analyser.fftSize;
      this.loBin = Math.max(1, Math.floor(20 / hzPerBin));
      this.hiBin = Math.ceil(150 / hzPerBin);
    }
    this.title = title;
    this.audio.src = url;
    this.audio.onended = () => this.onEndedCb?.();
    await this.ctx!.resume();
    await this.audio.play();
    this.history = [];
    this.beatIndex = 0;
    this.lastOnset = performance.now() / 1000;
  }

  pause() {
    this.audio?.pause();
  }

  async resume() {
    await this.ctx?.resume();
    await this.audio?.play();
  }

  async toggle() {
    if (this.playing) this.pause();
    else await this.resume();
  }

  /** Phát lại bài hiện tại từ đầu. */
  async restart() {
    if (!this.audio) return;
    this.audio.currentTime = 0;
    await this.resume();
  }

  /** Phổ tần hiện tại (cho màn hình EQ). Null khi chưa phát. */
  getSpectrum(): Uint8Array<ArrayBuffer> | null {
    if (!this.analyser || !this.freq || !this.playing) return null;
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  }

  /** Gọi mỗi frame để dò phách. */
  update() {
    if (!this.playing || !this.analyser || !this.freq) {
      this.level = Math.max(0, this.level - 0.02);
      return;
    }
    this.analyser.getByteFrequencyData(this.freq);
    // Năng lượng bình phương dải bass 20–150Hz (kick drum) — theo chuẩn
    // moving-average beat detection của Web Audio
    let sum = 0;
    for (let i = this.loBin; i <= this.hiBin; i++) {
      sum += this.freq[i] * this.freq[i];
    }
    const bass = sum / ((this.hiBin - this.loBin + 1) * 255 * 255);
    this.level += (bass - this.level) * 0.25;

    this.history.push(bass);
    if (this.history.length > 43) this.history.shift();
    const avg =
      this.history.reduce((a, b) => a + b, 0) / (this.history.length || 1);

    const now = performance.now() / 1000;

    // Free-wheel: giữa 2 phách thật vẫn tự đếm phách theo BPM ước lượng,
    // để sàn nhảy đều kể cả khi bắt trượt vài phách
    while (now - this.lastOnset > this.interval) {
      this.lastOnset += this.interval;
      this.beatIndex++;
    }

    // Onset thật: năng lượng vượt trung bình × sensitivity + sàn chống nhiễu
    const gap = now - this.lastRealOnset;
    if (bass > avg * this.sensitivity && bass > 0.02 && gap > 0.25) {
      if (gap > 0.33 && gap < 0.86) {
        // 70–180 BPM
        this.interval = this.interval * 0.6 + gap * 0.4;
      } else if (gap / 2 > 0.33 && gap / 2 < 0.86) {
        // lỡ đúng 1 phách ở giữa
        this.interval = this.interval * 0.7 + (gap / 2) * 0.3;
      }
      this.lastRealOnset = now;
      // Đồng bộ pha MỀM: onset rơi gần cuối phách free-wheel → coi là phách
      // mới; rơi giữa chừng → chỉ nắn pha dần, tránh cú giật reset giữa nhịp
      const phase = (now - this.lastOnset) / this.interval;
      if (phase >= 0.6) {
        this.lastOnset = now;
        this.beatIndex++;
      } else {
        this.lastOnset += (now - this.lastOnset) * 0.35;
      }
    }
  }

  /** Nhịp hiện tại của bài nhạc. */
  getBeat(): Beat {
    const now = performance.now() / 1000;
    const pulse = Math.min(0.999, (now - this.lastOnset) / this.interval);
    return { index: this.beatIndex, pulse };
  }
}
