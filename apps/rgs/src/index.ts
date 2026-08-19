// @slot/rgs — the real RGS. R0 laid it out; R1 made it play.
//
// The structure is the architecture: `http` binds the shared contract to Fastify and validates
// before it dispatches; `domain` is the real round lifecycle since R1 — fingerprint idempotency,
// the accrued ceiling, the stranded round §5 describes, over injected ports; `persistence` is the
// RoundStore port with in-memory and Postgres implementations held to one contract suite;
// `wallet` is the operator↔provider seam (`MockWallet` until R2); `rng` derives seeds and owes R4
// its commitment; `ledger` declares what R3 must satisfy; `math` re-exports `@slot/game-math`
// because a server with its own copy of the paytable is a drift incident with a version number.
// The contract suite runs the full wire contract against this server — the same suite that gates
// the simulators — and swapping a client to it is still a base URL, not a refactor.

export * from './http/app.js';
export * from './http/errors.js';
export * from './http/ops.js';
export * from './observability/metrics.js';
export * from './observability/observer.js';
export * from './observability/tracing.js';
export * from './errors.js';
export * from './config.js';
export * from './domain/rounds.js';
export * from './domain/sessions.js';
export * from './domain/sessions-postgres.js';
export * from './domain/fingerprint.js';
export * from './wallet/provider.js';
export * from './wallet/mock.js';
export * from './wallet/remote.js';
export * from './wallet/sim.js';
export * from './wallet/wire.js';
export * from './ledger/ledger.js';
export * from './ledger/memory.js';
export * from './ledger/postgres.js';
export * from './ledger/reconcile.js';
export * from './rng/seeds.js';
export * from './persistence/store.js';
export * from './persistence/memory.js';
export * from './persistence/postgres.js';
export * from './persistence/migrate.js';
