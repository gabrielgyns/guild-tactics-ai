// Tiny procedural sound effects (Web Audio). No assets: every sound is a few oscillators or a noise burst.

export type Sfx = 'step' | 'hit' | 'bigHit' | 'heal' | 'shield' | 'status' | 'ult' | 'death' | 'click' | 'victory' | 'defeat' | 'turn';

const STORAGE_KEY = 'guild-tactics.muted';

class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      /* storage unavailable */
    }
  }

  /** Must be called from a user gesture before the first sound. */
  unlock() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  toggle() {
    this.muted = !this.muted;
    try {
      localStorage.setItem(STORAGE_KEY, this.muted ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    return this.muted;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, delay = 0, slideTo?: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, cutoff: number, delay = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(filter).connect(g).connect(this.master!);
    src.start(t);
  }

  play(s: Sfx) {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    switch (s) {
      case 'step':
        this.noise(0.05, 0.25, 900);
        break;
      case 'click':
        this.tone(660, 0.05, 'square', 0.08);
        break;
      case 'turn':
        this.tone(520, 0.08, 'triangle', 0.12);
        this.tone(780, 0.1, 'triangle', 0.1, 0.07);
        break;
      case 'hit':
        this.noise(0.12, 0.6, 2200);
        this.tone(140, 0.12, 'square', 0.18, 0, 70);
        break;
      case 'bigHit':
        this.noise(0.22, 0.9, 3000);
        this.tone(110, 0.25, 'sawtooth', 0.25, 0, 45);
        break;
      case 'heal':
        [523, 659, 784].forEach((f, i) => this.tone(f, 0.18, 'sine', 0.16, i * 0.06));
        break;
      case 'shield':
        this.tone(330, 0.25, 'triangle', 0.15, 0, 660);
        break;
      case 'status':
        this.tone(300, 0.15, 'square', 0.08, 0, 200);
        break;
      case 'ult':
        [262, 330, 392, 523].forEach((f, i) => this.tone(f, 0.5, 'sawtooth', 0.09, i * 0.05));
        this.noise(0.4, 0.3, 5000, 0.15);
        break;
      case 'death':
        this.tone(330, 0.5, 'triangle', 0.18, 0, 80);
        break;
      case 'victory':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.16, i * 0.14));
        break;
      case 'defeat':
        [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.4, 'triangle', 0.14, i * 0.18));
        break;
    }
  }
}

export const audio = new Audio();
