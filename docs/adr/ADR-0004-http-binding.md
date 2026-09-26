# ADR-0004 — The HTTP binding: one route per call, and a dropped response is a silent socket

- **Status:** accepted
- **Date:** 2026-08-18
- **Applies to:** `apps/mock-rgs`, `@slot/transport`'s `HttpTransport`, `@slot/protocol`, and
  `apps/rgs` when it lands (R0).

## Context

Block S2 puts the simulator behind a socket. The protocol (`docs/protocol.md`) pins the four calls,
their payloads and the error taxonomy, but says nothing about HTTP — deliberately, because the shapes
are the contract and the binding is a detail. It is a detail two independent implementations have to
agree on exactly: `HttpTransport` in the client, `apps/mock-rgs` today, `apps/rgs` later, and the
contract suite (S3) that runs one suite against all of them.

The awkward part is not the happy path. It is the fault model. `@slot/rgs-sim` decides faults as
data — `PASS` / `FAIL` / `DROP` plus a delay — because a pure package can neither sleep nor hang, and
`MockTransport` enacts that in-process: a `DROP` becomes a promise that never settles. The HTTP
server has to enact the same verdicts on a real connection, and a **dropped response has no HTTP
representation**. Every obvious encoding of it — a 500, a 504, closing the socket — is a *different*
failure with different client behaviour.

## Decision

**1. One route per call, `POST /rgs/<call>`, generated from the `CALLS` table.**

`HTTP_ROUTE_PREFIX` and `routeFor()` live in `@slot/protocol` beside `CALLS`, so the client builds
its path and the server registers its routes from one definition. Everything is `POST`, including
the read-only `authenticate`: the token belongs in a body, not in a query string that lands in every
access log between here and the operator.

**2. The status code is for operators; the body is for the client.**

The client branches on the error `class`, which `SlotError` derives from the `code`, which is in the
body — never on the status. The status exists so a proxy log, a health rule or a `curl` says
something true. `STATUS_OF_CODE` maps every code in the taxonomy and is declared
`satisfies Record<ErrorCode, number>`, so a new protocol error cannot be added without someone
deciding what it looks like on the wire. `PLAYER` errors are `422` rather than `400`: nothing was
malformed, the request was understood and refused.

**3. A dropped response is a hijacked reply — the connection is held open and says nothing.**

`reply.hijack()` tells Fastify to stop managing a response it will never send. The socket is tracked
so shutdown can destroy it; otherwise `close()` waits on a connection that is, by construction,
waiting forever.

This is the honest model. The round *happened* — the stake was debited, the outcome is stored — and
the client's own timeout is what ends the wait, exactly as it does in-process. Turning it into a
status code would mean the server telling the client something the network never told it.

**4. The correlation id is the HTTP request's, and the simulator's goes in the log beside it.**

`x-correlation-id` in both directions: the client mints one, the server adopts it (or mints a uuid
when there is none) and echoes it on every response. The simulator's own `sim-000042` ids are derived
from its call counter so that a replayed seed replays its ids — valuable, and *not* unique across
sessions, so it is a log field rather than the value in the error body.

**5. `/dev/*` is fault injection, reset and a state summary; `/demo/session` is not dev-gated.**

The debug panel (C7) and the contract suite (S3) both need to *demand* a specific failure rather than
wait for one. `/demo/session` stands in for the operator's lobby (docs/protocol.md §7) and stays
mounted regardless, because a server you cannot obtain a token for is not a server. `apps/rgs` will
have neither. (Since C8 both are scoped to the caller's session — one simulator per visitor,
ADR-0011.)

## Consequences

**Good**

- `tests/http.test.ts` plays the same round through `MockTransport` and `HttpTransport` against two
  simulators seeded identically and asserts the responses are **equal, field for field**. "Swap the
  transport URL" is now a tested statement rather than an architectural intention.
- The drop fault is exercisable over a real socket: the spin lands, the answer never arrives, the
  retry policy's clock ends the wait and the same `roundId` goes back out to be replayed. That is the
  scenario the whole idempotency design exists for, and it now has an end-to-end producer.
- `apps/rgs` (R0) inherits the binding for free — same routes, same statuses, same header — which is
  what makes the contract suite able to run against it unmodified.

**Costs, accepted**

- Hijacked sockets are a resource the server must remember to reclaim. It is one `onClose` hook and
  one `Set`, and it is tested (`app.close()` resolves while a request is deliberately hanging).
- The status mapping is a second place where an error code has to be *listed*. The `satisfies`
  clause turns "someone forgot" into a compile error, which is the cheapest form of this problem.

## Alternatives rejected

- **One endpoint with a `call` field in the body.** Fewer routes, and it throws away everything HTTP
  already gives you: a route in a log, a status in a dashboard, a proxy rule per call.
- **Encode a dropped response as a 504.** Simpler, and wrong: a 504 is an answer. The client would
  learn — instantly, and from the server — something a dropped connection never tells it, and the
  timeout path the retry policy exists to exercise would go untested.
- **`GET` for `authenticate`.** It is read-only, so it is defensible. It also puts a session token in
  a URL, which is how tokens end up in access logs, browser history and referrer headers.
- **Let the HTTP layer validate requests before the simulator does.** It would move validation into
  the transport-specific half, where `apps/rgs` and the in-process path could then disagree. The
  simulator validates with the same `@slot/protocol` schema either way; Fastify's JSON parser
  rejecting a malformed body is classified into the same `SCHEMA_MISMATCH` the simulator would have
  produced.
