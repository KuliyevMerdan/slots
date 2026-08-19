# ADR-0007 — Sessions live in Postgres (or memory), not Redis

**Date:** 2026-08-19 · **Block:** R5 · **Status:** accepted

## Context

The roadmap wrote "session store (Redis)" back when R5 was a plan, because that is the reflexive
industry answer: sessions are ephemeral, Redis is where ephemeral things go. By the time R5 was
built, the codebase had a settled pattern for state a server must not lose — a port with an
in-memory twin and a Postgres twin, one contract suite over both, the Postgres half run by CI
against a service container (`RoundStore` since R1, `Ledger` since R3). Sessions needed a store;
the question was whether they justified a **second infrastructure**.

## Decision

They do not. `SessionStore` is the smallest port in the codebase — `find` and `put`, latest write
wins — with `MemorySessionStore` and `PostgresSessionStore` (`migrations/0004_sessions.sql`, one
`sessions` table, upsert on token) held to one contract, sharing the pool the rounds and the
ledger already use. Expiry is a timestamp the domain compares against its injected clock, not a
TTL the store enforces — so the store stays dumb, and "expired" stays distinguishable from "never
issued" in the server's own records even though both refuse identically on the wire.

## Consequences

- **One database, one deploy, one CI container.** A demo-scale RGS with three stores in Postgres
  is operable by one person; the same RGS with Postgres *and* Redis is a second failure mode, a
  second health check and a second thing to explain, purchased to serve tens of sessions.
- **A restart keeps sessions.** The token in a client's hand still names a session after a
  deploy, so resume is the ordinary §5 path — arguably *better* than the Redis default, where
  persistence is the thing you configure carefully or lose.
- **The port is where Redis goes** if scale ever demands it: `find`/`put` is exactly the surface
  a Redis adapter implements in an afternoon, and the contract suite is already written. The
  decision reverses cheaply, which is the property that makes it safe to take now.

*Rejected:* Redis anyway, "because production will want it". This repository's rule is that
infrastructure earns its place by a test or a property, not by résumé convention — and every
property R5 needs (upsert semantics, survival across restart, CI enforcement) is one Postgres
already provides.
