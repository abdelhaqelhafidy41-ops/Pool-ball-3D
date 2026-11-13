import { useGameStore } from '../../store/useGameStore';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private lastClackAt = 0;

  private ensureContext(): AudioContext | null {
    const { soundEnabled } = useGameStore.getState();
    if (!soundEnabled) return null;

    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private getVolume(): number {
    const { soundEnabled, soundVolume } = useGameStore.getState();
    return soundEnabled ? soundVolume : 0;
  }

  private ensureNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer && this.noiseBuffer.sampleRate === ctx.sampleRate) {
      return this.noiseBuffer;
    }
    const len = Math.floor(ctx.sampleRate * 0.15);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }

  public unlock() {
    this.ensureContext();
  }

  /** Crisp leather-tip on phenolic cue ball strike */
  public playCueStrike(power: number) {
    const ctx = this.ensureContext();
    const vol = this.getVolume();
    if (!ctx || vol <= 0) return;

    const now = ctx.currentTime;
    const gainScale = Math.min(1, Math.max(0.15, power)) * vol;

    // Resonant wood/resin transient
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(340 + power * 180, now);
    osc.frequency.exponentialRampToValueAtTime(110, now + 0.045);

    gain.gain.setValueAtTime(0.45 * gainScale, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.06);

    // Tip snap noise burst
    const noise = ctx.createBufferSource();
    noise.buffer = this.ensureNoiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1800, now);
    filter.Q.value = 1.6;

    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.28 * gainScale, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);

    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(ctx.destination);
    noise.start(now);
    noise.stop(now + 0.035);
  }

  /** High-frequency phenolic resin ball-to-ball clack */
  public playBallClack(impactSpeed: number) {
    const ctx = this.ensureContext();
    const vol = this.getVolume();
    if (!ctx || vol <= 0) return;

    const nowMs = performance.now();
    if (nowMs - this.lastClackAt < 18) return;
    this.lastClackAt = nowMs;

    const intensity = Math.min(1, Math.max(0.06, impactSpeed / 5.5));
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';
    const baseFreq = 2150 + Math.random() * 260;
    osc1.frequency.setValueAtTime(baseFreq, now);
    osc1.frequency.exponentialRampToValueAtTime(980, now + 0.025);
    osc2.frequency.setValueAtTime(baseFreq * 1.62, now);
    osc2.frequency.exponentialRampToValueAtTime(1350, now + 0.02);

    gain.gain.setValueAtTime(0.32 * intensity * vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.032);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.036);
    osc2.stop(now + 0.036);
  }

  /** Muffled rubber cushion rebound thud */
  public playCushionBounce(impactSpeed: number) {
    const ctx = this.ensureContext();
    const vol = this.getVolume();
    if (!ctx || vol <= 0) return;

    const intensity = Math.min(1, Math.max(0.08, impactSpeed / 4.5));
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(145, now);
    osc.frequency.exponentialRampToValueAtTime(52, now + 0.07);

    gain.gain.setValueAtTime(0.28 * intensity * vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.075);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  /** Leather pocket drop thump */
  public playPocketDrop() {
    const ctx = this.ensureContext();
    const vol = this.getVolume();
    if (!ctx || vol <= 0) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(125, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.14);

    gain.gain.setValueAtTime(0.38 * vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.17);
  }

  /** Subtle UI feedback click */
  public playUiClick() {
    const ctx = this.ensureContext();
    const vol = this.getVolume();
    if (!ctx || vol <= 0) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(640, now);
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.028);

    gain.gain.setValueAtTime(0.12 * vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.032);
  }

  public dispose() {
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

export const soundEngine = new SoundEngine();
