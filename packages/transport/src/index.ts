// @slot/transport — the RgsTransport seam and its implementations.
//
// The client talks to this interface and to @slot/protocol; it never sees a server implementation.
// That is what makes swapping the in-process simulator for a real RGS a change of which object is
// constructed at boot rather than a refactor.
//
// This package may depend on @slot/protocol and nothing else in the workspace, which is why the
// in-process backend arrives as an injected structural interface instead of an import of
// @slot/rgs-sim. Timeout, exponential backoff and error classification live in retry.ts, as a
// decorator both implementations share. HttpTransport is still owed (C2/S2).

export * from './transport.js';
export * from './mock.js';
export * from './retry.js';
