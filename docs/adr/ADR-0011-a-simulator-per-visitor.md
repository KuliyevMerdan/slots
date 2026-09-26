# ADR-0011 — The public demo is a simulator per visitor; the simulator stays single-session

**Date:** 2026-09-26 · **Block:** C8 · **Status:** accepted

## Context

`@slot/rgs-sim` is single-session by design: one token, one balance, one `pendingRound`, and
`issueSession` *renews* that session rather than minting another — which is what makes the §5
mid-round expiry recoverable in the dev loop. `apps/mock-rgs` put one such simulator on a socket.
On `localhost` that is one developer.

The C8 deploy (ADR-0010, `render.yaml`) puts the same process on a public URL, where it made every
visitor the same player: a shared wallet, one visitor's open feature resumed in another's browser,
`ROUND_CONFLICT` and `LIMIT_REACHED` between strangers pressing at once, and one visitor's
`/dev/faults` or EXPIRE landing on everybody. Nothing about it was wrong for a development server;
all of it was wrong for a demo a stranger opens while someone else is playing.

## Decision

**The multiplicity lives in the app, not the simulator.** `apps/mock-rgs` holds a `SessionPool`
(`src/sessions.ts`): the lobby (`POST /demo/session`) begins a separate `SimServer` for each
visitor, and every call reaches the one its token names — `authenticate` by the token in its body,
every other call and every `/dev/*` route by the bearer header `HttpTransport` already carries
(§2.7). Five rules:

- **A named session is renewed, anything else is a new visitor.** The lobby takes an optional
  `{ token }`; a token the pool holds is renewed exactly as before (same balance, same
  `pendingRound`), so a reload and the §5 renewal find their round. A token it no longer holds —
  the server restarted, or the visitor idled out — is answered with a fresh session, not an error.
- **The client remembers its token per tab** (`sessionStorage`): a reload names it, a new tab is a
  new player rather than one player racing themselves.
- **Bounded memory.** Visitors idle for `MOCK_RGS_SESSION_IDLE_MINUTES` are forgotten, and at
  `MOCK_RGS_MAX_SESSIONS` the longest-idle makes room. Forgetting loses play money and at worst a
  round abandoned for longer than the window — what a restart of the demo loses anyway.
- **Tokens are minted at random; seeds are derived.** A visitor's seed is the server seed plus
  their ordinal, so a pinned `MOCK_RGS_SEED` still replays the whole server; their token is a UUID,
  because a token derived from a readable seed would let a stranger play someone else's session.
- **The resident stays.** The simulator the app is built with is pinned in the pool and is what a
  call *without* a credential reaches — the tests, the contract suite's HTTP target, a developer's
  `curl` with the printed token. Without a visitor policy the lobby renews the resident, so the
  single-session development server is exactly what it was.

## Alternatives rejected

- **Multi-session `rgs-sim`.** A second session model inside the reference semantics every target
  is measured against, for a need only the deployment has — and the contract suite would be
  testing the multiplexing instead of the protocol. The pool is a hundred lines beside it instead.
- **Deploy `apps/rgs` as the demo.** It is multi-session since R5, but it needs Postgres and a
  wallet, and it refuses `forceOutcome` always — the demo's exhibit is forcing a max win.
- **Refuse a credential-less call.** What `apps/rgs` does, and correct there. Here it would break
  every suite that drives the resident by `app.inject()` for no player-visible gain: a hand-built
  call without a token reaches a session no visitor plays.
- **`localStorage` for the token.** Two tabs would share one session and conflict with each other,
  which is the bug this ADR removes, reintroduced one person at a time.

## Consequences

- Two strangers at the live URL are two players; the E2E suite proves it with two browser
  contexts on the deployed composition, and `app.test.ts` pins isolation of wallets, open rounds
  and the debug surface.
- An unknown credential is `SESSION_EXPIRED` on both the game and the debug routes — the one
  answer a client already recovers from.
- A visitor's debug panel acts on that visitor alone; the resident's `/dev/*` remains open to a
  tokenless call, harmless because no visitor plays the resident.
