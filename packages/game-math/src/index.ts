// @slot/game-math — reel strips, paytable and the payline evaluator, as pure functions over data.
//
// The math is configuration, not code: strips, paylines and the paytable are plain arrays that the
// server ships in GameConfig and this package knows how to read. Nothing here decides an outcome —
// the server's `stops[]` does (ADR-0001). This is what draws the highlight and what a dev build
// re-evaluates to catch drift.

export * from './symbols.js';
export * from './paylines.js';
export * from './paytable.js';
export * from './strips.js';
export * from './view.js';
export * from './evaluate.js';
export * from './config.js';
