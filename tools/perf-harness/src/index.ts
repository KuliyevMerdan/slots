// @slot/perf-harness — scripted fps / draw-call / heap capture for the built client.
// The CLI lives in main.ts (`pnpm perf`); these exports are the arithmetic, for the tests.
export { DROPPED_FRAME_MS, drawStats, frameStats, heapStats, percentile } from './stats.js';
export type { DrawStats, FrameStats, HeapStats } from './stats.js';
export { capture } from './capture.js';
export type { CaptureOptions, CaptureResult } from './capture.js';
export { serveDist } from './serve.js';
export type { StaticServer } from './serve.js';
