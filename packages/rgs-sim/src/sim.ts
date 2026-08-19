import type {
  AuthenticateReq,
  AuthenticateRes,
  ErrorCode,
  FeatureProgress,
  FeatureSpinReq,
  FeatureSpinRes,
  ForceOutcome,
  GameConfig,
  HistoryReq,
  HistoryRes,
  Minor,
  NextAction,
  PendingRound,
  RoundId,
  RoundResult,
  RoundState,
  RoundSummary,
  SettleReq,
  SettleRes,
  SpinReq,
  SpinRes,
} from '@slot/protocol';
import { ZERO, add, min, multiply, subtract } from '@slot/money';
import { deriveSpinSeed } from '@slot/game-math';
import { errorPayload } from './errors.js';
import {
  baseFeatures,
  resolveStops,
  retriggerFeatures,
  spinOutcome,
  toRoundResult,
} from '@slot/game-math';
import { scenarioStops } from './scenarios.js';
import type { SimOutcome, SimRound, SimState } from './state.js';
import { MAX_ROUND_HISTORY, findOpenRound, findRound, withRound } from './state.js';

/**
 * The four calls, as pure functions.
 *
 * Every handler has the same shape — `(state, request, context) → (state, response | error)` — and
 * none of them touch a clock, a network or a store. That is what lets one outcome engine serve the
 * dev loop, the HTTP path (S2) and the 50-million-spin RTP report (S4) instead of three lookalike
 * implementations that drift.
 *
 * Errors are **returned, not thrown**. A rejected call still advances the call counter, so its
 * correlation id is real and appears in the log; the stateful wrapper in `server.ts` is what turns
 * the payload into a `SlotError` for callers who prefer exceptions.
 */

export interface SimContext {
  config: GameConfig;
  /** Epoch ms, supplied by the caller. This package never reads a clock. */
  now: number;
}

/**
 * Key-order-independent serialisation, for comparing a duplicate request against the original.
 *
 * `JSON.stringify` would do until the day two clients serialise the same object with their keys in
 * a different order and an honest retry is answered with `ROUND_CONFLICT` — a `FATAL` error, over
 * nothing. An idempotency key deserves a comparison that cannot produce that.
 */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
};

const bump = (state: SimState): SimState => ({ ...state, seq: state.seq + 1 });

/**
 * The round's payout ceiling, and the accrual that respects it.
 *
 * The cap is `stake × maxWinMultiplier` and it is applied **on the way in**, so `roundWin` is the
 * payable figure in every response and `settle` credits exactly the number the client last showed.
 * Capping only at `settle` is how a win presentation ends up counting to an amount the player is not
 * paid, and the client cannot fix that itself — it is not allowed to compute money (D7).
 *
 * `result.totalWin` is deliberately left uncapped: it is what the math paid for that grid, which is
 * what the dev-build assertion and the contract suite re-evaluate. The outcome and the money are
 * different facts.
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

const rejected = <T>(
  state: SimState,
  code: ErrorCode,
  message: string,
  roundId?: RoundId,
): SimOutcome<T> => ({
  ok: false,
  state,
  error: errorPayload(state.seq, code, message, roundId),
});

/**
 * `SESSION_EXPIRED` when the session has, `null` when it is still good.
 *
 * Checked on **every** call, not only `authenticate` — that is what gives the client's mid-round
 * recovery (docs/protocol.md §5, D9) a real producer: a feature spin or a settle that fails this
 * way is exactly the case the transparent re-authenticate exists for. Before C6 the check lived on
 * `authenticate` alone, deliberately, because the recovery story did not exist yet and a `PLAYER`
 * error mid-round would have abandoned a debited round; now the story exists, the producer does too.
 */
const expiredSession = <T>(state: SimState, context: SimContext): SimOutcome<T> | null =>
  context.now >= state.session.expiresAt
    ? rejected(state, 'SESSION_EXPIRED', 'the session has expired — re-authenticate')
    : null;

/* ── forceOutcome ─────────────────────────────────────────────────────────────────────────────
 * Gate two of two (docs/protocol.md §8). Gate one is the client, which cannot even send the field
 * outside a dev build — this one exists precisely to catch a regression in that one, so it is
 * enforced on the server whether or not the client is believed.
 */

type ForcedStops =
  { readonly ok: true; readonly stops: number[] } | { readonly ok: false; readonly reason: string };

const resolveForceOutcome = (
  config: GameConfig,
  force: ForceOutcome,
  seed: string,
): ForcedStops => {
  if (!('stops' in force)) {
    try {
      return { ok: true, stops: scenarioStops(config, force.scenario, seed) };
    } catch (cause) {
      // A scenario that cannot be built on these strips is a math problem, not a client one — say
      // which scenario and why rather than returning a screen that does not match its name.
      return {
        ok: false,
        reason: `scenario '${force.scenario}' cannot be built on these strips: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      };
    }
  }

  if (force.stops.length !== config.reels) {
    return { ok: false, reason: `expected ${config.reels} stops, got ${force.stops.length}` };
  }

  const overrun = force.stops.findIndex((stop, reel) => stop >= (config.strips[reel]?.length ?? 0));
  if (overrun !== -1) {
    return { ok: false, reason: `stop for reel ${overrun} is past the end of its strip` };
  }

  return { ok: true, stops: [...force.stops] };
};

/* ── authenticate ─────────────────────────────────────────────────────────────────────────── */

const latestResult = (round: SimRound): RoundResult =>
  round.steps[round.steps.length - 1]?.response.result ?? round.spin.result;

/**
 * The entire recovery story, assembled from the stored round (docs/protocol.md §5).
 *
 * Note what is *not* here: a reconciliation endpoint, a client-side replay of what it thinks
 * happened, or any arithmetic. The server states where the round is and which call moves it on.
 */
const pendingRoundOf = (round: SimRound): PendingRound => ({
  roundId: round.roundId,
  state: round.state === 'OPEN' ? 'OPEN' : 'RESOLVED',
  stake: round.stake,
  roundWin: round.cumulativeWin,
  capped: round.capped,
  result: latestResult(round),
  ...(round.feature === undefined ? {} : { feature: round.feature }),
  next: round.state === 'OPEN' ? 'FEATURE_SPIN' : 'SETTLE',
});

export function authenticate(
  state: SimState,
  request: AuthenticateReq,
  context: SimContext,
): SimOutcome<AuthenticateRes> {
  const next = bump(state);

  if (request.token !== next.token) {
    return rejected(next, 'SESSION_EXPIRED', 'the token is not valid for this session');
  }

  const expired = expiredSession<AuthenticateRes>(next, context);
  if (expired !== null) return expired;

  const open = findOpenRound(next);

  return {
    ok: true,
    state: next,
    response: {
      session: next.session,
      balance: next.balance,
      config: context.config,
      ...(open === undefined ? {} : { pendingRound: pendingRoundOf(open) }),
    },
  };
}

/* ── spin ─────────────────────────────────────────────────────────────────────────────────── */

export function spin(state: SimState, request: SpinReq, context: SimContext): SimOutcome<SpinRes> {
  const next = bump(state);
  const { config } = context;

  // Session first: an expired caller is not authenticated at all, and every answer below — including
  // a replay — is for callers who are.
  const expired = expiredSession<SpinRes>(next, context);
  if (expired !== null) return expired;

  const fingerprint = canonical([
    request.stake,
    request.clientSeed ?? null,
    request.forceOutcome ?? null,
  ]);

  const spinSeed = deriveSpinSeed(next.serverSeed, request.roundId, request.clientSeed, 0);

  // Idempotency next, before any validation: a retry of a round that already happened must replay
  // it, not re-litigate whether it should have been allowed. A stake that has since fallen outside
  // the limits does not retroactively un-spin a spin the player already saw — and the pacing rule
  // below never sees a replay, which is what keeps an honest retry from being refused as too fast.
  const known = findRound(next, request.roundId);
  if (known !== undefined) {
    if (known.fingerprint !== fingerprint) {
      return rejected(
        next,
        'ROUND_CONFLICT',
        'this roundId was already used with different parameters',
        request.roundId,
      );
    }
    return { ok: true, state: next, response: known.spin };
  }

  // The jurisdiction's half of the wire's pacing rule (docs/protocol.md §2.1): a base-game cycle may
  // not start sooner than `minSpinIntervalMs` after the last accepted one. `LIMIT_REACHED` — a
  // compliant client paces the button and never sees this; the check exists to catch the one that
  // does not, because turbo's only server-visible effect is cadence.
  const interval = config.jurisdictionRules.minSpinIntervalMs;
  if (interval > 0 && next.lastSpinAt !== undefined && context.now - next.lastSpinAt < interval) {
    return rejected(
      next,
      'LIMIT_REACHED',
      `this jurisdiction requires ${interval}ms between spins`,
      request.roundId,
    );
  }

  let forced: number[] | undefined;
  if (request.forceOutcome !== undefined) {
    if (!config.devMode) {
      return rejected(
        next,
        'FORCE_OUTCOME_REFUSED',
        'this server does not accept forceOutcome',
        request.roundId,
      );
    }
    const resolution = resolveForceOutcome(config, request.forceOutcome, spinSeed);
    if (!resolution.ok) {
      return rejected(next, 'FORCE_OUTCOME_REFUSED', resolution.reason, request.roundId);
    }
    forced = resolution.stops;
  }

  const stakeRejection = validateStake(config, request.stake);
  if (stakeRejection !== null) {
    return rejected(next, 'STAKE_NOT_ALLOWED', stakeRejection, request.roundId);
  }

  if (next.balance < request.stake) {
    return rejected(
      next,
      'INSUFFICIENT_FUNDS',
      'the balance does not cover this stake',
      request.roundId,
    );
  }

  const outcome =
    forced === undefined
      ? spinOutcome(config, spinSeed, request.stake)
      : resolveStops(config, forced, request.stake);

  const features = baseFeatures(outcome.scatters);
  const awarded = features[0]?.awarded ?? 0;
  const balance = subtract(next.balance, request.stake);
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

  // The lifecycle table, docs/protocol.md §3. A zero-win base round settles atomically because it
  // has nothing to credit and nothing to present — every round that *does* move money ends with an
  // explicit `settle`, which is what keeps the client from ever computing a balance.
  const roundState: RoundState =
    feature !== undefined ? 'OPEN' : roundWin > ZERO ? 'RESOLVED' : 'SETTLED';
  const nextAction: NextAction =
    feature !== undefined ? 'FEATURE_SPIN' : roundWin > ZERO ? 'SETTLE' : 'IDLE';

  const response: SpinRes = {
    roundId: request.roundId,
    balance,
    roundWin,
    capped,
    result: toRoundResult(outcome, features),
    ...(feature === undefined ? {} : { feature }),
    next: nextAction,
  };

  const round: SimRound = {
    roundId: request.roundId,
    state: roundState,
    stake: request.stake,
    ...(request.clientSeed === undefined ? {} : { clientSeed: request.clientSeed }),
    fingerprint,
    cumulativeWin: roundWin,
    capped,
    openedAt: context.now,
    spin: response,
    steps: [],
    ...(feature === undefined ? {} : { feature }),
    // A round that settled atomically still owes an answer to a client that calls `settle` anyway —
    // a replay, not an error (docs/protocol.md §4). Recording it now is what makes that true.
    ...(roundState === 'SETTLED'
      ? {
          settle: {
            roundId: request.roundId,
            balance,
            totalWin: ZERO,
            capped,
            next: 'IDLE' as const,
          },
        }
      : {}),
  };

  return {
    ok: true,
    // `lastSpinAt` moves only here, on acceptance: a refused call did not start a game cycle, so it
    // does not push the next legal one further away.
    state: withRound({ ...next, balance, lastSpinAt: context.now }, round),
    response,
  };
}

/**
 * `null` when the stake is allowed, otherwise why not.
 *
 * `STAKE_NOT_ALLOWED` covers both a stake off the bet ladder and one outside the limits: the client
 * already knows both from `GameConfig`, so splitting the code buys it nothing (docs/protocol.md §6).
 */
const validateStake = (config: GameConfig, stake: Minor): string | null => {
  if (!config.betLevels.includes(stake)) return 'the stake is not one of the offered bet levels';
  if (stake < config.limits.minStake) return 'the stake is below the table minimum';
  if (stake > config.limits.maxStake) return 'the stake is above the table maximum';
  return null;
};

/* ── featureSpin ──────────────────────────────────────────────────────────────────────────── */

export function featureSpin(
  state: SimState,
  request: FeatureSpinReq,
  context: SimContext,
): SimOutcome<FeatureSpinRes> {
  const next = bump(state);
  const { config } = context;

  const expired = expiredSession<FeatureSpinRes>(next, context);
  if (expired !== null) return expired;

  const round = findRound(next, request.roundId);
  if (round === undefined) {
    return rejected(next, 'UNKNOWN_ROUND', 'no such round', request.roundId);
  }

  const fingerprint = canonical([request.forceOutcome ?? null]);
  const stepSeed = deriveSpinSeed(next.serverSeed, request.roundId, round.clientSeed, request.step);
  const recorded = round.steps[request.step - 1];
  if (recorded !== undefined) {
    if (recorded.fingerprint !== fingerprint) {
      return rejected(
        next,
        'ROUND_CONFLICT',
        'this step was already played with different parameters',
        request.roundId,
      );
    }
    return { ok: true, state: next, response: recorded.response };
  }

  const feature = round.feature;
  if (round.state !== 'OPEN' || feature === undefined) {
    return rejected(
      next,
      'ILLEGAL_TRANSITION',
      `round is ${round.state}; there is no feature to spin`,
      request.roundId,
    );
  }

  // Strictly sequential: the key is `(roundId, step)`, so a client that skips a step is not
  // resuming, it is guessing. A disconnect on spin 7 of 10 resumes at 7 and nowhere else.
  if (request.step !== feature.step + 1) {
    return rejected(
      next,
      'ILLEGAL_TRANSITION',
      `expected step ${feature.step + 1}, got ${request.step}`,
      request.roundId,
    );
  }

  let forced: number[] | undefined;
  if (request.forceOutcome !== undefined) {
    if (!config.devMode) {
      return rejected(
        next,
        'FORCE_OUTCOME_REFUSED',
        'this server does not accept forceOutcome',
        request.roundId,
      );
    }
    const resolution = resolveForceOutcome(config, request.forceOutcome, stepSeed);
    if (!resolution.ok) {
      return rejected(next, 'FORCE_OUTCOME_REFUSED', resolution.reason, request.roundId);
    }
    forced = resolution.stops;
  }

  // Free spins carry no stake of their own, so every multiplier resolves against the stake that
  // bought the feature. `stakeRef` is on the wire for exactly this reason.
  const outcome =
    forced === undefined
      ? spinOutcome(config, stepSeed, feature.stakeRef)
      : resolveStops(config, forced, feature.stakeRef);

  const features = retriggerFeatures(outcome.scatters);
  const retrigger = features[0]?.awarded ?? 0;

  // The server folds the retrigger in; the client displays the arithmetic and never performs it.
  // `remaining = total - step` is the invariant that keeps both fields honest under retrigger.
  const progress: FeatureProgress = {
    kind: 'FREE_SPINS',
    total: feature.total + retrigger,
    remaining: feature.remaining - 1 + retrigger,
    step: request.step,
    stakeRef: feature.stakeRef,
  };

  // The ceiling is the round's, so it is measured against the stake that bought the feature — a
  // free spin has none of its own. Once it bites, further free spins add nothing, and `capped`
  // stays true so the client can say why the counter stopped moving.
  const { roundWin, capped } = accrue(
    config,
    feature.stakeRef,
    round.cumulativeWin,
    outcome.totalWin,
  );

  const done = progress.remaining === 0;

  const response: FeatureSpinRes = {
    roundId: request.roundId,
    step: request.step,
    // Unchanged: a free spin neither debits nor credits. Sent so the HUD never has to remember.
    balance: next.balance,
    roundWin,
    capped: round.capped || capped,
    result: toRoundResult(outcome, features),
    feature: progress,
    next: done ? 'SETTLE' : 'FEATURE_SPIN',
  };

  const updated: SimRound = {
    ...round,
    state: done ? 'RESOLVED' : 'OPEN',
    cumulativeWin: roundWin,
    capped: response.capped,
    steps: [...round.steps, { fingerprint, response }],
    feature: progress,
  };

  return { ok: true, state: withRound(next, updated), response };
}

/* ── settle ───────────────────────────────────────────────────────────────────────────────── */

export function settle(
  state: SimState,
  request: SettleReq,
  // Only the clock is read, and only for the session check: with the ceiling applied on the way in,
  // settling is a credit and a state change, with nothing left to compute.
  context: SimContext,
): SimOutcome<SettleRes> {
  const next = bump(state);

  const expired = expiredSession<SettleRes>(next, context);
  if (expired !== null) return expired;

  const round = findRound(next, request.roundId);
  if (round === undefined) {
    return rejected(next, 'UNKNOWN_ROUND', 'no such round', request.roundId);
  }

  // Settling an already-settled round is a replay, not an error: a client that timed out waiting
  // for the credit must be able to ask again and get the same answer (docs/protocol.md §4).
  if (round.settle !== undefined) {
    return { ok: true, state: next, response: round.settle };
  }

  if (round.state !== 'RESOLVED') {
    return rejected(
      next,
      'ILLEGAL_TRANSITION',
      `round is ${round.state}; it has nothing to settle yet`,
      request.roundId,
    );
  }

  // Nothing to decide: the ceiling was applied as the round accrued, so the credit is exactly the
  // number the client was last sent and last counted up to.
  const credited = round.cumulativeWin;
  const balance = add(next.balance, credited);

  const response: SettleRes = {
    roundId: request.roundId,
    balance,
    totalWin: credited,
    // The player has to be told when the cap clipped their win — in most regulated markets that is
    // a requirement rather than a courtesy.
    capped: round.capped,
    next: 'IDLE',
  };

  const updated: SimRound = { ...round, state: 'SETTLED', settle: response };

  return { ok: true, state: withRound({ ...next, balance }, updated), response };
}

/* ── history ──────────────────────────────────────────────────────────────────────────────── */

/** The default page. Enough to fill a "last rounds" panel without paging on the first open. */
const DEFAULT_HISTORY_LIMIT = 20;

const summaryOf = (round: SimRound): RoundSummary => ({
  roundId: round.roundId,
  at: round.openedAt,
  stake: round.stake,
  // What was credited, which for a settled round is exactly what `settle` answered.
  totalWin: round.settle?.totalWin ?? ZERO,
  capped: round.capped,
  freeSpins: round.steps.length,
});

/**
 * The last rounds this player finished — read-only, and settled rounds only.
 *
 * A round still in flight is `pendingRound`; mixing the two would invite a client to present an
 * unfinished round as a result. `retention` is answered rather than assumed because the honest
 * number here is small: this server keeps its history in a browser store, and R1 replaces it with
 * months of rows in Postgres without the client changing.
 */
export function history(
  state: SimState,
  request: HistoryReq,
  context: SimContext,
): SimOutcome<HistoryRes> {
  const next = bump(state);

  const expired = expiredSession<HistoryRes>(next, context);
  if (expired !== null) return expired;

  const limit = request.limit ?? DEFAULT_HISTORY_LIMIT;

  const rounds = next.rounds
    .filter((round) => round.state === 'SETTLED')
    .slice(-limit)
    // Stored oldest first, because that is the order they are evicted in; read newest first,
    // because that is the order a player reads them in.
    .reverse()
    .map(summaryOf);

  return { ok: true, state: next, response: { rounds, retention: MAX_ROUND_HISTORY } };
}
