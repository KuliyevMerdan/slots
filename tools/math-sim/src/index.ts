// @slot/math-sim — the RTP report, over the same math the game plays on.
//
// `simulate()` drives `@slot/rgs-sim`'s outcome derivation across `@slot/game-math`'s strips and
// paytable: same evaluator, same wild and scatter rules, same free-spin awards. There is one
// implementation of the math, which is the only reason the published RTP means anything.
//
// The report prints the design targets beside the results and the CLI exits non-zero when the game
// has drifted out of band — a tuning tool that is also a regression test.

export * from './simulate.js';
export * from './report.js';
