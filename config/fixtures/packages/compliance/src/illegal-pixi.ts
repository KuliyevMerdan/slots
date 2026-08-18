// FIXTURE — must be rejected by `pixi-stays-in-renderer-and-ui` (and by `pure-packages-do-no-io`):
// a reality-check rule that needs a canvas is a rule that cannot be unit-tested.
import { Application } from 'pixi.js';

export const leak = Application;
