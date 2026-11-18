import { useGameStore } from '../../store/useGameStore';

export interface AudioBusSettings {
  soundEnabled: boolean;
  soundVolume: number;
  sfxVolume: number;
  sfxMuted: boolean;
  musicVolume: number;
  musicMuted: boolean;
}

export interface ComputedAudioBusGains {
  master: number;
  sfx: number;
  music: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function computeAudioBusGains(settings: AudioBusSettings): ComputedAudioBusGains {
  if (!settings.soundEnabled) {
    return { master: 0, sfx: 0, music: 0 };
  }
  const master = clamp01(settings.soundVolume);
  const sfx = settings.sfxMuted ? 0 : master * clamp01(settings.sfxVolume);
  const music = settings.musicMuted ? 0 : master * clamp01(settings.musicVolume);
  return { master, sfx, music };
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private ambientOscs: OscillatorNode[] = [];
  private ambientGain: GainNode | null = null;
  private ambientFilter: BiquadFilterNode | null = null;
  private storeUnsub: (() => void) | null = null;
  private gestureUnlocked = false;

  // Anti-spam cooldowns & voice limiter
  private lastClackAt = 0;
  private lastCushionAt = 0;
  private lastPocketAt = 0;
  private lastUiClickAt = 0;
  private lastTurnChimeAt = 0;
  private activeSfxVoices = 0;
  private readonly maxSfxVoices = 14;

  private ensureStoreSync() {
    if (this.storeUnsub) return;
    this.storeUnsub = useGameStore.subscribe(() => {
      this.syncBusGains();
    });
  }

  private getCurrentSettings(): AudioBusSettings {
    const s = useGameStore.getState();
    return {
      soundEnabled: s.soundEnabled,
      soundVolume: s.soundVolume,
      sfxVolume: s.sfxVolume,
      sfxMuted: s.sfxMuted,
      musicVolume: s.musicVolume,
      musicMuted: s.musicMuted,
    };
  }

  private ensureContext(): AudioContext | null {
    this.ensureStoreSync();
    const gains = computeAudioBusGains(this.getCurrentSettings());
    if (gains.master <= 0 && gains.sfx <= 0 && gains.music <= 0) {
      return null;
    }

    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
        this.masterGain = this.ctx.createGain();
        this.sfxGain = this.ctx.createGain();
        this.musicGain = this.ctx.createGain();
        this.sfxGain.connect(this.masterGain);
        this.musicGain.connect(this.masterGain);
        this.masterGain.connect(this.ctx.destination);
      }
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    this.syncBusGains();
    return this.ctx;
  }

  private syncBusGains() {
    if (!this.ctx || !this.masterGain || !this.sfxGain || !this.musicGain) {
      if (this.ambientOscs.length > 0) {
        this.stopAmbient();
      }
      return;
    }

    const s = this.getCurrentSettings();
    const gains = computeAudioBusGains(s);
    const now = this.ctx.currentTime;

    this.masterGain.gain.setTargetAtTime(gains.master, now, 0.025);
    this.sfxGain.gain.setTargetAtTime(s.sfxMuted ? 0 : clamp01(s.sfxVolume), now, 0.025);
    this.musicGain.gain.setTargetAtTime(s.musicMuted ? 0 : clamp01(s.musicVolume), now, 0.05);

    if (this.gestureUnlocked && gains.music > 0.005) {
      this.startAmbientIfNeeded();
    } else {
      this.stopAmbient();
    }
  }

  private ensureNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer && this.noiseBuffer.sampleRate === ctx.sampleRate) {
      return this.noiseBuffer;
    }
    const len = Math.floor(ctx.sampleRate * 0.18);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }

  private tryReserveVoice(durationSec: number): boolean {
    if (this.activeSfxVoices >= this.maxSfxVoices) {
      return false;
    }
    this.activeSfxVoices++;
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        this.activeSfxVoices = Math.max(0, this.activeSfxVoices - 1);
      }, Math.ceil(durationSec * 1000) + 20);
    } else {
      this.activeSfxVoices = Math.max(0, this.activeSfxVoices - 1);
    }
    return true;
  }

  private canPlaySfx(): { ctx: AudioContext; bus: GainNode; sfxLevel: number } | null {
    const gains = computeAudioBusGains(this.getCurrentSettings());
    if (gains.sfx <= 0) return null;
    const ctx = this.ensureContext();
    if (!ctx || !this.sfxGain) return null;
    return { ctx, bus: this.sfxGain, sfxLevel: gains.sfx };
  }

  private startAmbientIfNeeded() {
    if (!this.ctx || !this.musicGain || this.ambientOscs.length > 0) return;
    if (this.ctx.state === 'suspended') return;

    const now = this.ctx.currentTime;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(420, now);
    filter.Q.value = 0.7;

    const padGain = this.ctx.createGain();
    padGain.gain.setValueAtTime(0.0001, now);
    padGain.gain.linearRampToValueAtTime(0.065, now + 1.2);

    filter.connect(padGain);
    padGain.connect(this.musicGain);

    // Subtle warm Dm9 billiards lounge pad (D2, A2, F3, E4 very soft)
    const freqs = [146.83, 220.0, 261.63, 329.63];
    const oscs: OscillatorNode[] = [];
    for (let i = 0; i < freqs.length; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = i < 2 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(freqs[i], now);
      osc.detune.setValueAtTime((i - 1.5) * 3.5, now);

      const voiceGain = this.ctx.createGain();
      voiceGain.gain.setValueAtTime(i === 0 ? 0.42 : i === 1 ? 0.3 : 0.16, now);
      osc.connect(voiceGain);
      voiceGain.connect(filter);
      osc.start(now);
      oscs.push(osc);
    }

    this.ambientFilter = filter;
    this.ambientGain = padGain;
    this.ambientOscs = oscs;
  }

  private stopAmbient() {
    if (this.ambientOscs.length === 0) return;
    for (const osc of this.ambientOscs) {
      try {
        osc.stop();
        osc.disconnect();
      } catch {
        // Ignore already stopped
      }
    }
    this.ambientOscs = [];
    try {
      this.ambientFilter?.disconnect();
      this.ambientGain?.disconnect();
    } catch {
      // Ignore
    }
    this.ambientFilter = null;
    this.ambientGain = null;
  }

  public unlock() {
    this.gestureUnlocked = true;
    const ctx = this.ensureContext();
    if (ctx && ctx.state === 'suspended') {
      ctx
        .resume()
        .then(() => {
          this.syncBusGains();
        })
        .catch(() => {});
    } else {
      this.syncBusGains();
    }
  }

  public getEffectiveGains(): ComputedAudioBusGains {
    return computeAudioBusGains(this.getCurrentSettings());
  }

  /** Crisp leather-tip & ash/maple shaft strike on phenolic cue ball */
  public playCueStrike(power: number) {
    const target = this.canPlaySfx();
    if (!target) return;
    if (!this.tryReserveVoice(0.09)) return;

    const { ctx, bus } = target;
    const now = ctx.currentTime;
    const clampedPower = clamp01(power);
    const gainScale = Math.min(1, Math.max(0.18, clampedPower));

    // Resonant wood/resin transient
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(360 + clampedPower * 210, now);
    osc.frequency.exponentialRampToValueAtTime(105, now + 0.05);

    gain.gain.setValueAtTime(0.42 * gainScale, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

    osc.connect(gain);
    gain.connect(bus);
    osc.start(now);
    osc.stop(now + 0.065);

    // Chalk/leather tip snap noise burst
    const noise = ctx.createBufferSource();
    noise.buffer = this.ensureNoiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1700 + clampedPower * 700, now);
    filter.Q.value = 1.5;

    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.28 * gainScale, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.032);

    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(bus);
    noise.start(now);
    noise.stop(now + 0.036);
  }

  /** High-frequency phenolic resin ball-to-ball clack scaled by collision velocity */
  public playBallClack(impactSpeed: number) {
    if (!Number.isFinite(impactSpeed) || impactSpeed < 0.08) return;
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowMs - this.lastClackAt < 22) return;

    const target = this.canPlaySfx();
    if (!target) return;
    if (!this.tryReserveVoice(0.05)) return;

    this.lastClackAt = nowMs;
    const { ctx, bus } = target;
    const intensity = Math.min(1, Math.max(0.06, impactSpeed / 5.4));
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';
    const baseFreq = 2050 + intensity * 420 + (Math.random() - 0.5) * 180;
    osc1.frequency.setValueAtTime(baseFreq, now);
    osc1.frequency.exponentialRampToValueAtTime(940, now + 0.026);
    osc2.frequency.setValueAtTime(baseFreq * 1.58, now);
    osc2.frequency.exponentialRampToValueAtTime(1320, now + 0.02);

    gain.gain.setValueAtTime(0.34 * intensity, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.034);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(bus);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.038);
    osc2.stop(now + 0.038);
  }

  /** Muffled K-55 rubber cushion rebound thud */
  public playCushionBounce(impactSpeed: number) {
    if (!Number.isFinite(impactSpeed) || impactSpeed < 0.12) return;
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowMs - this.lastCushionAt < 32) return;

    const target = this.canPlaySfx();
    if (!target) return;
    if (!this.tryReserveVoice(0.09)) return;

    this.lastCushionAt = nowMs;
    const { ctx, bus } = target;
    const intensity = Math.min(1, Math.max(0.08, impactSpeed / 4.5));
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(135 + intensity * 35, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.075);

    gain.gain.setValueAtTime(0.3 * intensity, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.connect(gain);
    gain.connect(bus);
    osc.start(now);
    osc.stop(now + 0.085);
  }

  /** Leather pocket drop thump & subtle cup settle rattle */
  public playPocketDrop() {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowMs - this.lastPocketAt < 40) return;

    const target = this.canPlaySfx();
    if (!target) return;
    if (!this.tryReserveVoice(0.24)) return;

    this.lastPocketAt = nowMs;
    const { ctx, bus } = target;
    const now = ctx.currentTime;

    // Initial rim/throat drop thump
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(132, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.14);

    gain.gain.setValueAtTime(0.38, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

    osc.connect(gain);
    gain.connect(bus);
    osc.start(now);
    osc.stop(now + 0.17);

    // Soft cup settle knock slightly after
    const cupOsc = ctx.createOscillator();
    const cupGain = ctx.createGain();
    cupOsc.type = 'triangle';
    cupOsc.frequency.setValueAtTime(210, now + 0.075);
    cupOsc.frequency.exponentialRampToValueAtTime(84, now + 0.16);

    cupGain.gain.setValueAtTime(0.001, now);
    cupGain.gain.setValueAtTime(0.16, now + 0.075);
    cupGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    cupOsc.connect(cupGain);
    cupGain.connect(bus);
    cupOsc.start(now + 0.07);
    cupOsc.stop(now + 0.19);
  }

  /** Subtle UI feedback click */
  public playUiClick() {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowMs - this.lastUiClickAt < 24) return;

    const target = this.canPlaySfx();
    if (!target) return;
    if (!this.tryReserveVoice(0.04)) return;

    this.lastUiClickAt = nowMs;
    const { ctx, bus } = target;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(640, now);
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.028);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);

    osc.connect(gain);
    gain.connect(bus);
    osc.start(now);
    osc.stop(now + 0.032);
  }

  /** Clean subtle chime when turn transitions */
  public playTurnChange(isLocalTurn: boolean) {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowMs - this.lastTurnChimeAt < 250) return;

    const target = this.canPlaySfx();
    if (!target) return;
    if (!this.tryReserveVoice(0.28)) return;

    this.lastTurnChimeAt = nowMs;
    const { ctx, bus } = target;
    const now = ctx.currentTime;
    const notes = isLocalTurn ? [523.25, 659.25] : [440.0, 392.0];

    notes.forEach((freq, idx) => {
      const t0 = now + idx * 0.065;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0);

      g.gain.setValueAtTime(0.001, t0);
      g.gain.linearRampToValueAtTime(isLocalTurn ? 0.12 : 0.08, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);

      osc.connect(g);
      g.connect(bus);
      osc.start(t0);
      osc.stop(t0 + 0.19);
    });
  }

  /** Warm major arpeggio victory fanfare */
  public playVictoryFanfare() {
    const target = this.canPlaySfx();
    if (!target) return;
    if (!this.tryReserveVoice(0.75)) return;

    const { ctx, bus } = target;
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];

    notes.forEach((freq, idx) => {
      const t0 = now + idx * 0.08;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = idx === notes.length - 1 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, t0);

      g.gain.setValueAtTime(0.001, t0);
      g.gain.linearRampToValueAtTime(0.16, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + (idx === notes.length - 1 ? 0.45 : 0.28));

      osc.connect(g);
      g.connect(bus);
      osc.start(t0);
      osc.stop(t0 + 0.48);
    });
  }

  /** Dignified subtle defeat cadence */
  public playDefeatCue() {
    const target = this.canPlaySfx();
    if (!target) return;
    if (!this.tryReserveVoice(0.6)) return;

    const { ctx, bus } = target;
    const now = ctx.currentTime;
    const notes = [392.0, 349.23, 293.66];

    notes.forEach((freq, idx) => {
      const t0 = now + idx * 0.11;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0);

      g.gain.setValueAtTime(0.001, t0);
      g.gain.linearRampToValueAtTime(0.12, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.34);

      osc.connect(g);
      g.connect(bus);
      osc.start(t0);
      osc.stop(t0 + 0.36);
    });
  }

  public dispose() {
    this.stopAmbient();
    if (this.storeUnsub) {
      this.storeUnsub();
      this.storeUnsub = null;
    }
    try {
      this.sfxGain?.disconnect();
      this.musicGain?.disconnect();
      this.masterGain?.disconnect();
    } catch {
      // Ignore
    }
    this.sfxGain = null;
    this.musicGain = null;
    this.masterGain = null;
    this.noiseBuffer = null;
    this.activeSfxVoices = 0;
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

export const soundEngine = new SoundEngine();
