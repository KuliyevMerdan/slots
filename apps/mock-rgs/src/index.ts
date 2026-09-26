// @slot/mock-rgs — the simulator over HTTP, and the proof that the transport seam is real.
//
// One core decides everything (`@slot/rgs-sim`); this app enacts its decisions on a socket, exactly
// as `MockTransport` enacts them in-process. The client tells the two apart by a base URL and by
// nothing else — which is the whole claim of the architecture, made testable.
//
// The wire contract is docs/protocol.md; the HTTP binding it implements is §2.6 and
// docs/adr/ADR-0004-http-binding.md.

export * from './app.js';
export * from './config.js';
export * from './errors.js';
export * from './dev.js';
export * from './sessions.js';
