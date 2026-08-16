# ADR-0001 — Server-authoritative outcomes

- **Status:** accepted
- **Date:** 2026-08-16
- **Applies to:** the whole repository. Every other decision is downstream of this one.

## Context

A slot client renders an outcome worth money. There are two ways to build one:

1. The client rolls the outcome and tells the server what happened.
2. The server commits to the outcome and the client presents it.

(1) is simpler, and it is how a toy is built: the reels decide, the balance follows. It is also
unshippable in this industry — the outcome would be decided on a machine the operator does not
control, in code any player can read and modify, with no audit trail a regulator would accept.

This project is a portfolio piece aimed at a slots studio, so the architecture is itself the
deliverable. Getting this wrong makes every other good decision irrelevant.

## Decision

**The client never decides outcomes. It presents an outcome the server already committed to.**

Concretely:

- `stops[]` — the strip index each reel lands on — comes from the server and is the authority. The
  grid, the wins and the total are derived from it, and the server sends those too.
- The client ships the paytable, because it needs it to highlight paylines and sequence win
  animations. **Presentation logic, not authority.** It never uses the paytable to decide what
  happened, what a win is worth, or what the balance is.
- The client never computes a balance. Every response carries the authoritative balance after the
  operation it describes ([`docs/protocol.md`](../protocol.md) §1).
- In dev builds (`__ASSERT_MATH__`) the client re-evaluates the server's grid with its local paytable
  and asserts the win set matches. A mismatch is a loud console error, not a silent correction.
- The seam is `RgsTransport` in `packages/transport`. `MockTransport` (in-process simulator),
  `HttpTransport` (the simulator over HTTP today, a real Node RGS later) differ by configuration —
  not by a single line of client code.

## Consequences

**Good**

- Swapping the simulator for a real RGS is a config change. The contract suite runs the same tests
  against all three targets, which is what makes that claim checkable rather than rhetorical.
- Network failure becomes a presentation problem, not a money problem: `roundId` is client-generated
  and idempotent, so a retry after a timeout is provably the same round.
- The dev-build assertion turns a whole class of math-drift bug into a console error during
  development instead of a support ticket.

**Costs, accepted**

- The reels start spinning before the outcome is known, so the spin animation must be designed
  around a server round trip that can be slow or fail. That is a real constraint on the renderer and
  it is why the deceleration stage takes a target that arrives late.
- Presentation duplicates knowledge that also lives on the server (the paytable), which is exactly
  the drift the `__ASSERT_MATH__` check exists to catch.
- A win must be presented before it is credited, which is why settlement is an explicit call
  ([`docs/protocol.md`](../protocol.md) §11, D1).

## Alternatives rejected

- **Client-authoritative with server validation.** The server would have to re-run the round anyway
  to validate it, so the client's authority buys nothing and costs the audit trail.
- **Server-rendered outcomes (video/stream).** Kills the feel, the responsiveness, and the point of
  a Pixi client.
- **Trusting the client "just for the mock".** The mock is the spec — a shortcut here would be a
  shortcut in the real thing, and the seam would quietly stop being real.
