// @slot/protocol — the single source of truth for anything that crosses the wire.
//
// The contract, its reasoning and its rejected alternatives are in docs/protocol.md. When the wire
// changes, change that document and this package **first** — then the simulator, then the engine,
// then the UI. Both sides validate against these same schemas, so a drift is a test failure rather
// than a production surprise.

export * from './primitives.js';
export * from './errors.js';
export * from './config.js';
export * from './round.js';
export * from './fairness.js';
export * from './calls.js';
export * from './persistence.js';
