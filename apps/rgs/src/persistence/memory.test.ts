import { MemoryRoundStore } from './memory.js';
import { runStoreContract } from './store-contract.js';

// Eviction included: the retention semantics live in the shared contract since R7, so the memory
// twin and Postgres are held to one rule rather than each to its own test.
runStoreContract('in memory', (options) => Promise.resolve(new MemoryRoundStore(options)));
