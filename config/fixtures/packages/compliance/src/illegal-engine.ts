// FIXTURE — must be rejected by `compliance-deps`: compliance is jurisdiction rules as data over
// money amounts. It judges what the engine may do; it never drives the engine itself.
import { SlotEngine } from '@slot/engine';

export const leak = SlotEngine;
