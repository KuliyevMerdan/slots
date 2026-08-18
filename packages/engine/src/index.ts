// @slot/engine — headless round orchestration and the round FSM. No Pixi, no DOM, no network.
//
// The FSM in reduce.ts is pure and total: `(state, input) → (state, events, effects)`, with a switch
// TypeScript proves covers every phase. SlotEngine is the thin shell that performs the effects
// through an injected port and publishes the events a renderer subscribes to.
//
// The engine decides that an interruption is legal; the renderer implements it by completing its
// timelines. Keeping that split is why the interruption contract is testable at all.

export * from './types.js';
export * from './reduce.js';
export * from './engine.js';
