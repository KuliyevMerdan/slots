// @slot/compliance — jurisdiction rules applied at runtime, as pure functions of an injected clock.
//
// The rules themselves travel on the wire (`GameConfig.jurisdictionRules`, docs/protocol.md §2.1,
// D8): the server declares what the regime requires, enforces the half it can observe (spin
// cadence), and this package is how the client applies the rest — pacing the button, scheduling the
// reality check, tracking the player's own limits, and deciding when an autoplay run must stop.
//
// Everything here takes `now` as an argument. A reality check or a session limit is a pure function
// of an injected clock, or it is untestable — which is why this package sits in PURE_PACKAGES and
// `Date.now()` is a lint error inside it.

export * from './pacing.js';
export * from './reality.js';
export * from './limits.js';
export * from './autoplay.js';
