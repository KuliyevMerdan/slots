// FIXTURE — must be accepted: the real RGS is allowed the contract, the money and the math.
import { CALL_NAMES } from '@slot/protocol';
import { add } from '@slot/money';
import { MATH_VERSION } from '@slot/game-math';

export const allowed = [CALL_NAMES, add, MATH_VERSION];
