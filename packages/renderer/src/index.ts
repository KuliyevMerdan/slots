// @slot/renderer — the Pixi layer: the atlas, the reels, the spin curve and the stage that wires
// them to the engine's events.
//
// Two rules shape everything in here. **The engine emits and the renderer subscribes** — nothing
// here decides an outcome, and the only inputs travelling back are the two facts a renderer owns
// (the reels stopped, the presentation finished). And **the ticker allocates nothing**: sprites are
// pooled at boot, the symbol atlas is one texture, and motion blur is a texture swap rather than a
// filter.
//
// The spin curve is pure and lives in curve.ts, which is why the feel of the reels has tests at all.

export * from './theme.js';
export * from './curve.js';
export * from './atlas.js';
export * from './reel.js';
export * from './reels.js';
export * from './timeline.js';
export * from './tiers.js';
export * from './win-presentation.js';
export * from './stage.js';
