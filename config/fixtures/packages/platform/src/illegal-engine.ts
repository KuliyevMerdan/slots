// FIXTURE — must be rejected by `platform-deps`: platform wraps browser APIs behind ports and
// needs no game knowledge. A platform layer that reads the engine is a second wiring site.
import { SlotEngine } from '@slot/engine';

export const leak = SlotEngine;
