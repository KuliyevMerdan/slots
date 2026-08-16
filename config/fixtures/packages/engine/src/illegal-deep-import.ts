// FIXTURE — must be rejected by `no-cross-package-deep-imports`.
import { SpinReq } from '../../protocol/src/spin';

export const leak = SpinReq;
