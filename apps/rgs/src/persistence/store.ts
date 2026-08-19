import type {
  CallName,
  FeatureProgress,
  Minor,
  RoundId,
  RoundResult,
  RoundState,
} from '@slot/protocol';

/**
 * What R1 puts on Postgres — the round machine's row and the idempotency record, behind one port.
 *
 * R0 declared these as two repositories; building the domain merged them, because the operations
 * that matter are **atomic across both**: resolving a spin transitions the round *and* records the
 * response a duplicate will replay, and if those two can come apart there is a crash window in
 * which a round resolved but its replay evidence does not exist — the double-spin the whole design
 * exists to prevent. So the port's writes are the domain's units of work, and the two hard rules
 * are requirements on any implementation:
 *
 * - **A transition asserts the state it moves from.** `commit` fails with `STALE_TRANSITION` when
 *   the round is no longer in `from` — two concurrent settles must collapse to one credit at the
 *   store, not in a mutex a second process never sees.
 * - **Idempotency is a uniqueness constraint, not a remembering service.** Records are
 *   insert-only, keyed `(roundId, call, step)`; a duplicate insert *fails* (`DUPLICATE_RECORD`),
 *   and that failure is what routes a racing retry to the recorded answer. A cache that merely
 *   usually remembers reintroduces the double debit it exists to prevent.
 */

export interface StoredRound {
  readonly roundId: RoundId;
  readonly playerId: string;
  readonly state: RoundState;
  readonly stake: Minor;
  readonly clientSeed?: string;
  /**
   * The fairness pair bound at open (R4): the seed every step of this round derives from — which
   * is why it must survive a restart — and the commitment published before the bet. The seed is
   * disclosed on the response that closes the round; until then it exists only here.
   */
  readonly serverSeed: string;
  readonly commitment: string;
  /** Canonical form of the originating spin request — a differing duplicate is `ROUND_CONFLICT`. */
  readonly fingerprint: string;
  /** The payable total so far, already capped — the wire's `roundWin`, accrued (D7). */
  readonly cumulativeWin: Minor;
  readonly capped: boolean;
  readonly feature?: FeatureProgress;
  /** The latest resolved grid — what `pendingRound.result` reports. Absent while stranded. */
  readonly lastResult?: RoundResult;
  /** Free spins played so far. Zero for a base-only round. */
  readonly steps: number;
  readonly openedAt: number;
}

/** The recorded answer to a mutating call, replayed verbatim for a duplicate key. */
export interface StoredRecord {
  readonly roundId: RoundId;
  readonly call: CallName;
  /** 0 for the base spin and for settle; the step number for a free spin. */
  readonly step: number;
  /** Canonical form of what was asked — a duplicate with different parameters is a conflict. */
  readonly fingerprint: string;
  readonly response: unknown;
}

export type StoreConflict = 'DUPLICATE_ROUND' | 'DUPLICATE_RECORD' | 'STALE_TRANSITION';

export class StoreConflictError extends Error {
  readonly conflict: StoreConflict;

  constructor(conflict: StoreConflict, message: string) {
    super(message);
    this.name = 'StoreConflictError';
    this.conflict = conflict;
  }
}

export const isStoreConflict = (
  value: unknown,
  conflict?: StoreConflict,
): value is StoreConflictError =>
  value instanceof StoreConflictError && (conflict === undefined || value.conflict === conflict);

/** The fields a `commit` may change. Everything identifying the round is immutable. */
export type RoundPatch = Partial<
  Pick<StoredRound, 'state' | 'cumulativeWin' | 'capped' | 'feature' | 'lastResult' | 'steps'>
>;

export interface RoundCommit {
  readonly roundId: RoundId;
  /** The state this commit moves from — asserted atomically, or `STALE_TRANSITION`. */
  readonly from: RoundState;
  readonly patch: RoundPatch;
  /** Inserted with the transition, atomically. More than one for an atomic zero-win settle. */
  readonly records: readonly StoredRecord[];
}

export interface RoundStore {
  /** Insert an `OPEN` round. A duplicate `roundId` fails — that failure is the replay path. */
  open(round: StoredRound): Promise<void>;
  find(roundId: RoundId): Promise<StoredRound | undefined>;
  record(roundId: RoundId, call: CallName, step: number): Promise<StoredRecord | undefined>;
  /** The unit of work: guarded transition + insert-only records, all or nothing. */
  commit(commit: RoundCommit): Promise<void>;
  /** The one round `authenticate` reports — the oldest not-yet-settled one (docs/protocol.md §5). */
  pendingFor(playerId: string): Promise<StoredRound | undefined>;
  /** Settled rounds, newest first. */
  settledFor(playerId: string, limit: number): Promise<readonly StoredRound[]>;
  /**
   * When this player's newest round opened — the server half of the jurisdiction's pacing rule
   * (R5): an accepted spin is an opened round, so "measured between accepted spins" is a read of
   * this, idempotent replays exempt by construction because a replay opens nothing.
   */
  lastOpenedAt(playerId: string): Promise<number | undefined>;
  /**
   * How many rounds sit in each state, whole store — the round-state gauge's read (R6), and what
   * `/ready` pings the database with. Asked at scrape time because the store is the only party
   * whose answer survives a restart: an `OPEN` count that stays high is the stranded-round alarm.
   */
  countByState(): Promise<Record<RoundState, number>>;
  /** How many settled rounds this store keeps at all — the wire's `history.retention`. */
  readonly retention: number;
}
