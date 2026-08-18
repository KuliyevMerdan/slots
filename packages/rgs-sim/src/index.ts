// @slot/rgs-sim — the mock server core: pure, deterministic, and the same engine behind all three
// consumers.
//
// `(state, request) → (state, response)` with no HTTP, no fs and no clock of its own. That purity is
// what lets one outcome engine serve the in-process dev loop, the HTTP path (`apps/mock-rgs`) and
// the 50-million-spin RTP report (`tools/math-sim`) — which in turn is why the RTP the README
// publishes is the RTP the game actually plays.
//
// The wire contract it implements is docs/protocol.md; the round machine is §3, idempotency is §4,
// recovery is §5.

export * from './prng.js';
export * from './store.js';
export * from './state.js';
export * from './config.js';
export * from './outcome.js';
export * from './errors.js';
export * from './sim.js';
export * from './server.js';
