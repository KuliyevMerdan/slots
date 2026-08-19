// @slot/rgs — the real RGS, laid out before it is built (R0).
//
// The structure is the architecture: `http` binds the shared contract to Fastify and answers
// `NOT_IMPLEMENTED` from a domain that is not there yet; `domain` is the round lifecycle R1
// fills; `wallet` is the operator↔provider seam (interface real, `MockWallet` working); `ledger`,
// `rng` and `persistence` declare what R3, R4 and R1 must satisfy; `math` re-exports
// `@slot/game-math` because a server with its own copy of the paytable is a drift incident with a
// version number. The contract suite runs against this server from day one — expected-red, every
// failure `NOT_IMPLEMENTED` and nothing else — and the R-blocks turn it green endpoint by
// endpoint without touching a line of client code.

export * from './http/app.js';
export * from './http/errors.js';
export * from './errors.js';
export * from './config.js';
export * from './domain/rounds.js';
export * from './wallet/provider.js';
export * from './wallet/mock.js';
export * from './ledger/ledger.js';
export * from './rng/seeds.js';
export * from './persistence/repositories.js';
