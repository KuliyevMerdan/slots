// @slot/ui — the Pixi control surface: the spin button, the bet selector and the HUD.
//
// It takes a view model, never an engine: `ui → protocol, money` is the entire dependency list, so
// nothing in here knows what a phase is. The client maps engine state onto `PanelView`, which is
// what keeps the interruption contract in the engine — where it is tested — instead of in a button.
//
// Two rules hold everywhere in this package: **the HUD never computes money** (every number it shows
// arrived from the server), and the stake can only ever be one of `GameConfig.betLevels`.

export * from './theme.js';
export * from './button.js';
export * from './bet-selector.js';
export * from './hud.js';
export * from './panel.js';
