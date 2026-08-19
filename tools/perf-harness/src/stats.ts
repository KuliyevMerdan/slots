/**
 * The arithmetic behind the report — pure, and tested, because a perf harness whose percentile is
 * off by one is a harness that tells comfortable lies.
 */

export interface FrameStats {
  /** Frames measured. */
  frames: number;
  /** Wall-clock the frames cover, in ms. */
  totalMs: number;
  avgFps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  worstMs: number;
  /** Frames longer than the drop threshold. */
  dropped: number;
  droppedShare: number;
}

/** A frame past this is a visible hitch at 60 Hz — one and a half budget. */
export const DROPPED_FRAME_MS = 25;

/**
 * Nearest-rank percentile over a copy — the input's order is the capture's, and callers keep it.
 */
export function percentile(durations: readonly number[], share: number): number {
  if (durations.length === 0) return 0;
  const sorted = [...durations].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.ceil((share / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)] ?? 0;
}

export function frameStats(durations: readonly number[]): FrameStats {
  if (durations.length === 0) {
    return {
      frames: 0,
      totalMs: 0,
      avgFps: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      worstMs: 0,
      dropped: 0,
      droppedShare: 0,
    };
  }

  const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
  const dropped = durations.filter((duration) => duration > DROPPED_FRAME_MS).length;

  return {
    frames: durations.length,
    totalMs,
    avgFps: (durations.length / totalMs) * 1000,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    worstMs: Math.max(...durations),
    dropped,
    droppedShare: dropped / durations.length,
  };
}

export interface DrawStats {
  avg: number;
  max: number;
}

export function drawStats(drawsPerFrame: readonly number[]): DrawStats {
  if (drawsPerFrame.length === 0) return { avg: 0, max: 0 };
  const total = drawsPerFrame.reduce((sum, draws) => sum + draws, 0);
  return { avg: total / drawsPerFrame.length, max: Math.max(...drawsPerFrame) };
}

export interface HeapStats {
  startMb: number;
  peakMb: number;
  endMb: number;
}

export function heapStats(samples: readonly number[]): HeapStats {
  if (samples.length === 0) return { startMb: 0, peakMb: 0, endMb: 0 };
  const mb = (bytes: number): number => bytes / (1024 * 1024);
  return {
    startMb: mb(samples[0] ?? 0),
    peakMb: mb(Math.max(...samples)),
    endMb: mb(samples[samples.length - 1] ?? 0),
  };
}
