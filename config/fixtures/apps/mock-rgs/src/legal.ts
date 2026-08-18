// FIXTURE — must be accepted: the wrapper is allowed the contract and the simulator, and nothing else.
import { CALL_NAMES } from '@slot/protocol';
import { SimServer } from '@slot/rgs-sim';

export const allowed = [CALL_NAMES, SimServer];
