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

  /** Mức năng lượng dải trung (giọng hát/synth) và cao (hi-hat) 0..1. */
  mid = 0;
  high = 0;
  /** Cường độ "drop" (1 → tắt dần): nhạc lặng >1s rồi bass bùng nổ. */
  dropLevel = 0;

  private midLo = 8;
  private midHi = 60;
  private highLo = 120;
  private highHi = 400;
  private prevBass: Float32Array | null = null;
  private fluxAvg = 0;
  private energyAvg = 0;
  private quietTime = 0;
  private lastUpdateT = 0;

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
      this.midLo = Math.max(this.hiBin + 1, Math.floor(250 / hzPerBin));
      this.midHi = Math.ceil(2000 / hzPerBin);
      this.highLo = Math.floor(4000 / hzPerBin);
      this.highHi = Math.min(
        this.freq.length - 1,
        Math.ceil(11000 / hzPerBin),
      );
    }
    this.title = title;
    this.audio.src = url;
    this.audio.onended = () => this.onEndedCb?.();
    // play() trước: nếu trình duyệt chặn autoplay sẽ ném NotAllowedError ngay
    // (ctx.resume() khi bị chặn thì treo vô hạn — không được await trước)
    await this.audio.play();
    void this.ctx!.resume();
    this.history = [];
    this.beatIndex = 0;
    this.lastOnset = performance.now() / 1000;
    this.prevBass = null;
    this.fluxAvg = 0;
    this.energyAvg = 0;
    this.quietTime = 0;
    this.dropLevel = 0;
  }

  pause() {
    this.audio?.pause();
  }

  async resume() {
    await this.audio?.play();
    void this.ctx?.resume();
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
    const nowT = performance.now() / 1000;
    const dtu = Math.min(0.1, Math.max(0.001, nowT - this.lastUpdateT));
    this.lastUpdateT = nowT;
    this.dropLevel = Math.max(0, this.dropLevel - dtu * 0.55);
    if (!this.playing || !this.analyser || !this.freq) {
      this.level = Math.max(0, this.level - 0.02);
      this.mid = Math.max(0, this.mid - 0.02);
      this.high = Math.max(0, this.high - 0.02);
      return;
    }
    this.analyser.getByteFrequencyData(this.freq);
    let sum = 0;
    let flux = 0;
    const nBass = this.hiBin - this.loBin + 1;
    if (!this.prevBass || this.prevBass.length !== nBass) {
      this.prevBass = new Float32Array(nBass);
    }
    for (let i = this.loBin; i <= this.hiBin; i++) {
      sum += this.freq[i] * this.freq[i];
      const k = i - this.loBin;
      flux += Math.max(0, this.freq[i] - this.prevBass[k]);
      this.prevBass[k] = this.freq[i];
    }
    const bass = sum / (nBass * 255 * 255);
    flux /= nBass * 255;
    this.fluxAvg += (flux - this.fluxAvg) * 0.06;
    this.level += (bass - this.level) * 0.25;

    let midSum = 0;
    for (let i = this.midLo; i <= this.midHi; i++) midSum += this.freq[i];
    this.mid +=
      (midSum / ((this.midHi - this.midLo + 1) * 255) - this.mid) * 0.3;
    let highSum = 0;
    for (let i = this.highLo; i <= this.highHi; i++) highSum += this.freq[i];
    this.high +=
      (highSum / ((this.highHi - this.highLo + 1) * 255) - this.high) * 0.35;

    // Drop: bass chìm dưới mức nền >1s (break/buildup) rồi bùng vượt hẳn nền
    this.energyAvg += (bass - this.energyAvg) * 0.012;
    if (bass < Math.max(0.015, this.energyAvg * 0.8)) {
      this.quietTime += dtu;
    } else {
      if (this.quietTime > 1.0 && bass > this.energyAvg * 1.6 && bass > 0.06) {
        this.dropLevel = 1;
      }
      this.quietTime = 0;
    }

    this.history.push(bass);
    if (this.history.length > 43) this.history.shift();
    const avg =
      this.history.reduce((a, b) => a + b, 0) / (this.history.length || 1);

    const now = nowT;

    while (now - this.lastOnset > this.interval) {
      this.lastOnset += this.interval;
      this.beatIndex++;
    }

    const gap = now - this.lastRealOnset;
    // Onset cần năng lượng vượt nền VÀ phổ biến thiên đột ngột (flux) —
    // tránh bass ngân dài bị đếm nhầm thành beat mới
    const energyHit = bass > avg * this.sensitivity && bass > 0.02;
    const fluxHit =
      flux > this.fluxAvg * 1.1 || bass > avg * this.sensitivity * 1.4;
    if (energyHit && fluxHit && gap > 0.25) {
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
