// @slot/money — integer minor units, behind a branded type.
//
// The brand itself lives in @slot/protocol, because a value validated at the wire boundary has to
// arrive already branded (ADR-0002). This package owns everything you then *do* with it: exact
// arithmetic, and the single formatting seam at the edge of the UI.

export type { Minor } from '@slot/protocol';

export * from './minor.js';
export * from './format.js';
