# ADR-0003 — The simulator persists through an injected port, never through a global

- **Status:** accepted
- **Date:** 2026-08-18
- **Applies to:** `@slot/rgs-sim`, and every later consumer that wires it up (`apps/game-client`,
  `apps/mock-rgs`, `tools/math-sim`).

## Context

Block S0 asks for a persistence adapter with **two implementations: in-memory (Node) and
`localStorage` (browser)**, so that a page reload genuinely resumes a round rather than quietly
handing the player a fresh balance.

That requirement collides with the rule that makes `rgs-sim` worth having. The package is pure:
`localStorage` is a lint error inside it, `Storage` is not even in its type environment (the base
tsconfig ships no `DOM` lib), and the dependency-cruiser rule `rgs-sim-is-headless` fails CI on any
browser or I/O import. Those rules are not decoration — they are why the same outcome engine can
serve the browser dev loop, an HTTP server and a fifty-million-spin batch job.

So a reviewer opening this package to find the "`localStorage` implementation" will not find the
word `localStorage` anywhere in it. This ADR is why.

## Decision

**The port is a synchronous string store, and the browser implementation receives the storage object
as a constructor argument.**

```ts
export interface SimStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/** The shape of `localStorage`, declared structurally rather than imported. */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
```

`InMemoryStore` is the Node/test implementation. `WebStorageStore` is the browser one, and the
wiring site writes `new WebStorageStore(localStorage)` — outside the pure package, where the global
is legal.

The sim depends on **three method signatures**, not on the platform that provides them. Both
implementations live in `rgs-sim`; only the global crosses the boundary, and it crosses it as an
argument.

Two supporting decisions came with it:

- **The envelope, the version and the discard rule are `@slot/protocol`'s**, not the sim's. Saved
  state goes through `persist()` / `readPersisted()` and `PERSISTENCE_SCHEMA_VERSION`, so the
  simulator's local payload and the client's obey one policy rather than two similar ones.
- **`WebStorageStore` swallows storage exceptions.** `localStorage` throws on a full quota and in
  Safari's private mode. The local copy is an optimisation — `authenticate` re-reads the
  authoritative state either way — so the correct failure mode is "stops resuming across reloads",
  not "throws on spin 5,000".

## Consequences

**Good**

- The browser adapter is unit-testable in Node, against a fake, with no jsdom and no environment
  switch. `store.test.ts` also proves the hostile case: a storage that throws on every call.
- The purity rules stay absolute. There is no "except for persistence" clause for a reviewer to
  discover, and no exemption in `eslint.config.mjs` or `.dependency-cruiser.cjs`.
- The same seam accepts anything key-shaped later — `sessionStorage`, an Electron store, a test
  double that simulates a quota — without touching the sim.

**Costs, accepted**

- One wiring line the caller must not forget. A `SimServer` built without a `store` silently defaults
  to memory and therefore does not survive a reload; that is the right default for Node and the
  wrong one for the browser, and it is the client's job (C3) to pass the real store.
- "Two implementations" is true in a slightly different sense than the roadmap's phrasing implied —
  hence this document.

## Alternatives rejected

- **Reach for the `localStorage` global behind a `typeof` guard.** The ordinary approach, and it
  costs the `DOM` lib, an eslint exemption and a dependency-cruiser exemption — three holes in the
  enforcement story to save one constructor argument.
- **Put the browser adapter in `@slot/platform`.** Defensible, and it splits one small port across
  two packages while `platform` itself does not exist until C6. The sim would ship a persistence
  interface with no working browser implementation for four blocks.
- **Make the port asynchronous (`Promise`-returning).** Correct for IndexedDB and wrong for this:
  it would turn every pure handler into an async function and take the entire simulator with it,
  buying nothing that a 5 MB synchronous store does not already provide.
