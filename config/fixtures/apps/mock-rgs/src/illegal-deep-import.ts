// FIXTURE — must be rejected by `apps-import-entry-points-only`: an app reaches a package through
// its entry point, exactly as a package does.
import { SpinReq } from '../../../packages/protocol/src/spin';

export const leak = SpinReq;
