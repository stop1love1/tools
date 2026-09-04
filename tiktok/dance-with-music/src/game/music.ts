import type { Beat, MusicGenre } from "./player";

// Krumhansl key profiles: perceived weight of the 12 pitch classes in a major
// vs minor key. Matched against the chromagram to guess the song's mode.
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

  /** Mid-band (vocals/synth) and high-band (hi-hat) energy, 0..1. */
  mid = 0;
  high = 0;
  /** Drop intensity, decaying from 1: bass erupts after >1s of quiet. */
  dropLevel = 0;
  /**
   * Song mood, smoothed hard so it never jumps between phrases:
   * - moodEnergy 0..1: calm → intense (total spectral energy).
   * - moodValence 0..1: sad → happy (bright treble-heavy spectrum + tempo).
   */
  moodEnergy = 0;
  moodValence = 0.4;
  /**
   * Section intensity relative to THIS song (loudness z-score): 0 = quiet
   * break, ~0.5 = normal, 1 = chorus/drop. Independent of how loud the track
   * is mixed, so it gates pyro/lights far better than an absolute threshold.
   */
  section = 0.5;
  private emaFast = 0;
  private emaSlow = 0;
  private emaVar = 0.001;
  private centroidAvg = 0.3;
  /**
   * Melody contour, from the dominant pitch in the 250–2000Hz band:
   * - melodyTrend -1..1: >0 melody rising, <0 falling.
   * - melodyHeight 0..1: current pitch within this song's own range.
   */
  melodyTrend = 0;
  melodyHeight = 0.5;
  /** Genre estimated from tempo + spectral balance + onset density. */
  genre: MusicGenre = "pop";
  /**
   * Offset from the beat grid to the real downbeat, found by accumulating
   * accent energy over the 4 phases of a bar. The game subtracts it so every
   * %4/%8 accent lands on beat 1.
   */
  barOffset = 0;
  /** Beat confidence 0..1 — high when onsets land on an even grid; low → less pyro. */
  beatConfidence = 0.5;
  private phaseEnergy = [0, 0, 0, 0];
  private chromaMap: Int32Array | null = null;
  private chroma = new Float32Array(12);
  /** 0 = minor key (sad) → 1 = major key (bright). */
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

  /** In a quiet stretch (bass under the floor >0.5s) — usually a break/buildup. */
  get inQuietSection(): boolean {
    return this.playing && this.quietTime > 0.5;
  }


  /** Playback position in seconds; null with no track or unknown length. */
  get progress(): { time: number; duration: number } | null {
    if (!this.audio) return null;
    const duration = this.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return { time: this.audio.currentTime, duration };
  }

  /** Seek to an absolute second (restores position after a reload). */
  seekTo(seconds: number) {
    if (!this.audio) return;
    this.audio.currentTime = Math.max(0, seconds);
  }

  /** Seek to a 0..1 position (clicking the DJ screen's progress bar). */
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
      // Keep smoothing LOW to catch the kick transient immediately: the old
      // 0.6 delayed onsets by ~50ms, firing effects after the audible hit.
      // Level/bass have their own EMA below, so lights still don't flicker.
      this.analyser.smoothingTimeConstant = 0.2;
      source.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      const hzPerBin = this.ctx.sampleRate / this.analyser.fftSize;
      this.hzPerBin = hzPerBin;
      // FFT bin → pitch class (chroma) table for 80Hz–2kHz, built once.
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
    // play() first: a browser blocking autoplay throws NotAllowedError right
    // away, whereas awaiting ctx.resume() while blocked hangs forever.
    await this.audio.play();
    void this.ctx!.resume();
    this.history = [];
    this.beatIndex = 0;
    this.lastOnset = performance.now() / 1000;
    // Reset alongside lastOnset, or beatConfidence sinks to its floor at the
    // start of every track.
    this.lastRealOnset = this.lastOnset;
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

    // === Detection adapted to the track currently playing ===
    // Weighted overall loudness (bass heaviest, roughly as the ear hears it)
    const inst = this.level * 0.5 + this.mid * 0.35 + this.high * 0.15;
    // Fast/slow EMA + variance → z-score: how unusually loud or quiet this
    // moment is against THIS song's own average, whatever its mix level.
    this.emaFast += (inst - this.emaFast) * Math.min(1, dtu * 3);
    this.emaSlow += (inst - this.emaSlow) * Math.min(1, dtu * 0.12);
    const dev = inst - this.emaSlow;
    this.emaVar += (dev * dev - this.emaVar) * Math.min(1, dtu * 0.12);
    const z =
      (this.emaFast - this.emaSlow) / Math.max(0.012, Math.sqrt(this.emaVar));
    const sectionTarget = Math.min(1, Math.max(0, 0.5 + z * 0.3));
    // Snap into a peak fast, ease out slowly — like a real lighting operator
    this.section +=
      (sectionTarget - this.section) *
      Math.min(1, dtu * (sectionTarget > this.section ? 2.5 : 0.8));

    // Spectral centroid: high = bright, low = dark
    let wSum = 0;
    let mSum = 0;
    for (let i = this.loBin; i <= this.highHi; i++) {
      wSum += i * this.freq[i];
      mSum += this.freq[i];
    }
    const centroid = mSum > 1 ? wSum / mSum / (this.midHi * 2) : 0.3;
    this.centroidAvg += (centroid - this.centroidAvg) * Math.min(1, dtu * 0.5);

    // === Chromagram → major/minor: the harmonic sad/happy signal, rather
    // than guessing it from spectral brightness alone ===
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
        // Correlate against all 12 major + 12 minor keys, keep the best match
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
        // The spread around 0.5 is tiny — amplify, then smooth slowly (~4s)
        const amplified = Math.min(
          1,
          Math.max(0, 0.5 + (modeInst - 0.5) * 6),
        );
        this.modeMajor += (amplified - this.modeMajor) * Math.min(1, dtu * 0.25);
      }
    }

    const bpm = 60 / this.interval;
    const tempoNorm = Math.min(1, Math.max(0, (bpm - 85) / 70));
    // Energy = absolute loudness × where this section sits within the song
    const absLoud = Math.min(1, inst * 2.2);
    const energyInst = Math.min(1, absLoud * (0.4 + this.section * 0.8));
    // Valence: key mode is the primary signal, brightness and tempo assist
    const valenceInst = Math.min(
      1,
      this.modeMajor * 0.45 +
        Math.max(0, (this.centroidAvg - 0.16) * 2.4) * 0.3 +
        tempoNorm * 0.25,
    );
    this.moodEnergy += (energyInst - this.moodEnergy) * Math.min(1, dtu * 0.7);
    this.moodValence +=
      (valenceInst - this.moodValence) * Math.min(1, dtu * 0.35);
    // No onset for a long while (ambient/noisy passage) → lower confidence
    if (nowT - this.lastRealOnset > 2.5) {
      this.beatConfidence = Math.max(0.25, this.beatConfidence - dtu * 0.12);
    }

    // === Melody: dominant pitch in the vocal/lead band → rising or falling ===
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
      // Fast vs slow EMA: their difference is the direction the melody moves
      this.melodyFast += (semi - this.melodyFast) * Math.min(1, dtu * 8);
      this.melodySlow += (semi - this.melodySlow) * Math.min(1, dtu * 1.2);
      const trend = Math.max(
        -1,
        Math.min(1, (this.melodyFast - this.melodySlow) / 5),
      );
      this.melodyTrend += (trend - this.melodyTrend) * Math.min(1, dtu * 4);
      this.melodyLo = Math.min(this.melodyLo, this.melodyFast);
      this.melodyHi = Math.max(this.melodyHi, this.melodyFast);
      // Let the range contract slowly so it adapts when the song changes key
      this.melodyLo += (this.melodyFast - this.melodyLo) * Math.min(1, dtu * 0.02);
      this.melodyHi += (this.melodyFast - this.melodyHi) * Math.min(1, dtu * 0.02);
      const range = Math.max(3, this.melodyHi - this.melodyLo);
      const h = (this.melodyFast - this.melodyLo) / range;
      this.melodyHeight += (h - this.melodyHeight) * Math.min(1, dtu * 3);
    } else {
      this.melodyTrend *= Math.max(0, 1 - dtu * 2);
    }

    // === Genre estimate: tempo + bass/mid/treble balance + onset density.
    // Scores are smoothed ~4s before taking the max, so the genre never flips
    // mid-phrase ===
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

    // Drop: bass stays under the floor >1s (break/buildup), then bursts past it
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
    // An onset needs energy above the floor AND a sudden spectral change
    // (flux), so a long sustained bass note isn't counted as a new beat.
    const energyHit = bass > avg * this.sensitivity && bass > 0.02;
    const fluxHit =
      flux > this.fluxAvg * 1.1 || bass > avg * this.sensitivity * 1.4;
    if (energyHit && fluxHit && gap > 0.25) {
      // Onset density, feeding the genre estimate (busy vs sparse music)
      this.onsetRate += 0.6;
      // Downbeat: accumulate onset energy across the 4 phases of a bar; the
      // phase that stays strongest over many bars is the real beat 1.
      for (let p = 0; p < 4; p++) this.phaseEnergy[p] *= 0.96;
      this.phaseEnergy[this.beatIndex % 4] += bass;
      let bestP = 0;
      for (let p = 1; p < 4; p++) {
        if (this.phaseEnergy[p] > this.phaseEnergy[bestP]) bestP = p;
      }
      this.barOffset = bestP;
      // Onsets landing on the grid (gap ≈ a multiple of interval) raise trust
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
        // Pull the grid harder toward the real onset (0.35 → 0.5) so the
        // visual beat tracks the audible one instead of lagging behind.
        this.lastOnset += (now - this.lastOnset) * 0.5;
      }
    }
  }

  // Compensates the residual analyse→render latency (~46ms FFT window plus
  // light easing) by nudging the phase early, so a flash lands when the kick
  // is heard rather than a frame-beat later. Small enough (~40ms) that
  // instant elements don't read as early either.
  private static readonly BEAT_LEAD = 0.04;
  /**
   * Manual beat offset in seconds (+ earlier / − later). The operator dials
   * it in against what they actually hear, covering latency that varies by
   * machine, track and stream path. Adjustable live by key.
   */
  beatOffset = 0;

  /** Current beat period in seconds, from the tracked tempo. */
  get beatSeconds(): number {
    return this.interval;
  }

  getBeat(): Beat {
    const now = performance.now() / 1000;
    const ph =
      (now - this.lastOnset + MusicPlayer.BEAT_LEAD + this.beatOffset) /
      this.interval;
    // The shifted phase can cross a beat boundary, so carry the whole part
    // into index — index-gated events must stay on the same grid as pulse.
    const shift = Math.floor(ph);
    return {
      index: Math.max(0, this.beatIndex + shift),
      pulse: Math.min(0.999, ph - shift),
    };
  }
}
