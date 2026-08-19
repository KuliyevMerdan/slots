import type {
  CallName,
  Minor,
  PendingRound,
  RoundId,
  RoundState,
  RoundSummary,
} from '@slot/protocol';

/**
 * What R1 puts on Postgres — declared now so the domain is written against repositories from its
 * first line, and so the two hard rules are requirements rather than discoveries:
 *
 * - **The round machine transitions inside a transaction.** `OPEN → RESOLVED → SETTLED`, guarded —
 *   two concurrent settles must collapse to one credit at the database, not in a mutex the second
 *   process never sees.
 * - **Idempotency is a uniqueness constraint, not a remembering service.** The stored response is
 *   keyed `(roundId, step)`; a duplicate insert *fails*, and the failure is what routes the retry
 *   to the recorded answer. A cache that merely usually remembers reintroduces the double debit it
 *   exists to prevent.
 */

export interface StoredRound {
  readonly roundId: RoundId;
  readonly playerId: string;
  readonly state: RoundState;
  readonly stake: Minor;
  /** The payable total so far, already capped — the wire's `roundWin`, accrued (D7). */
  readonly cumulativeWin: Minor;
  readonly capped: boolean;
  /** Free spins played so far. Zero for a base-only round. */
  readonly steps: number;
  readonly openedAt: number;
}

export interface RoundRepository {
  /** Insert an `OPEN` round. A duplicate `roundId` must fail — that failure is the replay path. */
  open(round: StoredRound): Promise<void>;
  find(roundId: RoundId): Promise<StoredRound | undefined>;
  /**
   * Move the round along the machine, atomically, asserting the state it moves *from*. A
   * transition whose precondition no longer holds must fail rather than last-write-win.
   */
  transition(
    roundId: RoundId,
    from: RoundState,
    to: RoundState,
    patch: Partial<StoredRound>,
  ): Promise<void>;
  /** The one round `authenticate` reports, in the wire's own shape — docs/protocol.md §5. */
  pendingFor(playerId: string): Promise<PendingRound | undefined>;
  /** Settled rounds, newest first — the server half of the `history` call. */
  settledFor(playerId: string, limit: number): Promise<readonly RoundSummary[]>;
}

/**
 * The recorded answer to a mutating call, replayed verbatim for a duplicate key. `params` is kept
 * beside it because a duplicate carrying *different* parameters is `ROUND_CONFLICT`, and telling
 * the two apart requires remembering what was originally asked (docs/protocol.md §4).
 */
export interface IdempotencyRecord {
  readonly roundId: RoundId;
  /** 0 for the base spin and the settle; the step number for a free spin. */
  readonly step: number;
  readonly call: CallName;
  readonly params: unknown;
  readonly response: unknown;
}

export interface IdempotencyRepository {
  find(roundId: RoundId, step: number, call: CallName): Promise<IdempotencyRecord | undefined>;
  /** Insert-only. A duplicate key must fail at the store — see the module comment. */
  save(record: IdempotencyRecord): Promise<void>;
}
