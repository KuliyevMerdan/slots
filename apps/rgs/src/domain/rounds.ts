import type {
  AuthenticateReq,
  AuthenticateRes,
  CallName,
  CallRequest,
  CallResponse,
  FeatureProgress,
  FeatureSpinReq,
  FeatureSpinRes,
  GameConfig,
  HistoryReq,
  HistoryRes,
  Minor,
  NextAction,
  PendingRound,
  RoundState,
  Session,
  SettleReq,
  SettleRes,
  SpinReq,
  SpinRes,
} from '@slot/protocol';
import { SlotError } from '@slot/protocol';
import { ZERO, add, min, multiply } from '@slot/money';
import { baseFeatures, retriggerFeatures, spinOutcome, toRoundResult } from '@slot/game-math';
import { NotImplementedError } from '../errors.js';
import type { RoundStore, StoredRecord, StoredRound } from '../persistence/store.js';
import { isStoreConflict } from '../persistence/store.js';
import type { WalletProvider } from '../wallet/provider.js';
import { WalletError } from '../wallet/provider.js';
import type { ServerSeedProvider } from '../rng/seeds.js';
import type { SessionPort } from './sessions.js';
import { featureSpinFingerprint, settleFingerprint, spinFingerprint } from './fingerprint.js';

/**
 * The round lifecycle, as a service the HTTP layer dispatches into.
 *
 * The shape is the `CALLS` table made into methods — one per call, request in, response out —
 * deliberately the same surface `RgsTransport` has on the client side: the wire is symmetric, and
 * both ends of it are generated from the one table in `@slot/protocol`.
 *
 * Since R1 this is the real thing — docs/protocol.md §3 (the round machine), §4 (idempotency) and
 * §5 (recovery) over the ports R0 declared: the store, the wallet, the session host and the seed
 * provider. The semantics are the simulator's, deliberately — the contract suite holds both
 * servers to one wire — but the *shape* is a real server's: the wallet is an external system the
 * database cannot wrap in a transaction, so the debit and the round resolve are separated by a
 * window a process can die in. That window is not a bug; it is §5's stranded round, the reason
 * `strand()` in the contract suite finally has a producer — and, since R2, the reason the one
 * confirmed-debit-no-round state rolls its debit back (docs/wallet-api.md §4).
 */
export type RoundService = {
  [N in CallName]: (request: CallRequest<N>) => Promise<CallResponse<N>>;
};

export interface RoundServiceDeps {
  store: RoundStore;
  wallet: WalletProvider;
  sessions: SessionPort;
  seeds: ServerSeedProvider;
  config: GameConfig;
  /** Epoch ms. Injected — the purity rule, applied to a server. */
  now: () => number;
}

/** The per-step seed: `seedFor(roundId)` + `|clientSeed|step` — `deriveSpinSeed`, byte for byte. */
const stepSeed = (material: string, clientSeed: string | undefined, step: number): string =>
  `${material}|${clientSeed ?? ''}|${step}`;

/**
 * The round's payout ceiling, applied as the round accrues (D7) — `roundWin` is the payable figure
 * in every response, and `settle` credits exactly the number the client last showed.
 */
const accrue = (
  config: GameConfig,
  stake: Minor,
  soFar: Minor,
  won: Minor,
): { roundWin: Minor; capped: boolean } => {
  const ceiling = multiply(stake, config.limits.maxWinMultiplier);
  const raw = add(soFar, won);
  return { roundWin: min(raw, ceiling), capped: raw > ceiling };
};

const validateStake = (config: GameConfig, stake: Minor): string | null => {
  if (!config.betLevels.includes(stake)) return 'the stake is not one of the offered bet levels';
  if (stake < config.limits.minStake) return 'the stake is below the table minimum';
  if (stake > config.limits.maxStake) return 'the stake is above the table maximum';
  return null;
};

/** What the wallet's refusals mean on the wire — the wallet never speaks to the client directly. */
const walletFailure = (error: unknown, roundId?: string): SlotError => {
  if (error instanceof WalletError && error.code === 'INSUFFICIENT_FUNDS') {
    return new SlotError('INSUFFICIENT_FUNDS', 'the balance does not cover this stake', {
      ...(roundId === undefined ? {} : { roundId }),
    });
  }
  return new SlotError(
    'WALLET_UNAVAILABLE',
    `the wallet did not complete the operation: ${error instanceof Error ? error.message : String(error)}`,
    { ...(roundId === undefined ? {} : { roundId }), cause: error },
  );
};

/** The recovery report, assembled from the stored round (docs/protocol.md §5). */
const pendingRoundOf = (round: StoredRound): PendingRound => {
  // Debited and never resolved: no result to present, no feature, and no `next` — the call that
  // moves this round on is the spin retry itself, which the client derives from state + feature.
  if (round.state === 'OPEN' && round.lastResult === undefined) {
    return {
      roundId: round.roundId,
      state: 'OPEN',
      stake: round.stake,
      roundWin: round.cumulativeWin,
      capped: round.capped,
    };
  }

  return {
    roundId: round.roundId,
    state: round.state === 'OPEN' ? 'OPEN' : 'RESOLVED',
    stake: round.stake,
    roundWin: round.cumulativeWin,
    capped: round.capped,
    ...(round.lastResult === undefined ? {} : { result: round.lastResult }),
    ...(round.feature === undefined ? {} : { feature: round.feature }),
    next: round.state === 'OPEN' ? 'FEATURE_SPIN' : 'SETTLE',
  };
};

export function createRoundService({
  store,
  wallet,
  sessions,
  seeds,
  config,
  now,
}: RoundServiceDeps): RoundService {
  /** The session every non-authenticate call runs under — expiry checked on every call (§5, D9). */
  const activeSession = (): Session => {
    const session = sessions.active();
    if (session === undefined) {
      throw new SlotError('SESSION_EXPIRED', 'no session — authenticate first');
    }
    if (now() >= session.expiresAt) {
      throw new SlotError('SESSION_EXPIRED', 'the session has expired — re-authenticate');
    }
    return session;
  };

  /**
   * A commit lost a race: some concurrent duplicate of the same request got there first. The
   * recorded answer is the truth for both of them — fetch it and replay, exactly as if the record
   * had existed on the way in. Anything else re-throws: a store conflict that does not resolve to
   * a matching record is a genuine bug, and hiding it would hide a money error.
   */
  const replayAfterRace = async <T>(
    error: unknown,
    roundId: string,
    call: CallName,
    step: number,
    fingerprint: string,
  ): Promise<T> => {
    if (isStoreConflict(error, 'DUPLICATE_RECORD') || isStoreConflict(error, 'STALE_TRANSITION')) {
      const record = await store.record(roundId, call, step);
      if (record !== undefined && record.fingerprint === fingerprint) {
        return record.response as T;
      }
    }
    throw error;
  };

  const authenticate = async (request: AuthenticateReq): Promise<AuthenticateRes> => {
    const session = sessions.verify(request.token);
    if (session === undefined) {
      throw new SlotError('SESSION_EXPIRED', 'the token is not valid for this session');
    }
    if (now() >= session.expiresAt) {
      throw new SlotError('SESSION_EXPIRED', 'the session has expired — re-authenticate');
    }

    const balance = await wallet.getBalance(session.playerId).catch((error: unknown) => {
      throw walletFailure(error);
    });
    const pending = await store.pendingFor(session.playerId);

    return {
      session,
      balance,
      config,
      ...(pending === undefined ? {} : { pendingRound: pendingRoundOf(pending) }),
    };
  };

  const spin = async (request: SpinReq): Promise<SpinRes> => {
    const session = activeSession();
    const fingerprint = spinFingerprint(request.stake, request.clientSeed, request.forceOutcome);

    // Idempotency before validation: a retry of a round that already happened must replay it, not
    // re-litigate whether it should have been allowed (docs/protocol.md §4).
    const recorded = await store.record(request.roundId, 'spin', 0);
    if (recorded !== undefined) {
      if (recorded.fingerprint !== fingerprint) {
        throw new SlotError(
          'ROUND_CONFLICT',
          'this roundId was already used with different parameters',
          { roundId: request.roundId },
        );
      }
      return recorded.response as SpinRes;
    }

    let round = await store.find(request.roundId);
    let balance: Minor;

    if (round !== undefined) {
      // The round exists with no recorded response: a debit whose resolve never happened — §5's
      // stranded case, or a concurrent duplicate mid-flight. Either way the debit is done; the
      // honest retry finishes the round.
      if (round.fingerprint !== fingerprint) {
        throw new SlotError(
          'ROUND_CONFLICT',
          'this roundId was already used with different parameters',
          { roundId: request.roundId },
        );
      }
      balance = await wallet.getBalance(session.playerId).catch((error: unknown) => {
        throw walletFailure(error, request.roundId);
      });
    } else {
      // This server never honours forceOutcome — there is no dev mode to enable it (§8). Refused
      // before anything else is considered, so a tampered request learns nothing.
      if (request.forceOutcome !== undefined) {
        throw new SlotError('FORCE_OUTCOME_REFUSED', 'this server does not accept forceOutcome', {
          roundId: request.roundId,
        });
      }

      const stakeRejection = validateStake(config, request.stake);
      if (stakeRejection !== null) {
        throw new SlotError('STAKE_NOT_ALLOWED', stakeRejection, { roundId: request.roundId });
      }

      balance = await wallet
        .debit(session.playerId, request.stake, request.roundId)
        .catch((error: unknown) => {
          throw walletFailure(error, request.roundId);
        });

      const opened: StoredRound = {
        roundId: request.roundId,
        playerId: session.playerId,
        state: 'OPEN',
        stake: request.stake,
        ...(request.clientSeed === undefined ? {} : { clientSeed: request.clientSeed }),
        fingerprint,
        cumulativeWin: ZERO,
        capped: false,
        steps: 0,
        openedAt: now(),
      };

      try {
        await store.open(opened);
      } catch (error) {
        if (!isStoreConflict(error, 'DUPLICATE_ROUND')) {
          // The debit is confirmed and the round cannot exist — the one state the rollback
          // exists for (docs/wallet-api.md §4). Undo the stake, then surface the store failure
          // as-is: it is `RECOVERABLE`, and the client's same-`roundId` retry starts clean
          // because a rolled-back ref is debitable again (§3). If the rollback itself cannot be
          // delivered, the orphan is what R3's reconciliation exists to find — and hiding the
          // original failure behind the rollback's would help nobody.
          await wallet.rollback(request.roundId).catch(() => undefined);
          throw error;
        }
        // A concurrent duplicate opened it first. The debit replayed idempotently, the round is
        // theirs to resolve as much as ours — fall through to the resolve with the stored row.
        const existing = await store.find(request.roundId);
        if (existing === undefined || existing.fingerprint !== fingerprint) {
          throw new SlotError(
            'ROUND_CONFLICT',
            'this roundId was already used with different parameters',
            { roundId: request.roundId },
          );
        }
        round = existing;
      }
      round ??= opened;
    }

    // The outcome: drawn from the derived seed, stops first, everything else a consequence.
    const material = await seeds.seedFor(request.roundId);
    const outcome = spinOutcome(config, stepSeed(material, request.clientSeed, 0), request.stake);

    const features = baseFeatures(outcome.scatters);
    const awarded = features[0]?.awarded ?? 0;
    const { roundWin, capped } = accrue(config, request.stake, ZERO, outcome.totalWin);

    const feature: FeatureProgress | undefined =
      awarded === 0
        ? undefined
        : {
            kind: 'FREE_SPINS',
            total: awarded,
            remaining: awarded,
            step: 0,
            stakeRef: request.stake,
          };

    const state: RoundState =
      feature !== undefined ? 'OPEN' : roundWin > ZERO ? 'RESOLVED' : 'SETTLED';
    const next: NextAction =
      feature !== undefined ? 'FEATURE_SPIN' : roundWin > ZERO ? 'SETTLE' : 'IDLE';

    const response: SpinRes = {
      roundId: request.roundId,
      balance,
      roundWin,
      capped,
      result: toRoundResult(outcome, features),
      ...(feature === undefined ? {} : { feature }),
      next,
    };

    const records: StoredRecord[] = [
      { roundId: request.roundId, call: 'spin', step: 0, fingerprint, response },
    ];
    // A zero-win base round settles atomically, and still owes a replay to a client that calls
    // `settle` anyway (§4). Recording the answer now is what makes that true.
    if (state === 'SETTLED') {
      records.push({
        roundId: request.roundId,
        call: 'settle',
        step: 0,
        fingerprint: settleFingerprint(),
        response: {
          roundId: request.roundId,
          balance,
          totalWin: ZERO,
          capped,
          next: 'IDLE',
        } satisfies SettleRes,
      });
    }

    try {
      await store.commit({
        roundId: request.roundId,
        from: 'OPEN',
        patch: {
          state,
          cumulativeWin: roundWin,
          capped,
          ...(feature === undefined ? {} : { feature }),
          lastResult: response.result,
        },
        records,
      });
    } catch (error) {
      return replayAfterRace<SpinRes>(error, request.roundId, 'spin', 0, fingerprint);
    }

    return response;
  };

  const featureSpin = async (request: FeatureSpinReq): Promise<FeatureSpinRes> => {
    const session = activeSession();

    const round = await store.find(request.roundId);
    if (round === undefined) {
      throw new SlotError('UNKNOWN_ROUND', 'no such round', { roundId: request.roundId });
    }

    const fingerprint = featureSpinFingerprint(request.forceOutcome);
    const recorded = await store.record(request.roundId, 'featureSpin', request.step);
    if (recorded !== undefined) {
      if (recorded.fingerprint !== fingerprint) {
        throw new SlotError(
          'ROUND_CONFLICT',
          'this step was already played with different parameters',
          { roundId: request.roundId },
        );
      }
      return recorded.response as FeatureSpinRes;
    }

    const feature = round.feature;
    if (round.state !== 'OPEN' || feature === undefined) {
      throw new SlotError(
        'ILLEGAL_TRANSITION',
        `round is ${round.state}; there is no feature to spin`,
        { roundId: request.roundId },
      );
    }

    // Strictly sequential: a client that skips a step is not resuming, it is guessing.
    if (request.step !== feature.step + 1) {
      throw new SlotError(
        'ILLEGAL_TRANSITION',
        `expected step ${feature.step + 1}, got ${request.step}`,
        { roundId: request.roundId },
      );
    }

    if (request.forceOutcome !== undefined) {
      throw new SlotError('FORCE_OUTCOME_REFUSED', 'this server does not accept forceOutcome', {
        roundId: request.roundId,
      });
    }

    const material = await seeds.seedFor(request.roundId);
    // Free spins carry no stake of their own — multipliers resolve against the triggering stake.
    const outcome = spinOutcome(
      config,
      stepSeed(material, round.clientSeed, request.step),
      feature.stakeRef,
    );

    const features = retriggerFeatures(outcome.scatters);
    const retrigger = features[0]?.awarded ?? 0;

    // The server folds the retrigger in; the client displays the arithmetic and never performs it.
    const progress: FeatureProgress = {
      kind: 'FREE_SPINS',
      total: feature.total + retrigger,
      remaining: feature.remaining - 1 + retrigger,
      step: request.step,
      stakeRef: feature.stakeRef,
    };

    const { roundWin, capped } = accrue(
      config,
      feature.stakeRef,
      round.cumulativeWin,
      outcome.totalWin,
    );

    const done = progress.remaining === 0;
    const balance = await wallet.getBalance(session.playerId).catch((error: unknown) => {
      throw walletFailure(error, request.roundId);
    });

    const response: FeatureSpinRes = {
      roundId: request.roundId,
      step: request.step,
      // Unchanged: a free spin neither debits nor credits.
      balance,
      roundWin,
      capped: round.capped || capped,
      result: toRoundResult(outcome, features),
      feature: progress,
      next: done ? 'SETTLE' : 'FEATURE_SPIN',
    };

    try {
      await store.commit({
        roundId: request.roundId,
        from: 'OPEN',
        patch: {
          state: done ? 'RESOLVED' : 'OPEN',
          cumulativeWin: roundWin,
          capped: response.capped,
          feature: progress,
          lastResult: response.result,
          steps: request.step,
        },
        records: [
          {
            roundId: request.roundId,
            call: 'featureSpin',
            step: request.step,
            fingerprint,
            response,
          },
        ],
      });
    } catch (error) {
      return replayAfterRace<FeatureSpinRes>(
        error,
        request.roundId,
        'featureSpin',
        request.step,
        fingerprint,
      );
    }

    return response;
  };

  const settle = async (request: SettleReq): Promise<SettleRes> => {
    const session = activeSession();
    const fingerprint = settleFingerprint();

    // Settling twice is a replay, not an error: a client that timed out waiting for the credit
    // must be able to ask again and get the same answer (§4).
    const recorded = await store.record(request.roundId, 'settle', 0);
    if (recorded !== undefined) return recorded.response as SettleRes;

    const round = await store.find(request.roundId);
    if (round === undefined) {
      throw new SlotError('UNKNOWN_ROUND', 'no such round', { roundId: request.roundId });
    }
    if (round.state !== 'RESOLVED') {
      throw new SlotError(
        'ILLEGAL_TRANSITION',
        `round is ${round.state}; it has nothing to settle yet`,
        { roundId: request.roundId },
      );
    }

    // Nothing to decide: the ceiling was applied as the round accrued. The credit is idempotent on
    // its ref, so a crash between the credit and the commit replays into the same movement.
    const credited = round.cumulativeWin;
    const balance = await wallet
      .credit(session.playerId, credited, `${request.roundId}:settle`)
      .catch((error: unknown) => {
        throw walletFailure(error, request.roundId);
      });

    const response: SettleRes = {
      roundId: request.roundId,
      balance,
      totalWin: credited,
      capped: round.capped,
      next: 'IDLE',
    };

    try {
      await store.commit({
        roundId: request.roundId,
        from: 'RESOLVED',
        patch: { state: 'SETTLED' },
        records: [{ roundId: request.roundId, call: 'settle', step: 0, fingerprint, response }],
      });
    } catch (error) {
      return replayAfterRace<SettleRes>(error, request.roundId, 'settle', 0, fingerprint);
    }

    return response;
  };

  const history = async (request: HistoryReq): Promise<HistoryRes> => {
    const session = activeSession();
    const limit = request.limit ?? 20;

    const settled = await store.settledFor(session.playerId, limit);

    return {
      rounds: settled.map((round) => ({
        roundId: round.roundId,
        at: round.openedAt,
        stake: round.stake,
        // What was credited: the accrued, capped total — for a settled round, exactly what
        // `settle` answered.
        totalWin: round.cumulativeWin,
        capped: round.capped,
        freeSpins: round.steps,
      })),
      retention: store.retention,
    };
  };

  return { authenticate, spin, featureSpin, settle, history };
}

/* ── the R0 stub, kept ─────────────────────────────────────────────────────────────────────────
 * Still the honest default for a composition that has no domain to offer — and what the red-gate
 * mechanism in the contract suite exercises if an endpoint ever has to be taken dark again.
 */

/** Which block turns each stub real — printed in the error, asserted by nothing. */
const BUILT_BY: Record<CallName, string> = {
  authenticate: 'R1, R5',
  spin: 'R1',
  featureSpin: 'R1',
  settle: 'R1',
  history: 'R1',
};

const stub = <N extends CallName>(
  call: N,
): ((request: CallRequest<N>) => Promise<CallResponse<N>>) =>
  (() => Promise.reject(new NotImplementedError(`domain/rounds.${call} (${BUILT_BY[call]})`))) as (
    request: CallRequest<N>,
  ) => Promise<CallResponse<N>>;

export const notImplementedRounds = (): RoundService => ({
  authenticate: stub('authenticate'),
  spin: stub('spin'),
  featureSpin: stub('featureSpin'),
  settle: stub('settle'),
  history: stub('history'),
});
