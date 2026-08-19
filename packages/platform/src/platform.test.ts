import { describe, expect, it } from 'vitest';
import { AUDIO_CUES, SlotAudio, renderCue } from './audio.js';
import type { AudioBufferPort, AudioBufferSourcePort, AudioContextPort } from './audio.js';
import { watchVisibility } from './visibility.js';
import { MemoryStorage, safeStorage } from './storage.js';
import type { KeyValueStorage } from './storage.js';
import { NO_INSETS, readSafeAreaInsets } from './safe-area.js';
import { detectCapabilities } from './capabilities.js';

/**
 * The whole package headless — which is the point of the ports. The browser objects here are a few
 * lines of fake each; the real ones satisfy the same interfaces without knowing they exist.
 */

const SAMPLE_RATE = 44_100;

describe('cue synthesis', () => {
  it('renders every cue, audibly and within range', () => {
    for (const cue of AUDIO_CUES) {
      const samples = renderCue(cue, SAMPLE_RATE);

      expect(samples.length).toBeGreaterThan(0);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      // Audible: something was actually mixed in. In range: soft-clipped below full scale.
      expect(peak).toBeGreaterThan(0.05);
      expect(peak).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic — the same cue renders byte-identically', () => {
    expect(renderCue('REEL_STOP', SAMPLE_RATE)).toEqual(renderCue('REEL_STOP', SAMPLE_RATE));
  });

  it('grows the win by tier — a bigger win is a longer fanfare', () => {
    const nice = renderCue('WIN_NICE', SAMPLE_RATE).length;
    const big = renderCue('WIN_BIG', SAMPLE_RATE).length;
    const mega = renderCue('WIN_MEGA', SAMPLE_RATE).length;

    expect(nice).toBeLessThan(big);
    expect(big).toBeLessThan(mega);
  });
});

class FakeContext implements AudioContextPort {
  readonly sampleRate = SAMPLE_RATE;
  state = 'running';
  readonly destination = {};
  readonly started: string[] = [];
  resumes = 0;

  resume(): Promise<void> {
    this.resumes += 1;
    this.state = 'running';
    return Promise.resolve();
  }

  createBuffer(_channels: number, length: number): AudioBufferPort {
    return { copyToChannel: () => {}, length } as AudioBufferPort & { length: number };
  }

  createBufferSource(): AudioBufferSourcePort {
    return {
      buffer: null,
      connect: () => ({}),
      start: () => {
        this.started.push('cue');
      },
    };
  }
}

describe('SlotAudio', () => {
  it('renders all cues at boot and plays through the context', () => {
    const context = new FakeContext();
    const audio = new SlotAudio({ context });

    audio.play('REEL_STOP');
    expect(context.started).toHaveLength(1);
  });

  it('is silent while muted, and silent again while the tab is hidden', () => {
    const context = new FakeContext();
    const audio = new SlotAudio({ context });

    audio.setMuted(true);
    audio.play('PRESS');
    audio.setMuted(false);
    audio.setHidden(true);
    audio.play('PRESS');

    expect(context.started).toHaveLength(0);

    // The two flags are independent: coming back to the tab restores the player's own choice.
    audio.setHidden(false);
    audio.play('PRESS');
    expect(context.started).toHaveLength(1);
  });

  it('never plays through a context the browser has not unlocked', () => {
    const context = new FakeContext();
    context.state = 'suspended';
    const audio = new SlotAudio({ context });

    audio.play('PRESS');
    expect(context.started).toHaveLength(0);

    audio.unlock();
    expect(context.resumes).toBe(1);
    audio.play('PRESS');
    expect(context.started).toHaveLength(1);
  });

  it('unlocks on the first gesture and then stops listening', () => {
    const context = new FakeContext();
    context.state = 'suspended';
    const audio = new SlotAudio({ context });

    const listeners = new Map<string, () => void>();
    audio.attachUnlock({
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type) => listeners.delete(type),
    });

    expect([...listeners.keys()].sort()).toEqual(['keydown', 'pointerdown']);
    listeners.get('pointerdown')?.();

    expect(context.resumes).toBe(1);
    expect(listeners.size).toBe(0);
  });
});

describe('visibility', () => {
  const fakeDocument = (initial: string) => {
    const listeners = new Set<() => void>();
    return {
      doc: {
        visibilityState: initial,
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      },
      flip(state: string) {
        this.doc.visibilityState = state;
        for (const listener of listeners) listener();
      },
      listeners,
    };
  };

  it('answers immediately, then follows every change, then lets go', () => {
    const fake = fakeDocument('visible');
    const seen: boolean[] = [];

    const stop = watchVisibility(fake.doc, (visible) => seen.push(visible));
    fake.flip('hidden');
    fake.flip('visible');
    stop();
    fake.flip('hidden');

    expect(seen).toEqual([true, false, true]);
    expect(fake.listeners.size).toBe(0);
  });
});

describe('safe storage', () => {
  const throwing = (): KeyValueStorage => ({
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  });

  it('passes a healthy store through untouched', () => {
    const backing = new MemoryStorage();
    const store = safeStorage(backing);

    store.setItem('k', 'v');
    expect(backing.getItem('k')).toBe('v');
  });

  it('falls back to memory when the store is absent or refuses the probe', () => {
    for (const store of [safeStorage(null), safeStorage(throwing())]) {
      store.setItem('k', 'v');
      expect(store.getItem('k')).toBe('v');
    }
  });

  it('swallows a write that starts failing mid-session — the preference is lost, the game is not', () => {
    let full = false;
    const backing = new MemoryStorage();
    const flaky: KeyValueStorage = {
      getItem: (key) => backing.getItem(key),
      setItem: (key, value) => {
        if (full) throw new Error('quota');
        backing.setItem(key, value);
      },
      removeItem: (key) => backing.removeItem(key),
    };

    const store = safeStorage(flaky);
    store.setItem('k', 'v');
    full = true;
    expect(() => store.setItem('k', 'v2')).not.toThrow();
    expect(store.getItem('k')).toBe('v');
  });
});

describe('safe-area insets', () => {
  it('measures what CSS reports, via the probe', () => {
    const styles = new Map([
      ['padding-top', '44px'],
      ['padding-right', '0px'],
      ['padding-bottom', '34px'],
      ['padding-left', '0px'],
    ]);
    const body = { appended: 0, removed: 0 };

    const insets = readSafeAreaInsets({
      createElement: () => ({ style: { cssText: '' } }),
      body: {
        appendChild: () => (body.appended += 1),
        removeChild: () => (body.removed += 1),
      },
      defaultView: {
        getComputedStyle: () => ({
          getPropertyValue: (name: string) => styles.get(name) ?? '',
        }),
      },
    });

    expect(insets).toEqual({ top: 44, right: 0, bottom: 34, left: 0 });
    // The probe does not leak: appended once, removed once.
    expect(body).toEqual({ appended: 1, removed: 1 });
  });

  it('returns zeros when there is nothing to measure', () => {
    const insets = readSafeAreaInsets({
      createElement: () => ({ style: { cssText: '' } }),
      body: { appendChild: () => ({}), removeChild: () => ({}) },
      defaultView: null,
    });

    expect(insets).toEqual(NO_INSETS);
  });
});

describe('capability detection', () => {
  it('reads a phone as a phone', () => {
    const capabilities = detectCapabilities({
      devicePixelRatio: 3,
      navigator: { maxTouchPoints: 5, hardwareConcurrency: 8 },
      matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }),
      AudioContext: class {},
    });

    expect(capabilities).toEqual({
      pixelRatio: 3,
      touch: true,
      coarsePointer: true,
      reducedMotion: false,
      webAudio: true,
      hardwareConcurrency: 8,
    });
  });

  it('defaults sanely on a bare environment', () => {
    expect(detectCapabilities({})).toEqual({
      pixelRatio: 1,
      touch: false,
      coarsePointer: false,
      reducedMotion: false,
      webAudio: false,
      hardwareConcurrency: 1,
    });
  });
});
