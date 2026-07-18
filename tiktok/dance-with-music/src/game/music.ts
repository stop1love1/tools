import type { Beat, MusicGenre } from "./player";

// Krumhansl key profiles — trọng số cảm nhận 12 bậc trong giọng trưởng/thứ,
// dùng so khớp chromagram để đoán bài đang ở giọng trưởng (vui) hay thứ (buồn)
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

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
  /**
   * Tâm trạng bài hát, làm mượt rất chậm để không giật giữa các câu nhạc:
   * - moodEnergy 0..1: êm dịu → dữ dội (tổng năng lượng phổ).
   * - moodValence 0..1: buồn → vui (phổ "sáng" nhiều treble + tempo nhanh).
   */
  moodEnergy = 0;
  moodValence = 0.4;
  /**
   * Cường độ đoạn nhạc SO VỚI chính bài đó (z-score loudness): 0 = đoạn
   * trầm/break, ~0.5 = bình thường, 1 = điệp khúc/drop. Không phụ thuộc bài
   * mix to hay nhỏ nên dùng làm cò kích pyro/đèn chuẩn hơn ngưỡng tuyệt đối.
   */
  section = 0.5;
  private emaFast = 0;
  private emaSlow = 0;
  private emaVar = 0.001;
  private centroidAvg = 0.3;
  /**
   * Giai điệu (nốt thăng/trầm) dò từ cao độ trội dải 250–2000Hz:
   * - melodyTrend -1..1: >0 nốt đang đi LÊN (thăng), <0 đi XUỐNG (trầm).
   * - melodyHeight 0..1: cao độ hiện tại so với dải của chính bài.
   */
  melodyTrend = 0;
  melodyHeight = 0.5;
  /** Thể loại ước lượng từ tempo + cân bằng phổ + mật độ onset. */
  genre: MusicGenre = "pop";
  /**
   * Lệch lưới beat → phách 1 THẬT của ô nhịp (downbeat), dò bằng cộng dồn
   * trọng âm theo 4 pha. Game trừ offset này để mọi accent %4/%8 khớp nhịp.
   */
  barOffset = 0;
  /** Tin cậy beat 0..1 — onset khớp lưới đều đặn thì cao; thấp → bớt pyro. */
  beatConfidence = 0.5;
  private phaseEnergy = [0, 0, 0, 0];
  private chromaMap: Int32Array | null = null;
  private chroma = new Float32Array(12);
  /** 0 = giọng thứ (buồn) → 1 = giọng trưởng (tươi sáng). */
  private modeMajor = 0.5;
  private hzPerBin = 21.5;
  private melodyFast = 0;
  private melodySlow = 0;
  private melodyLo = Number.POSITIVE_INFINITY;
  private melodyHi = Number.NEGATIVE_INFINITY;
  private onsetRate = 0;
  private genreScores: Record<MusicGenre, number> = {
    ballad: 0,
    pop: 0.4,
    hiphop: 0,
    rock: 0,
    edm: 0,
  };

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

  /** Đang ở đoạn trầm (bass chìm dưới nền >0.5s) — thường là break/buildup. */
  get inQuietSection(): boolean {
    return this.playing && this.quietTime > 0.5;
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
      // Mượt THẤP để bắt transient kick tức thì (0.6 cũ làm onset trễ ~50ms →
      // hiệu ứng nhấp sau tiếng nghe). Level/bass đã có EMA riêng phía dưới nên
      // đèn không bị nhấp nháy loạn dù dữ liệu phổ thô hơn.
      this.analyser.smoothingTimeConstant = 0.2;
      source.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      const hzPerBin = this.ctx.sampleRate / this.analyser.fftSize;
      this.hzPerBin = hzPerBin;
      // Bảng bin FFT → lớp cao độ (chroma) cho dải 80Hz–2kHz, dựng một lần
      this.chromaMap = new Int32Array(this.freq.length).fill(-1);
      const cLo = Math.max(1, Math.floor(80 / hzPerBin));
      const cHi = Math.min(this.freq.length - 1, Math.ceil(2000 / hzPerBin));
      for (let i = cLo; i <= cHi; i++) {
        const midi = Math.round(69 + 12 * Math.log2((i * hzPerBin) / 440));
        this.chromaMap[i] = ((midi % 12) + 12) % 12;
      }
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
    this.section = 0.5;
    this.emaFast = 0;
    this.emaSlow = 0;
    this.emaVar = 0.001;
    this.centroidAvg = 0.3;
    this.melodyFast = 0;
    this.melodySlow = 0;
    this.melodyLo = Number.POSITIVE_INFINITY;
    this.melodyHi = Number.NEGATIVE_INFINITY;
    this.melodyTrend = 0;
    this.melodyHeight = 0.5;
    this.onsetRate = 0;
    this.barOffset = 0;
    this.beatConfidence = 0.5;
    this.phaseEnergy = [0, 0, 0, 0];
    this.chroma.fill(0);
    this.modeMajor = 0.5;
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
      this.moodEnergy = Math.max(0, this.moodEnergy - dtu * 0.15);
      this.moodValence += (0.4 - this.moodValence) * Math.min(1, dtu * 0.2);
      this.section += (0.5 - this.section) * Math.min(1, dtu * 0.3);
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

    // === Detect thích ứng theo chính bài đang phát ===
    // Loudness tổng hợp có trọng số (bass nặng nhất, như tai người cảm nhận)
    const inst = this.level * 0.5 + this.mid * 0.35 + this.high * 0.15;
    // EMA nhanh/chậm + phương sai → z-score: đoạn hiện tại to/nhỏ bất thường
    // cỡ nào so với mức trung bình của CHÍNH bài này (bất kể mix to hay nhỏ)
    this.emaFast += (inst - this.emaFast) * Math.min(1, dtu * 3);
    this.emaSlow += (inst - this.emaSlow) * Math.min(1, dtu * 0.12);
    const dev = inst - this.emaSlow;
    this.emaVar += (dev * dev - this.emaVar) * Math.min(1, dtu * 0.12);
    const z =
      (this.emaFast - this.emaSlow) / Math.max(0.012, Math.sqrt(this.emaVar));
    const sectionTarget = Math.min(1, Math.max(0, 0.5 + z * 0.3));
    // Vào cao trào bắt nhanh, thoát thì lơi chậm — như lighting operator thật
    this.section +=
      (sectionTarget - this.section) *
      Math.min(1, dtu * (sectionTarget > this.section ? 2.5 : 0.8));

    // Spectral centroid — "trọng tâm" phổ: cao = tươi sáng, thấp = trầm tối
    let wSum = 0;
    let mSum = 0;
    for (let i = this.loBin; i <= this.highHi; i++) {
      wSum += i * this.freq[i];
      mSum += this.freq[i];
    }
    const centroid = mSum > 1 ? wSum / mSum / (this.midHi * 2) : 0.3;
    this.centroidAvg += (centroid - this.centroidAvg) * Math.min(1, dtu * 0.5);

    // === Chromagram → giọng trưởng/thứ: tín hiệu buồn/vui THẬT của hòa âm
    // (thay vì chỉ đoán qua độ "sáng" phổ) ===
    if (this.chromaMap) {
      const fc = new Array(12).fill(0);
      for (let i = 0; i < this.chromaMap.length; i++) {
        const c = this.chromaMap[i];
        if (c >= 0) fc[c] += this.freq[i];
      }
      let fsum = 0;
      for (let c = 0; c < 12; c++) fsum += fc[c];
      if (fsum > 50) {
        for (let c = 0; c < 12; c++) {
          this.chroma[c] +=
            (fc[c] / fsum - this.chroma[c]) * Math.min(1, dtu * 0.5);
        }
        // So khớp với 12 giọng trưởng + 12 giọng thứ, lấy giọng khớp nhất
        let bestMaj = 0;
        let bestMin = 0;
        for (let root = 0; root < 12; root++) {
          let sMaj = 0;
          let sMin = 0;
          for (let c = 0; c < 12; c++) {
            const v = this.chroma[(root + c) % 12];
            sMaj += v * MAJOR_PROFILE[c];
            sMin += v * MINOR_PROFILE[c];
          }
          if (sMaj > bestMaj) bestMaj = sMaj;
          if (sMin > bestMin) bestMin = sMin;
        }
        const modeInst =
          bestMaj + bestMin > 0 ? bestMaj / (bestMaj + bestMin) : 0.5;
        // Chênh lệch quanh 0.5 rất nhỏ — khuếch đại rồi làm mượt chậm ~4s
        const amplified = Math.min(
          1,
          Math.max(0, 0.5 + (modeInst - 0.5) * 6),
        );
        this.modeMajor += (amplified - this.modeMajor) * Math.min(1, dtu * 0.25);
      }
    }

    const bpm = 60 / this.interval;
    const tempoNorm = Math.min(1, Math.max(0, (bpm - 85) / 70));
    // Energy = độ lớn tuyệt đối × vị thế đoạn trong bài — verse dịu, drop bùng
    const absLoud = Math.min(1, inst * 2.2);
    const energyInst = Math.min(1, absLoud * (0.4 + this.section * 0.8));
    // Valence: trưởng/thứ là tín hiệu chính, phổ sáng + tempo phụ trợ
    const valenceInst = Math.min(
      1,
      this.modeMajor * 0.45 +
        Math.max(0, (this.centroidAvg - 0.16) * 2.4) * 0.3 +
        tempoNorm * 0.25,
    );
    this.moodEnergy += (energyInst - this.moodEnergy) * Math.min(1, dtu * 0.7);
    this.moodValence +=
      (valenceInst - this.moodValence) * Math.min(1, dtu * 0.35);
    // Lâu không bắt được onset nào (đoạn ambient/nhiễu) → giảm tin cậy beat
    if (nowT - this.lastRealOnset > 2.5) {
      this.beatConfidence = Math.max(0.25, this.beatConfidence - dtu * 0.12);
    }

    // === Giai điệu: dò cao độ trội dải giọng hát/lead → nốt thăng/trầm ===
    let peakI = this.midLo;
    let peakV = 0;
    for (let i = this.midLo; i <= this.midHi; i++) {
      if (this.freq[i] > peakV) {
        peakV = this.freq[i];
        peakI = i;
      }
    }
    if (peakV > 45) {
      const semi = 12 * Math.log2((peakI * this.hzPerBin) / 440) + 69;
      if (this.melodySlow === 0) this.melodyFast = this.melodySlow = semi;
      // EMA nhanh vs chậm: hiệu của chúng = hướng giai điệu đang đi
      this.melodyFast += (semi - this.melodyFast) * Math.min(1, dtu * 8);
      this.melodySlow += (semi - this.melodySlow) * Math.min(1, dtu * 1.2);
      const trend = Math.max(
        -1,
        Math.min(1, (this.melodyFast - this.melodySlow) / 5),
      );
      this.melodyTrend += (trend - this.melodyTrend) * Math.min(1, dtu * 4);
      this.melodyLo = Math.min(this.melodyLo, this.melodyFast);
      this.melodyHi = Math.max(this.melodyHi, this.melodyFast);
      // Dải co lại từ từ để thích ứng khi bài chuyển tông
      this.melodyLo += (this.melodyFast - this.melodyLo) * Math.min(1, dtu * 0.02);
      this.melodyHi += (this.melodyFast - this.melodyHi) * Math.min(1, dtu * 0.02);
      const range = Math.max(3, this.melodyHi - this.melodyLo);
      const h = (this.melodyFast - this.melodyLo) / range;
      this.melodyHeight += (h - this.melodyHeight) * Math.min(1, dtu * 3);
    } else {
      this.melodyTrend *= Math.max(0, 1 - dtu * 2);
    }

    // === Ước lượng thể loại: tempo + cân bằng bass/mid/treble + độ dày onset.
    // Điểm số làm mượt ~4s rồi lấy max — không nhảy thể loại giữa câu nhạc ===
    this.onsetRate *= Math.max(0, 1 - dtu * 0.6);
    const bassN = Math.min(1, this.level * 2.2);
    const midN = Math.min(1, this.mid * 2.5);
    const highN = Math.min(1, this.high * 3);
    const perc = Math.min(1, this.onsetRate / 1.5);
    const target: Record<MusicGenre, number> = {
      ballad: (1 - tempoNorm) * (1 - absLoud) * (1 - perc * 0.6),
      pop: 0.28 + midN * 0.3 + tempoNorm * 0.12,
      hiphop:
        bassN * (1 - tempoNorm * 0.8) * (0.35 + perc * 0.65) * (1 - highN * 0.4),
      rock: midN * (0.35 + tempoNorm * 0.5) * (0.4 + highN * 0.6),
      edm: bassN * tempoNorm * (0.4 + perc * 0.6) * (0.5 + highN * 0.5),
    };
    let best: MusicGenre = "pop";
    for (const g of Object.keys(target) as MusicGenre[]) {
      this.genreScores[g] +=
        (target[g] - this.genreScores[g]) * Math.min(1, dtu * 0.25);
      if (this.genreScores[g] > this.genreScores[best]) best = g;
    }
    this.genre = best;

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
      // Đếm mật độ onset (dùng cho ước lượng thể loại — nhạc dồn dập vs thưa)
      this.onsetRate += 0.6;
      // Downbeat: cộng dồn năng lượng onset theo 4 pha của ô nhịp — pha nào
      // mạnh nhất qua nhiều ô nhịp chính là phách 1 thật
      for (let p = 0; p < 4; p++) this.phaseEnergy[p] *= 0.96;
      this.phaseEnergy[this.beatIndex % 4] += bass;
      let bestP = 0;
      for (let p = 1; p < 4; p++) {
        if (this.phaseEnergy[p] > this.phaseEnergy[bestP]) bestP = p;
      }
      this.barOffset = bestP;
      // Tin cậy beat: onset rơi khớp lưới (gap ≈ bội số interval) → tăng
      const ratio = gap / this.interval;
      const offGrid = Math.abs(ratio - Math.round(ratio));
      this.beatConfidence +=
        ((offGrid < 0.18 ? 1 : 0) - this.beatConfidence) * 0.12;
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
