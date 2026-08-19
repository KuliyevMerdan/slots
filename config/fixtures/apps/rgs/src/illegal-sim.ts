// FIXTURE — must be rejected by `rgs-deps`: the real RGS does not lean on the simulator it exists
// to replace. If it did, the contract suite's third target would be a disguised rerun of the first.
import { SimServer } from '@slot/rgs-sim';

export const leak = SimServer;
