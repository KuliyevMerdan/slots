// @slot/platform — everything the browser makes awkward, behind one boring interface.
//
// Audio synthesized at boot (the atlas decision applied to sound — no binary, no licence), tab
// visibility, storage that cannot throw, safe-area insets and device capability detection. Every
// module takes its browser object as an argument (the ADR-0003 shape), which is why the whole
// package tests headless in Node. No Pixi, no game state — the dependency table's rule, kept.

export * from './audio.js';
export * from './visibility.js';
export * from './storage.js';
export * from './safe-area.js';
export * from './capabilities.js';
