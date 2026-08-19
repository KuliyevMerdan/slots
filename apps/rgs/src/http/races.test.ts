import { MemoryLedger } from '../ledger/memory.js';
import { MemoryRoundStore } from '../persistence/memory.js';
import { runRaceSuite } from './races-contract.js';

// The memory twins take the races on every run; `postgres.test.ts` runs the same suite against
// the database (in CI on every push), where the same races land on real row locks.
runRaceSuite('in memory', () =>
  Promise.resolve({ store: new MemoryRoundStore(), ledger: new MemoryLedger() }),
);
