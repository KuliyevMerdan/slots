// @slot/rgs-sim — the mock server core: pure, deterministic, one round machine behind two paths.
//
// `(state, request) → (state, response)` with no HTTP, no fs and no clock of its own. That purity
// is what lets one implementation serve the in-process dev loop and the HTTP path
// (`apps/mock-rgs`) at once. The outcome engine itself — the seeded PRNG and the stops-first
// derivation — lives in `@slot/game-math` since R1, shared with `apps/rgs` and the RTP report
// (`tools/math-sim`); what this package owns is everything around it: the round machine, the
// idempotency store, the session, the faults.
//
// The wire contract it implements is docs/protocol.md; the round machine is §3, idempotency is §4,
// recovery is §5.

export * from './store.js';
export * from './state.js';
export * from './config.js';
export * from './scenarios.js';
export * from './faults.js';
export * from './errors.js';
export * from './sim.js';
export * from './server.js';
