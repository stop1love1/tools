import type { Beat } from "./player";

export class MusicPlayer {
  private audio: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;

  title = "";
  level = 0;
  sensitivity = 1.35;
  onEndedCb: (() => void) | null = null;

  private loBin = 1;
  private hiBin = 8;

  private beatIndex = 0;
  private lastOnset = 0;
  private lastRealOnset = 0;
  private interval = 60 / 128;
  private history: number[] = [];

  get playing(): boolean {
    return !!this.audio && !this.audio.paused && !this.audio.ended;
  }

  /** Tiến độ bài hiện tại (giây) — null khi chưa có bài/chưa biết độ dài. */
  get progress(): { time: number; duration: number } | null {
    if (!this.audio) return null;
    const duration = this.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return { time: this.audio.currentTime, duration };
  }

  /** Tua tới mốc giây tuyệt đối (khôi phục vị trí nghe dở sau khi reload). */
  seekTo(seconds: number) {
    if (!this.audio) return;
    this.audio.currentTime = Math.max(0, seconds);
  }

  /** Tua tới vị trí 0..1 của bài (bấm vào thanh tiến độ trên màn hình DJ). */
  seek(frac: number) {
    if (!this.audio) return;
    const duration = this.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    this.audio.currentTime = Math.min(
      duration - 0.05,
      Math.max(0, frac * duration),
    );
  }

  async play(url: string, title: string) {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.loop = false;
      this.audio.crossOrigin = "anonymous";
      this.ctx = new AudioContext();
      const source = this.ctx.createMediaElementSource(this.audio);
      this.analyser = this.ctx.createAnalyser();
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

  async restart() {
    if (!this.audio) return;
    this.audio.currentTime = 0;
    await this.resume();
  }

  getSpectrum(): Uint8Array<ArrayBuffer> | null {
    if (!this.analyser || !this.freq || !this.playing) return null;
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  }

  update() {
    if (!this.playing || !this.analyser || !this.freq) {
      this.level = Math.max(0, this.level - 0.02);
      return;
    }
    this.analyser.getByteFrequencyData(this.freq);
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

    while (now - this.lastOnset > this.interval) {
      this.lastOnset += this.interval;
      this.beatIndex++;
    }

    const gap = now - this.lastRealOnset;
    if (bass > avg * this.sensitivity && bass > 0.02 && gap > 0.25) {
      if (gap > 0.33 && gap < 0.86) {
        this.interval = this.interval * 0.6 + gap * 0.4;
      } else if (gap / 2 > 0.33 && gap / 2 < 0.86) {
        this.interval = this.interval * 0.7 + (gap / 2) * 0.3;
      }
      this.lastRealOnset = now;
      const phase = (now - this.lastOnset) / this.interval;
      if (phase >= 0.6) {
        this.lastOnset = now;
        this.beatIndex++;
      } else {
        this.lastOnset += (now - this.lastOnset) * 0.35;
      }
    }
  }

  getBeat(): Beat {
    const now = performance.now() / 1000;
    const pulse = Math.min(0.999, (now - this.lastOnset) / this.interval);
    return { index: this.beatIndex, pulse };
  }
}
