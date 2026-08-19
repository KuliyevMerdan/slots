/**
 * What kind of device is this? Asked once, at boot, behind a port.
 *
 * The consumers are practical: the renderer caps `devicePixelRatio`, the perf pass (C7) wants to
 * know how many cores it is profiling on, and coarse-pointer devices get bigger hit targets when
 * the DOM control layer sizes itself. Detection is facts-only — this module never *decides*
 * anything with what it finds.
 */

export interface DeviceCapabilities {
  readonly pixelRatio: number;
  /** Any touch input at all. */
  readonly touch: boolean;
  /** The *primary* pointer is imprecise — a finger, not a mouse. Hit targets read this. */
  readonly coarsePointer: boolean;
  readonly reducedMotion: boolean;
  readonly webAudio: boolean;
  readonly hardwareConcurrency: number;
}

/** The slice of `window` detection reads. The real one satisfies it. */
export interface CapabilityWindow {
  readonly devicePixelRatio?: number;
  readonly navigator?: { readonly maxTouchPoints?: number; readonly hardwareConcurrency?: number };
  matchMedia?(query: string): { readonly matches: boolean };
  readonly AudioContext?: unknown;
  readonly webkitAudioContext?: unknown;
}

const matches = (win: CapabilityWindow, query: string): boolean =>
  win.matchMedia?.(query).matches ?? false;

export function detectCapabilities(win: CapabilityWindow): DeviceCapabilities {
  return {
    pixelRatio: win.devicePixelRatio ?? 1,
    touch: (win.navigator?.maxTouchPoints ?? 0) > 0,
    coarsePointer: matches(win, '(pointer: coarse)'),
    reducedMotion: matches(win, '(prefers-reduced-motion: reduce)'),
    webAudio: win.AudioContext !== undefined || win.webkitAudioContext !== undefined,
    hardwareConcurrency: win.navigator?.hardwareConcurrency ?? 1,
  };
}
