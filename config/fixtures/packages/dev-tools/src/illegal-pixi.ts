// FIXTURE — must be rejected by `pixi-stays-in-renderer-and-ui`: the debug panel is DOM, not
// canvas. renderer and ui are the only Pixi consumers in the workspace.
import { Application } from 'pixi.js';

export const leak = Application;
