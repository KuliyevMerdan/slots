// @slot/game-math — reel strips, paytable, the payline evaluator, and (since R1) the outcome
// engine: the seeded PRNG and the stops-first derivation both servers draw from.
//
// The math is configuration, not code: strips, paylines and the paytable are plain arrays that the
// server ships in GameConfig and this package knows how to read. On the *client*, nothing here
// decides an outcome — the server's `stops[]` does (ADR-0001); the client imports the evaluator to
// highlight and to re-check, never `outcome.ts`. On the server side there is exactly one
// implementation of drawing and paying a grid, which is the only reason the published RTP and the
// contract suite's cross-server assertions mean anything.

export * from './symbols.js';
export * from './paylines.js';
export * from './paytable.js';
export * from './strips.js';
export * from './view.js';
export * from './evaluate.js';
export * from './config.js';
export * from './prng.js';
export * from './outcome.js';
