/**
 * The audio layer — the atlas decision, applied to sound.
 *
 * Every cue is **synthesized at boot** from oscillator math and shaped noise: no binary asset, no
 * licence, no attribution, and a public repository stays free of both. Real audio replaces this
 * module and nothing else. The synthesis itself is pure `Float32Array` arithmetic, which is what
 * makes it unit-testable in Node — the WebAudio context only ever *plays* what was rendered.
 *
 * `SlotAudio` wraps the context behind a structural interface (the same move as ADR-0003): a real
 * `AudioContext` satisfies it without knowing it exists, and a test drives the class with a fake.
 */

export type AudioCue =
  'PRESS' | 'REEL_STOP' | 'COUNT_TICK' | 'WIN_NICE' | 'WIN_BIG' | 'WIN_MEGA' | 'FEATURE';

export const AUDIO_CUES: readonly AudioCue[] = [
  'PRESS',
  'REEL_STOP',
  'COUNT_TICK',
  'WIN_NICE',
  'WIN_BIG',
  'WIN_MEGA',
  'FEATURE',
];

/* ── synthesis ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Deterministic noise. Seeded rather than `Math.random()` not for purity's sake — this package is
 * allowed a browser — but because a cue that renders byte-identically every boot is one a test can
 * pin down.
 */
const noiseSource = (seed: number): (() => number) => {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32 — cheap, and more than random enough for a 25 ms burst of static.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffffffff) * 2 - 1;
  };
};

interface ToneOptions {
  /** Seconds from the cue's start. */
  at?: number;
  duration: number;
  frequency: number;
  /** Peak amplitude, 0..1. */
  gain?: number;
  /** Attack time in seconds — a click-free ramp in. */
  attack?: number;
}

/** Mix one decaying sine partial into the buffer. Everything musical below is built from this. */
const mixTone = (
  samples: Float32Array,
  sampleRate: number,
  { at = 0, duration, frequency, gain = 0.5, attack = 0.004 }: ToneOptions,
): void => {
  const start = Math.floor(at * sampleRate);
  const length = Math.min(Math.floor(duration * sampleRate), samples.length - start);
  const attackSamples = Math.max(1, Math.floor(attack * sampleRate));

  for (let index = 0; index < length; index += 1) {
    const t = index / sampleRate;
    const envelope =
      (index < attackSamples ? index / attackSamples : 1) *
      // Exponential-ish decay to silence over the tone's own duration.
      (1 - index / length) ** 2;
    const target = start + index;
    if (target >= 0 && target < samples.length) {
      samples[target] =
        (samples[target] ?? 0) + Math.sin(2 * Math.PI * frequency * t) * gain * envelope;
    }
  }
};

interface NoiseOptions {
  at?: number;
  duration: number;
  gain?: number;
  seed?: number;
}

/** Mix a decaying noise burst — the percussive half of a tick or a stop. */
const mixNoise = (
  samples: Float32Array,
  sampleRate: number,
  { at = 0, duration, gain = 0.3, seed = 0x5eed }: NoiseOptions,
): void => {
  const start = Math.floor(at * sampleRate);
  const length = Math.min(Math.floor(duration * sampleRate), samples.length - start);
  const noise = noiseSource(seed);

  for (let index = 0; index < length; index += 1) {
    const envelope = (1 - index / length) ** 3;
    const target = start + index;
    if (target >= 0 && target < samples.length) {
      samples[target] = (samples[target] ?? 0) + noise() * gain * envelope;
    }
  }
};

/** Soft-clip the mix so stacked partials cannot exceed ±1 — a pop is not a feature. */
const normalise = (samples: Float32Array): Float32Array => {
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.tanh(samples[index] ?? 0);
  }
  return samples;
};

const seconds = (duration: number, sampleRate: number): Float32Array =>
  new Float32Array(Math.ceil(duration * sampleRate));

/**
 * Render one cue to raw samples. Pure, deterministic, and the whole sound design in one switch:
 * ticks are noise plus a low thump, wins are ascending arpeggios that grow a note per tier, and
 * the feature is a slow warm chord — the audible version of the border turning gold.
 */
export function renderCue(cue: AudioCue, sampleRate: number): Float32Array {
  switch (cue) {
    case 'PRESS': {
      const samples = seconds(0.06, sampleRate);
      mixTone(samples, sampleRate, { duration: 0.05, frequency: 660, gain: 0.35 });
      mixNoise(samples, sampleRate, { duration: 0.02, gain: 0.12, seed: 0xb001 });
      return normalise(samples);
    }

    case 'REEL_STOP': {
      const samples = seconds(0.09, sampleRate);
      mixNoise(samples, sampleRate, { duration: 0.03, gain: 0.35, seed: 0x0705 });
      mixTone(samples, sampleRate, { duration: 0.08, frequency: 170, gain: 0.5 });
      return normalise(samples);
    }

    case 'COUNT_TICK': {
      const samples = seconds(0.03, sampleRate);
      mixTone(samples, sampleRate, { duration: 0.025, frequency: 1_320, gain: 0.22 });
      return normalise(samples);
    }

    case 'WIN_NICE': {
      const samples = seconds(0.45, sampleRate);
      mixTone(samples, sampleRate, { at: 0, duration: 0.22, frequency: 659, gain: 0.4 });
      mixTone(samples, sampleRate, { at: 0.12, duration: 0.3, frequency: 880, gain: 0.4 });
      return normalise(samples);
    }

    case 'WIN_BIG': {
      const samples = seconds(0.75, sampleRate);
      const notes = [523, 659, 784];
      notes.forEach((frequency, step) => {
        mixTone(samples, sampleRate, {
          at: step * 0.13,
          duration: 0.35,
          frequency,
          gain: 0.38,
        });
      });
      return normalise(samples);
    }

    case 'WIN_MEGA': {
      const samples = seconds(1.2, sampleRate);
      const notes = [523, 659, 784, 1_047];
      notes.forEach((frequency, step) => {
        mixTone(samples, sampleRate, {
          at: step * 0.14,
          duration: 0.5,
          frequency,
          gain: 0.36,
        });
        // An octave shimmer above each note, quiet enough to glitter rather than shriek.
        mixTone(samples, sampleRate, {
          at: step * 0.14,
          duration: 0.4,
          frequency: frequency * 2,
          gain: 0.1,
        });
      });
      return normalise(samples);
    }

    case 'FEATURE': {
      const samples = seconds(1.4, sampleRate);
      // A warm A-major-ish pad: root, fifth, octave, third — long attacks, no percussion.
      for (const [frequency, gain] of [
        [220, 0.3],
        [330, 0.22],
        [440, 0.18],
        [554, 0.14],
      ] as const) {
        mixTone(samples, sampleRate, { duration: 1.35, frequency, gain, attack: 0.15 });
      }
      return normalise(samples);
    }
  }
}

/* ── the context wrapper ───────────────────────────────────────────────────────────────────── */

/**
 * The slice of `AudioContext` this class touches. A real one satisfies it structurally; a test
 * fakes four methods instead of a browser.
 */
export interface AudioContextPort {
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferPort;
  createBufferSource(): AudioBufferSourcePort;
}

export interface AudioBufferPort {
  copyToChannel(source: Float32Array, channel: number): void;
}

export interface AudioBufferSourcePort {
  buffer: AudioBufferPort | null;
  connect(destination: unknown): unknown;
  start(): void;
}

/** The one-shot gesture target `attachUnlock` listens on. `window` satisfies it. */
export interface GestureTarget {
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface SlotAudioOptions {
  context: AudioContextPort;
}

export class SlotAudio {
  readonly #context: AudioContextPort;
  readonly #buffers = new Map<AudioCue, AudioBufferPort>();
  #muted = false;
  /** Held separately from the player's own choice, so returning to the tab restores *their* state. */
  #hidden = false;

  constructor({ context }: SlotAudioOptions) {
    this.#context = context;
    // Everything is rendered up front — the atlas decision. Seven cues at 44.1 kHz is under two
    // seconds of mono audio; the boot cost is a few milliseconds, and the ticker allocates nothing.
    for (const cue of AUDIO_CUES) {
      const samples = renderCue(cue, context.sampleRate);
      const buffer = context.createBuffer(1, samples.length, context.sampleRate);
      buffer.copyToChannel(samples, 0);
      this.#buffers.set(cue, buffer);
    }
  }

  get muted(): boolean {
    return this.#muted;
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
  }

  /** The tab went dark or came back. Separate from `setMuted` so neither clobbers the other. */
  setHidden(hidden: boolean): void {
    this.#hidden = hidden;
  }

  /**
   * Resume a context the browser suspended. iOS (and Chrome's autoplay policy) create contexts in
   * `suspended` until a user gesture — call this from one, or use `attachUnlock`.
   */
  unlock(): void {
    if (this.#context.state === 'suspended') {
      void this.#context.resume().catch(() => {
        // A refused resume means no gesture has happened yet; the next one will try again.
      });
    }
  }

  /** The iOS story in one call: the first tap or key anywhere unlocks the context, then detaches. */
  attachUnlock(target: GestureTarget): () => void {
    const unlock = (): void => {
      this.unlock();
      detach();
    };
    const detach = (): void => {
      target.removeEventListener('pointerdown', unlock);
      target.removeEventListener('keydown', unlock);
    };
    target.addEventListener('pointerdown', unlock, { once: true });
    target.addEventListener('keydown', unlock, { once: true });
    return detach;
  }

  /** Fire and forget. Silent while muted or hidden, and a cue is never queued for later. */
  play(cue: AudioCue): void {
    if (this.#muted || this.#hidden) return;
    if (this.#context.state !== 'running') return;

    const buffer = this.#buffers.get(cue);
    if (buffer === undefined) return;

    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#context.destination);
    source.start();
  }
}
