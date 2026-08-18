import { CONTRACT_TARGETS } from './targets.js';
import { runContractSuite } from './suite.js';

/**
 * `pnpm test:contract` — the same suite, run against every registered target.
 *
 * The whole file is three lines because that is the claim: nothing here knows which server it is
 * talking to. A target is a transport plus a control plane (`targets.ts`), the contract is one suite
 * (`suite.ts`), and adding `apps/rgs` in R0 is adding an entry to a list.
 *
 * It runs in its own Vitest project rather than alongside the root suites: those are unit-ish and
 * fast, and this one stands up servers and plays hundreds of rounds through them. Keeping the gate
 * separately runnable is also what lets R0 point it at an expected-red target without turning the
 * everyday `pnpm test:root` red.
 */
for (const target of CONTRACT_TARGETS) runContractSuite(target);
