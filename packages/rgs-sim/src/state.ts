import { z } from 'zod';
import type { Minor, ProtocolErrorPayload, RoundId } from '@slot/protocol';
import {
  FeatureProgressSchema,
  FeatureSpinResSchema,
  NonNegativeMinorSchema,
  PositiveMinorSchema,
  RoundIdSchema,
  RoundStateSchema,
  SessionSchema,
  SettleResSchema,
  SpinResSchema,
  TimestampSchema,
  persist,
  readPersisted,
} from '@slot/protocol';
import { hashSeed } from './prng.js';
import type { SimStore } from './store.js';

/**
 * The simulator's whole world, as one serialisable value.
 *
 * Defined as a zod schema whose inferred type *is* the exported type — the same discipline
 * `@slot/protocol` applies to the wire, applied here to the disk. It matters for the same reason:
 * this payload is read back from `localStorage` after a reload, which is untrusted input no matter
 * who wrote it.
 *
 * `GameConfig` is deliberately **not** in here. It is supplied at construction, so changing the
 * paytable takes effect on the next boot rather than being pinned by a stale saved session.
 */

/**
 * One round, plus the responses it has already produced.
 *
 * An idempotency store keeps the **response**, not merely the key — that is what lets a duplicate
 * `spin` replay the original bytes rather than re-deriving something that might disagree. Real
 * gaming servers store exactly this, for exactly this reason.
 */
const SimRoundSchema = z.object({
  roundId: RoundIdSchema,
  state: RoundStateSchema,
  stake: PositiveMinorSchema,
  clientSeed: z.string().optional(),
  /** Canonical form of the originating `spin` request — a differing duplicate is `ROUND_CONFLICT`. */
  fingerprint: z.string(),
  /** Base win plus every free spin so far, **already capped**. Uncredited until `settle`. */
  cumulativeWin: NonNegativeMinorSchema,
  /** Whether `stake × maxWinMultiplier` has clipped this round. Sticky once true. */
  capped: z.boolean(),
  openedAt: TimestampSchema,
  spin: SpinResSchema,
  /** Free-spin responses in step order: index `n` is step `n + 1`. */
  steps: z.array(z.object({ fingerprint: z.string(), response: FeatureSpinResSchema })),
  feature: FeatureProgressSchema.optional(),
  settle: SettleResSchema.optional(),
});

export type SimRound = z.infer<typeof SimRoundSchema>;

export const SimStateSchema = z.object({
  /**
   * Every spin seed derives from this. Secret in principle — it never crosses the wire, and R4
   * turns it into a committed/revealed value rather than a constructor argument.
   */
  serverSeed: z.string().min(1),
  /** The opaque token `authenticate` accepts. A demo stand-in for the operator's lobby (§7). */
  token: z.string().min(1),
  session: SessionSchema,
  balance: NonNegativeMinorSchema,
  /** Oldest first. Bounded — see `MAX_ROUND_HISTORY`. */
  rounds: z.array(SimRoundSchema),
  /**
   * Monotonic call counter. It is where correlation ids come from: a pure package cannot mint a
   * uuid, and a replayed session should produce replayed ids anyway.
   */
  seq: z.int().min(0),
});

export type SimState = z.infer<typeof SimStateSchema>;

/**
 * How many finished rounds to keep for idempotent replay.
 *
 * Unbounded history is the obvious implementation and the wrong one here: the browser store has a
 * ~5 MB quota, a round record is a kilobyte or two, and an autoplay session reaches five thousand
 * spins without trying. Only `SETTLED` rounds are ever evicted, so the in-flight round and the
 * recovery story are untouched — a real RGS keeps this in Postgres for days instead (R1).
 */
export const MAX_ROUND_HISTORY = 50;

/** The result of any handler: pure, total, and carrying the state forward either way. */
export type SimOutcome<T> =
  | { readonly ok: true; readonly state: SimState; readonly response: T }
  | { readonly ok: false; readonly state: SimState; readonly error: ProtocolErrorPayload };

/**
 * A demo token, derived from the server seed but not revealing it.
 *
 * Stands in for the operator lobby's `POST /demo/session` (docs/protocol.md §7). It is a dev
 * affordance, not part of the game contract: `apps/rgs` replaces it with real session validation
 * in R5.
 */
export const mintDemoToken = (serverSeed: string): string =>
  `demo-${hashSeed(serverSeed).toString(16).padStart(8, '0')}`;

export interface SimStateOptions {
  /** Fixes the entire session's outcome sequence. The same seed replays it identically. */
  serverSeed: string;
  balance: Minor;
  /** Epoch ms, from the caller's clock. */
  expiresAt: number;
  token?: string;
  playerId?: string;
  currency?: string;
}

export const createSimState = ({
  serverSeed,
  balance,
  expiresAt,
  token = mintDemoToken(serverSeed),
  playerId = 'demo-player',
  currency = 'EUR',
}: SimStateOptions): SimState => ({
  serverSeed,
  token,
  session: { playerId, currency, expiresAt },
  balance,
  rounds: [],
  seq: 0,
});

export const findRound = (state: SimState, roundId: RoundId): SimRound | undefined =>
  state.rounds.find((round) => round.roundId === roundId);

/** The one round `authenticate` reports as pending. At most one is ever in flight. */
export const findOpenRound = (state: SimState): SimRound | undefined =>
  state.rounds.find((round) => round.state !== 'SETTLED');

/** Replace a round in place, or append it, and evict finished history down to the cap. */
export const withRound = (state: SimState, round: SimRound): SimState => {
  const known = state.rounds.some((existing) => existing.roundId === round.roundId);
  const rounds = known
    ? state.rounds.map((existing) => (existing.roundId === round.roundId ? round : existing))
    : [...state.rounds, round];

  const settled = rounds.filter((entry) => entry.state === 'SETTLED');
  const excess = settled.length - MAX_ROUND_HISTORY;
  if (excess <= 0) return { ...state, rounds };

  const evicted = new Set(settled.slice(0, excess).map((entry) => entry.roundId));
  return { ...state, rounds: rounds.filter((entry) => !evicted.has(entry.roundId)) };
};

/* ── persistence ──────────────────────────────────────────────────────────────────────────────
 * The envelope, the version and the discard rule all come from `@slot/protocol`, so the sim's
 * saved state and the client's obey one policy rather than two similar ones.
 */

export const saveState = (store: SimStore, key: string, state: SimState, now: number): void => {
  store.write(key, JSON.stringify(persist(state, now)));
};

/**
 * Read the saved session, or `null`.
 *
 * `null` covers every failure indistinguishably — absent, corrupt, or written by an older schema
 * version — because the caller's response to all three is the same: start fresh and let
 * `authenticate` re-establish the truth. There is no repair path, on purpose.
 */
export const loadState = (store: SimStore, key: string): SimState | null =>
  readPersisted(store.read(key), SimStateSchema);
