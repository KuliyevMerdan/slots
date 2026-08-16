// FIXTURE — must be rejected by `engine-deps`: the engine emits events, it never reaches into the renderer.
import { ReelController } from '@slot/renderer';

export const leak = ReelController;
