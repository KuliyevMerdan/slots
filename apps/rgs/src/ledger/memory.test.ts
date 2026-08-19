import { runLedgerContract } from './ledger-contract.js';
import { MemoryLedger } from './memory.js';

// The reference implementation: this run *defines* the semantics the Postgres twin is held to.
runLedgerContract('in memory', () => Promise.resolve(new MemoryLedger()));
