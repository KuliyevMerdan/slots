import { describe, expect, it } from 'vitest';
import type { ErrorCode, PendingRound } from '@slot/protocol';
import { SlotError } from '@slot/protocol';
import { minor } from '@slot/money';
import { MATH_VERSION } from '@slot/game-math';
import { initialState, reduce, sessionOf } from './reduce.js';
import type { EngineEvent, EngineInput, EngineState, InputType, Phase } from './types.js';
import { PHASES } from './types.js';
import {
  BALANCE,
  CONFIG,
  ROUND_ID,
  STAKE,
  STATES,
  authRes,
  feature,
  featureSpinRes,
  result,
  settleRes,
  spinRes,
} from './__fixtures__/round.js';

const context = { newRoundId: () => ROUND_ID };

const step = (state: EngineState, input: EngineInput) => reduce(state, input, context);

const typesOf = (events: readonly EngineEvent[]): string[] => events.map((event) => event.type);

/**
 * Drive a list of inputs, returning **the last transition** — so assert events on the step that
 * produces them, not on the end of a sequence.
 */
const drive = (from: EngineState, ...inputs: EngineInput[]) => {
  let current = { state: from, events: [] as readonly EngineEvent[], effects: [] as never[] };
  for (const input of inputs) current = step(current.state, input) as typeof current;
  return current;
};

const IDLE = STATES.IDLE;

/* ── booting and authentication ───────────────────────────────────────────────────────────── */

describe('BOOTING', () => {
  it('starts with no session at all', () => {
    expect(initialState.phase).toBe('BOOTING');
    expect(sessionOf(initialState)).toBeUndefined();
  });

  it('rejects a press before there is a game to play', () => {
    const { state, events } = step(initialState, { type: 'PRESS' });
    expect(state.phase).toBe('BOOTING');
    expect(typesOf(events)).toEqual(['INPUT_REJECTED']);
  });

  it('becomes IDLE on authentication, at the first bet level', () => {
    const { state, events } = step(initialState, { type: 'AUTHENTICATED', response: authRes() });

    expect(state.phase).toBe('IDLE');
    expect(sessionOf(state)).toMatchObject({ balance: BALANCE, stake: CONFIG.betLevels[0] });
    expect(typesOf(events)).toEqual(['PHASE_CHANGED', 'SESSION_READY', 'BALANCE_CHANGED']);
  });
});

/* ── the ordinary round ───────────────────────────────────────────────────────────────────── */

describe('IDLE', () => {
  it('starts a round on press, with a freshly minted id', () => {
    const { state, events, effects } = step(IDLE, { type: 'PRESS' });

    expect(state.phase).toBe('SPINNING');
    expect(effects).toEqual([{ type: 'CALL_SPIN', request: { roundId: ROUND_ID, stake: STAKE } }]);
    expect(typesOf(events)).toContain('SPIN_STARTED');
  });

  it('accepts a stake the server offered', () => {
    const stake = CONFIG.betLevels[3];
    if (stake === undefined) throw new Error('the fixture config has too few bet levels');

    const { state, events } = step(IDLE, { type: 'SET_STAKE', stake });

    expect(sessionOf(state)?.stake).toBe(stake);
    expect(typesOf(events)).toEqual(['STAKE_CHANGED']);
  });

  /** The bet ladder is the server's. Refusing the input beats having the round refused. */
  it('rejects a stake that is not on the ladder', () => {
    const { state, events } = step(IDLE, { type: 'SET_STAKE', stake: minor(37) });

    expect(sessionOf(state)?.stake).toBe(STAKE);
    expect(typesOf(events)).toEqual(['INPUT_REJECTED']);
  });
});

describe('SPINNING', () => {
  const spinning = step(IDLE, { type: 'PRESS' }).state;

  it('lands the reels and takes the balance from the response', () => {
    const response = spinRes({ totalWin: 500, next: 'SETTLE' });
    const { state, events } = step(spinning, { type: 'SPIN_RESOLVED', response });

    expect(state.phase).toBe('STOPPING');
    expect(sessionOf(state)?.balance).toBe(response.balance);
    expect(typesOf(events)).toEqual(['PHASE_CHANGED', 'BALANCE_CHANGED', 'REELS_TARGETED']);
  });

  describe('the slam stop', () => {
    it('arms on a second press and says so', () => {
      const { state, events } = step(spinning, { type: 'PRESS' });

      expect(state.phase).toBe('SPINNING');
      expect(state).toMatchObject({ slam: true });
      expect(typesOf(events)).toEqual(['SKIPPED']);
    });

    it('reaches the renderer with the outcome', () => {
      const slammed = step(spinning, { type: 'PRESS' }).state;
      const { events } = step(slammed, { type: 'SPIN_RESOLVED', response: spinRes() });

      expect(events).toContainEqual(
        expect.objectContaining({ type: 'REELS_TARGETED', slam: true }),
      );
    });

    it('cannot be armed twice — a mashed button is not a shorter stop', () => {
      const slammed = step(spinning, { type: 'PRESS' }).state;
      const { events } = step(slammed, { type: 'PRESS' });

      expect(typesOf(events)).toEqual(['INPUT_REJECTED']);
    });
  });
});

describe('STOPPING', () => {
  const stopping = (totalWin: number, next: 'IDLE' | 'SETTLE' = 'SETTLE') =>
    drive(IDLE, { type: 'PRESS' }, { type: 'SPIN_RESOLVED', response: spinRes({ totalWin, next }) })
      .state;

  it('presents a win once the reels land', () => {
    const { state, events } = step(stopping(500), { type: 'REELS_STOPPED' });

    expect(state.phase).toBe('WIN_PRESENTATION');
    expect(typesOf(events)).toEqual(['PHASE_CHANGED', 'WINS_PRESENTED']);
  });

  /** A zero-win base round settled atomically on the server: nothing to show, nothing to call. */
  it('goes straight back to idle when there is nothing to present', () => {
    const { state, effects } = step(stopping(0, 'IDLE'), { type: 'REELS_STOPPED' });

    expect(state.phase).toBe('IDLE');
    expect(effects).toEqual([]);
  });

  it('rejects a press — the reels are already on the short path', () => {
    const { events } = step(stopping(500), { type: 'PRESS' });
    expect(typesOf(events)).toEqual(['INPUT_REJECTED']);
  });
});

describe('WIN_PRESENTATION', () => {
  const presenting = drive(
    IDLE,
    { type: 'PRESS' },
    { type: 'SPIN_RESOLVED', response: spinRes({ totalWin: 500, next: 'SETTLE' }) },
    { type: 'REELS_STOPPED' },
  ).state;

  it('settles when the presentation finishes', () => {
    const { state, effects } = step(presenting, { type: 'PRESENTATION_COMPLETE' });

    expect(state.phase).toBe('SETTLING');
    expect(effects).toEqual([{ type: 'CALL_SETTLE', request: { roundId: ROUND_ID } }]);
  });

  /**
   * The interruption contract: a press skips, and the state advances *exactly* as if the
   * presentation had run its course. The renderer completes its timelines; the engine only decided
   * that doing so was legal.
   */
  it('a press skips it and lands in the same place', () => {
    const skipped = step(presenting, { type: 'PRESS' });
    const completed = step(presenting, { type: 'PRESENTATION_COMPLETE' });

    expect(skipped.state).toEqual(completed.state);
    expect(skipped.effects).toEqual(completed.effects);
    expect(typesOf(skipped.events)[0]).toBe('SKIPPED');
  });
});

describe('SETTLING', () => {
  it('credits and returns to idle', () => {
    const response = settleRes({ totalWin: 500 });
    const { state, events } = step(STATES.SETTLING, { type: 'SETTLE_RESOLVED', response });

    expect(state.phase).toBe('IDLE');
    expect(sessionOf(state)?.balance).toBe(response.balance);
    expect(typesOf(events)).toEqual(['PHASE_CHANGED', 'ROUND_SETTLED', 'BALANCE_CHANGED']);
  });

  it('reports a capped payout so the player can be told', () => {
    const { events } = step(STATES.SETTLING, {
      type: 'SETTLE_RESOLVED',
      response: settleRes({ totalWin: 100, capped: true }),
    });

    expect(events).toContainEqual(expect.objectContaining({ type: 'ROUND_SETTLED', capped: true }));
  });

  it('ignores a press — the round is finishing', () => {
    const { events } = step(STATES.SETTLING, { type: 'PRESS' });
    expect(typesOf(events)).toEqual(['INPUT_REJECTED']);
  });
});

/* ── features ─────────────────────────────────────────────────────────────────────────────── */

describe('a feature round', () => {
  const triggered = drive(
    IDLE,
    { type: 'PRESS' },
    {
      type: 'SPIN_RESOLVED',
      response: spinRes({ totalWin: 200, feature: feature(), next: 'FEATURE_SPIN' }),
    },
    { type: 'REELS_STOPPED' },
    { type: 'PRESENTATION_COMPLETE' },
  );

  it('plays the intro before the first free spin', () => {
    expect(triggered.state.phase).toBe('FEATURE_INTRO');
    expect(typesOf(triggered.events)).toContain('FEATURE_AWARDED');
    expect(triggered.effects).toEqual([]);
  });

  it('starts free spin one when the intro finishes', () => {
    const { state, effects } = step(triggered.state, { type: 'INTRO_COMPLETE' });

    expect(state.phase).toBe('FEATURE_SPINNING');
    expect(effects).toEqual([
      { type: 'CALL_FEATURE_SPIN', request: { roundId: ROUND_ID, step: 1 } },
    ]);
  });

  it('a press skips the intro and starts the same spin', () => {
    const skipped = step(triggered.state, { type: 'PRESS' });
    const completed = step(triggered.state, { type: 'INTRO_COMPLETE' });

    expect(skipped.effects).toEqual(completed.effects);
    expect(typesOf(skipped.events)).toContain('SKIPPED');
  });

  it('reports progress the server calculated, and asks for the next step', () => {
    const spinning = step(triggered.state, { type: 'INTRO_COMPLETE' }).state;
    const landed = step(spinning, {
      type: 'FEATURE_SPIN_RESOLVED',
      response: featureSpinRes(1, { totalWin: 50 }),
    });

    expect(typesOf(landed.events)).toContain('FEATURE_PROGRESS');

    const next = drive(landed.state, { type: 'REELS_STOPPED' }, { type: 'PRESENTATION_COMPLETE' });
    expect(next.effects).toEqual([
      { type: 'CALL_FEATURE_SPIN', request: { roundId: ROUND_ID, step: 2 } },
    ]);
  });

  /** A retrigger is the server's arithmetic; the engine only forwards the numbers it was given. */
  it('forwards a retriggered total without recomputing it', () => {
    const spinning = step(triggered.state, { type: 'INTRO_COMPLETE' }).state;
    const retriggered = feature({ total: 20, remaining: 19, step: 1 });
    const { events } = step(spinning, {
      type: 'FEATURE_SPIN_RESOLVED',
      response: featureSpinRes(1, { feature: retriggered }),
    });

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'FEATURE_PROGRESS', feature: retriggered }),
    );
  });

  it('runs the outro after the last free spin, then settles', () => {
    const spinning = step(triggered.state, { type: 'INTRO_COMPLETE' }).state;
    const last = feature({ total: 10, remaining: 0, step: 10 });
    const stopped = step(spinning, {
      type: 'FEATURE_SPIN_RESOLVED',
      response: featureSpinRes(10, { roundWin: 750, feature: last, next: 'SETTLE' }),
    }).state;

    // This last free spin paid nothing, so there is no presentation to sit through — the reels
    // landing is enough to end the feature.
    const outro = step(stopped, { type: 'REELS_STOPPED' });
    expect(outro.state.phase).toBe('FEATURE_OUTRO');
    // The outro counts to the round's **payable** total, not to the last spin's win.
    expect(outro.events).toContainEqual({ type: 'FEATURE_ENDED', roundWin: minor(750) });

    const settling = step(outro.state, { type: 'OUTRO_COMPLETE' });
    expect(settling.state.phase).toBe('SETTLING');
    expect(settling.effects).toEqual([{ type: 'CALL_SETTLE', request: { roundId: ROUND_ID } }]);
  });

  it('runs the outro after a *winning* last free spin too, once its presentation is done', () => {
    const spinning = step(triggered.state, { type: 'INTRO_COMPLETE' }).state;
    const last = feature({ total: 10, remaining: 0, step: 10 });
    const presenting = drive(
      spinning,
      {
        type: 'FEATURE_SPIN_RESOLVED',
        response: featureSpinRes(10, {
          totalWin: 150,
          roundWin: 900,
          feature: last,
          next: 'SETTLE',
        }),
      },
      { type: 'REELS_STOPPED' },
    );

    expect(presenting.state.phase).toBe('WIN_PRESENTATION');
    expect(step(presenting.state, { type: 'PRESENTATION_COMPLETE' }).state.phase).toBe(
      'FEATURE_OUTRO',
    );
  });

  it('refuses a feature spin the server did not describe', () => {
    // A response asking for FEATURE_SPIN with no feature is the two sides disagreeing about
    // reality, which is FATAL rather than something to guess at.
    const broken = drive(
      IDLE,
      { type: 'PRESS' },
      { type: 'SPIN_RESOLVED', response: spinRes({ totalWin: 10, next: 'FEATURE_SPIN' }) },
      { type: 'REELS_STOPPED' },
      { type: 'PRESENTATION_COMPLETE' },
    );

    expect(broken.state.phase).toBe('ERROR');
    expect(broken.state).toMatchObject({ recovery: 'FROZEN' });
  });
});

/* ── errors ───────────────────────────────────────────────────────────────────────────────── */

describe('errors, by class', () => {
  const spinning = step(IDLE, { type: 'PRESS' }).state;
  const fail = (code: ErrorCode) =>
    step(spinning, { type: 'CALL_FAILED', error: new SlotError(code, 'injected') });

  it('offers a retry for a RECOVERABLE failure', () => {
    const { state, events } = fail('TIMEOUT');

    expect(state).toMatchObject({ phase: 'ERROR', recovery: 'RETRY' });
    expect(typesOf(events)).toContain('ERROR_RAISED');
  });

  /**
   * The retry request is **rebuilt from the state it failed in**, so the `roundId` is the round that
   * is still open. A retry structurally cannot mint a new one.
   */
  it('re-issues the identical call on retry', () => {
    const errored = fail('TIMEOUT').state;
    const { state, effects } = step(errored, { type: 'RETRY' });

    expect(state.phase).toBe('SPINNING');
    expect(effects).toEqual([{ type: 'CALL_SPIN', request: { roundId: ROUND_ID, stake: STAKE } }]);
  });

  it('returns a PLAYER failure to idle, with no retry offered', () => {
    const errored = fail('INSUFFICIENT_FUNDS').state;
    expect(errored).toMatchObject({ recovery: 'DISMISS' });

    expect(typesOf(step(errored, { type: 'RETRY' }).events)).toEqual(['INPUT_REJECTED']);
    expect(step(errored, { type: 'DISMISS_ERROR' }).state.phase).toBe('IDLE');
  });

  it('freezes on a FATAL failure, with no way out', () => {
    const errored = fail('ROUND_CONFLICT').state;
    expect(errored).toMatchObject({ recovery: 'FROZEN' });

    for (const input of [
      { type: 'RETRY' },
      { type: 'DISMISS_ERROR' },
      { type: 'PRESS' },
    ] as const) {
      expect(step(errored, input).state.phase).toBe('ERROR');
    }
  });

  it('keeps the original failure when a second one arrives', () => {
    const first = fail('TIMEOUT').state;
    const second = step(first, {
      type: 'CALL_FAILED',
      error: new SlotError('WALLET_UNAVAILABLE', 'again'),
    }).state;

    // The resume point is still the spin, not the error state — errors do not nest.
    expect(second).toMatchObject({ resume: { phase: 'SPINNING' } });
  });

  it('still shows the HUD numbers while errored', () => {
    expect(sessionOf(fail('TIMEOUT').state)).toMatchObject({ balance: BALANCE, stake: STAKE });
  });
});

/* ── resume ───────────────────────────────────────────────────────────────────────────────── */

describe('resuming from pendingRound', () => {
  const pending = (over: Partial<PendingRound>): PendingRound => ({
    roundId: ROUND_ID,
    state: 'RESOLVED',
    stake: STAKE,
    roundWin: minor(500),
    capped: false,
    result: result(500),
    next: 'SETTLE',
    ...over,
  });

  it('goes straight to idle when nothing was in flight', () => {
    expect(step(initialState, { type: 'AUTHENTICATED', response: authRes() }).state.phase).toBe(
      'IDLE',
    );
  });

  /** Debited but never resolved: the server resolves it when the same id arrives again. */
  it('re-sends a spin that was debited but never resolved', () => {
    const { state, effects } = step(initialState, {
      type: 'AUTHENTICATED',
      response: authRes(pending({ state: 'OPEN', next: 'FEATURE_SPIN', result: undefined })),
    });

    expect(state.phase).toBe('SPINNING');
    expect(effects).toEqual([{ type: 'CALL_SPIN', request: { roundId: ROUND_ID, stake: STAKE } }]);
  });

  it('lands the reels on a resolved round and settles it', () => {
    const resumed = step(initialState, {
      type: 'AUTHENTICATED',
      response: authRes(pending({})),
    });

    expect(resumed.state.phase).toBe('STOPPING');
    // Slammed: the player has already waited through a reload, so the reels do not tease twice.
    expect(resumed.events).toContainEqual(
      expect.objectContaining({ type: 'REELS_TARGETED', slam: true }),
    );

    const settling = drive(
      resumed.state,
      { type: 'REELS_STOPPED' },
      { type: 'PRESENTATION_COMPLETE' },
    );
    expect(settling.effects).toEqual([{ type: 'CALL_SETTLE', request: { roundId: ROUND_ID } }]);
  });

  it('resumes a feature at the step after the last one played', () => {
    const resumed = step(initialState, {
      type: 'AUTHENTICATED',
      response: authRes(
        pending({
          state: 'OPEN',
          next: 'FEATURE_SPIN',
          feature: feature({ step: 6, remaining: 4 }),
        }),
      ),
    });

    const next = drive(resumed.state, { type: 'REELS_STOPPED' }, { type: 'PRESENTATION_COMPLETE' });

    expect(next.effects).toEqual([
      { type: 'CALL_FEATURE_SPIN', request: { roundId: ROUND_ID, step: 7 } },
    ]);
  });

  it('restores the stake the round was played at, not the default', () => {
    const stake = CONFIG.betLevels[5];
    if (stake === undefined) throw new Error('the fixture config has too few bet levels');

    const { state } = step(initialState, {
      type: 'AUTHENTICATED',
      response: authRes(pending({ stake })),
    });

    expect(sessionOf(state)?.stake).toBe(stake);
  });
});

/* ── the max-win ceiling ──────────────────────────────────────────────────────────────────── */

/**
 * The counter, the banner and the credit have to agree.
 *
 * The server states the payable total on the way in (`roundWin`); the engine's only job is never to
 * present more than it. It was the presentation counting up to `result.totalWin` — the raw math —
 * while `settle` credited the capped figure that made those three numbers disagree.
 */
describe('a capped round', () => {
  const capped = drive(
    IDLE,
    { type: 'PRESS' },
    {
      type: 'SPIN_RESOLVED',
      // The grid paid 50,000; the ceiling lets 5,000 of it through.
      response: spinRes({ totalWin: 50_000, roundWin: 5_000, capped: true, next: 'SETTLE' }),
    },
    { type: 'REELS_STOPPED' },
  );

  it('presents the payable total, not the raw one', () => {
    expect(capped.events).toContainEqual(
      expect.objectContaining({ type: 'WINS_PRESENTED', totalWin: minor(5_000) }),
    );
  });

  it('presents the raw win when nothing was clipped', () => {
    const ordinary = drive(
      IDLE,
      { type: 'PRESS' },
      { type: 'SPIN_RESOLVED', response: spinRes({ totalWin: 500, next: 'SETTLE' }) },
      { type: 'REELS_STOPPED' },
    );

    expect(ordinary.events).toContainEqual(
      expect.objectContaining({ type: 'WINS_PRESENTED', totalWin: minor(500) }),
    );
  });

  it('counts a feature outro to the round total the server capped', () => {
    const triggered = drive(
      IDLE,
      { type: 'PRESS' },
      {
        type: 'SPIN_RESOLVED',
        response: spinRes({ feature: feature(), next: 'FEATURE_SPIN', roundWin: 0 }),
      },
      { type: 'REELS_STOPPED' },
      { type: 'INTRO_COMPLETE' },
      {
        type: 'FEATURE_SPIN_RESOLVED',
        response: featureSpinRes(10, {
          totalWin: 99_000,
          roundWin: 5_000,
          capped: true,
          feature: feature({ total: 10, remaining: 0, step: 10 }),
          next: 'SETTLE',
        }),
      },
      { type: 'REELS_STOPPED' },
      { type: 'PRESENTATION_COMPLETE' },
    );

    expect(triggered.events).toContainEqual({ type: 'FEATURE_ENDED', roundWin: minor(5_000) });
  });
});

/* ── the math version gate ────────────────────────────────────────────────────────────────── */

/**
 * The one deploy mistake nothing else in the workspace notices.
 *
 * Every other test here builds its config from the same `@slot/game-math` the reducer imports, so
 * the versions agree by construction — which is exactly the blind spot: a deployed server and a
 * deployed client are two builds, and nothing but this check puts their versions side by side.
 */
describe('the math version gate', () => {
  const servedOn = (mathVersion: string) => ({
    ...authRes(),
    config: { ...CONFIG, mathVersion },
  });

  it('accepts the version this build implements', () => {
    expect(CONFIG.mathVersion).toBe(MATH_VERSION);
    expect(step(initialState, { type: 'AUTHENTICATED', response: authRes() }).state.phase).toBe(
      'IDLE',
    );
  });

  it('freezes when the server is paying on a different math version', () => {
    const { state, events } = step(initialState, {
      type: 'AUTHENTICATED',
      response: servedOn('1.0.0'),
    });

    expect(state).toMatchObject({ phase: 'ERROR', recovery: 'FROZEN' });
    expect(state.phase === 'ERROR' && state.error.code).toBe('MATH_VERSION_MISMATCH');
    // Both versions are in the message, because the first question anybody asks is "which two?".
    expect(state.phase === 'ERROR' && state.error.message).toContain(MATH_VERSION);
    expect(state.phase === 'ERROR' && state.error.message).toContain('1.0.0');
    expect(typesOf(events)).toContain('ERROR_RAISED');
  });

  /** Any difference at all. A version that moved for a cosmetic reason is a versioning mistake. */
  it('refuses a version that differs only in its patch number', () => {
    const { state } = step(initialState, {
      type: 'AUTHENTICATED',
      response: servedOn(`${MATH_VERSION}-rc.1`),
    });

    expect(state.phase).toBe('ERROR');
  });

  /**
   * The case that would otherwise slip through: a mismatched client with a round already in flight
   * would land the reels on an outcome it cannot reproduce *before* anyone noticed the versions.
   */
  it('refuses to continue a round in flight rather than presenting it', () => {
    const { state, effects } = step(initialState, {
      type: 'AUTHENTICATED',
      response: {
        ...servedOn('1.0.0'),
        pendingRound: {
          roundId: ROUND_ID,
          state: 'RESOLVED',
          stake: STAKE,
          roundWin: minor(500),
          capped: false,
          result: result(500),
          next: 'SETTLE',
        },
      },
    });

    expect(state).toMatchObject({ phase: 'ERROR', recovery: 'FROZEN' });
    expect(effects).toEqual([]);
  });

  it('offers no way out, because there is none', () => {
    const frozen = step(initialState, {
      type: 'AUTHENTICATED',
      response: servedOn('1.0.0'),
    }).state;

    for (const input of [
      { type: 'PRESS' },
      { type: 'DISMISS_ERROR' },
      { type: 'RETRY' },
    ] as const) {
      expect(step(frozen, input).state.phase).toBe('ERROR');
    }
  });
});

/* ── the transparent re-authenticate ──────────────────────────────────────────────────────── */

/**
 * docs/protocol.md §5, D9: a session that expires under an open round renews itself instead of
 * abandoning the money. The class stays `PLAYER` — retrying the failed call changes nothing — but
 * with a lobby to ask, the machine asks it, and the round carries on.
 */
describe('SESSION_EXPIRED under an open round', () => {
  const lobby = { newRoundId: () => ROUND_ID, canReauthenticate: true };
  const renew = (state: EngineState, input: EngineInput) => reduce(state, input, lobby);
  const expired = new SlotError('SESSION_EXPIRED', 'the session has expired');

  const renewing = (from: EngineState = STATES.SETTLING) =>
    renew(from, { type: 'CALL_FAILED', error: expired }).state;

  it('renews instead of raising a modal when the failure hit a call phase', () => {
    const { state, events, effects } = renew(STATES.SPINNING, {
      type: 'CALL_FAILED',
      error: expired,
    });

    expect(state.phase).toBe('REAUTHENTICATING');
    expect(typesOf(events)).toEqual(['PHASE_CHANGED', 'SESSION_RENEWING']);
    expect(effects).toEqual([{ type: 'CALL_REAUTHENTICATE' }]);
  });

  it('stays an ordinary PLAYER modal without a lobby to ask', () => {
    const { state } = step(STATES.SPINNING, { type: 'CALL_FAILED', error: expired });

    expect(state).toMatchObject({ phase: 'ERROR', recovery: 'DISMISS' });
  });

  it('stays a modal when no round is open — nothing would be abandoned', () => {
    const { state } = renew(initialState, { type: 'CALL_FAILED', error: expired });

    expect(state).toMatchObject({ phase: 'ERROR', recovery: 'DISMISS' });
  });

  it('still shows the HUD numbers while renewing', () => {
    expect(sessionOf(renewing())).toMatchObject({ balance: BALANCE, stake: STAKE });
  });

  it('rejects a press while renewing — nothing is asked of the player', () => {
    const { events } = renew(renewing(), { type: 'PRESS' });

    expect(typesOf(events)).toEqual(['INPUT_REJECTED']);
  });

  it('resumes from pendingRound when the fresh session reports the round', () => {
    const fromFeature = renewing(STATES.FEATURE_SPINNING);
    const { state, events } = renew(fromFeature, {
      type: 'REAUTHENTICATED',
      response: authRes({
        roundId: ROUND_ID,
        state: 'RESOLVED',
        stake: STAKE,
        roundWin: minor(500),
        capped: false,
        result: result(500),
        next: 'SETTLE',
      }),
    });

    // Exactly the §5 resume a reload performs: the server's account of the round wins.
    expect(state.phase).toBe('STOPPING');
    expect(events).toContainEqual(expect.objectContaining({ type: 'REELS_TARGETED', slam: true }));
  });

  it('re-drives the interrupted spin when the fresh session carries no round', () => {
    const fromSpin = renewing(STATES.SPINNING);
    const { state, events, effects } = renew(fromSpin, {
      type: 'REAUTHENTICATED',
      response: authRes(),
    });

    // The refused spin never happened server-side; the same roundId runs it under the new session.
    expect(state.phase).toBe('SPINNING');
    expect(effects).toEqual([{ type: 'CALL_SPIN', request: { roundId: ROUND_ID, stake: STAKE } }]);
    expect(typesOf(events)).toContain('BALANCE_CHANGED');
  });

  it('re-drives the settle when the fresh session carries no round — a replay, not a loss', () => {
    const { state, effects } = renew(renewing(), {
      type: 'REAUTHENTICATED',
      response: authRes(),
    });

    expect(state.phase).toBe('SETTLING');
    expect(effects).toEqual([{ type: 'CALL_SETTLE', request: { roundId: ROUND_ID } }]);
  });

  it('holds the math gate on the renewed session too', () => {
    const { state } = renew(renewing(), {
      type: 'REAUTHENTICATED',
      response: { ...authRes(), config: { ...CONFIG, mathVersion: '1.0.0' } },
    });

    expect(state).toMatchObject({ phase: 'ERROR', recovery: 'FROZEN' });
  });

  it('offers a retry when the renewal itself fails recoverably', () => {
    const errored = renew(renewing(), {
      type: 'CALL_FAILED',
      error: new SlotError('UPSTREAM_UNAVAILABLE', 'lobby down'),
    });
    expect(errored.state).toMatchObject({ phase: 'ERROR', recovery: 'RETRY' });

    const retried = renew(errored.state, { type: 'RETRY' });
    expect(retried.state.phase).toBe('REAUTHENTICATING');
    expect(retried.effects).toEqual([{ type: 'CALL_REAUTHENTICATE' }]);
  });

  it('does not loop: a second expiry during the renewal is the ordinary modal', () => {
    const { state } = renew(renewing(), { type: 'CALL_FAILED', error: expired });

    expect(state).toMatchObject({ phase: 'ERROR', recovery: 'DISMISS' });
  });

  it('rejects a REAUTHENTICATED that arrives in any other phase', () => {
    const { events } = renew(STATES.IDLE, { type: 'REAUTHENTICATED', response: authRes() });

    expect(typesOf(events)).toEqual(['INPUT_REJECTED']);
  });
});

/* ── totality ─────────────────────────────────────────────────────────────────────────────── */

const ALL_INPUTS: EngineInput[] = [
  { type: 'AUTHENTICATED', response: authRes() },
  { type: 'REAUTHENTICATED', response: authRes() },
  { type: 'PRESS' },
  { type: 'SET_STAKE', stake: STAKE },
  { type: 'REELS_STOPPED' },
  { type: 'PRESENTATION_COMPLETE' },
  { type: 'INTRO_COMPLETE' },
  { type: 'OUTRO_COMPLETE' },
  { type: 'SPIN_RESOLVED', response: spinRes() },
  { type: 'FEATURE_SPIN_RESOLVED', response: featureSpinRes(1) },
  { type: 'SETTLE_RESOLVED', response: settleRes() },
  { type: 'CALL_FAILED', error: new SlotError('TIMEOUT', 'x') },
  { type: 'RETRY' },
  { type: 'DISMISS_ERROR' },
];

describe('every phase answers every input', () => {
  /**
   * The bug class this whole design exists to kill: an input arriving in a state that cannot service
   * it. Every pair must either transition or be rejected out loud — never throw, never silently
   * corrupt. This is the test that would catch a phase added to the union and forgotten in a switch.
   */
  it.each(PHASES)('%s', (phase: Phase) => {
    const state = STATES[phase];

    for (const input of ALL_INPUTS) {
      const transition = step(state, input);

      expect(PHASES).toContain(transition.state.phase);
      const rejected = transition.events.some((event) => event.type === 'INPUT_REJECTED');
      const moved = transition.state !== state;
      expect(rejected || moved || transition.events.length > 0).toBe(true);
    }
  });

  it('names the input it dropped, so a debug log can show it', () => {
    const { events } = step(STATES.SETTLING, { type: 'INTRO_COMPLETE' });

    expect(events).toEqual([
      { type: 'INPUT_REJECTED', input: 'INTRO_COMPLETE' satisfies InputType, phase: 'SETTLING' },
    ]);
  });

  it('never invents a balance', () => {
    // Every phase change that moves money takes the number straight from a response.
    const round = drive(
      IDLE,
      { type: 'PRESS' },
      { type: 'SPIN_RESOLVED', response: spinRes({ totalWin: 500, next: 'SETTLE' }) },
      { type: 'REELS_STOPPED' },
      { type: 'PRESENTATION_COMPLETE' },
      { type: 'SETTLE_RESOLVED', response: settleRes({ totalWin: 500 }) },
    );

    expect(sessionOf(round.state)?.balance).toBe(settleRes({ totalWin: 500 }).balance);
  });
});

describe('the force-outcome hook', () => {
  /**
   * A development affordance, and the reason it is here rather than in the driver: the spin request
   * is built in this file. Neither of its two gates is in this package — the client only supplies a
   * provider behind `__DEV_TOOLS__`, and the server refuses the field outside dev mode.
   */
  it('puts the forced outcome on the spin request when a provider offers one', () => {
    const { effects } = reduce(
      IDLE,
      { type: 'PRESS' },
      {
        newRoundId: () => ROUND_ID,
        forceOutcome: () => ({ scenario: 'MAX_WIN' }),
      },
    );

    expect(effects).toEqual([
      {
        type: 'CALL_SPIN',
        request: { roundId: ROUND_ID, stake: STAKE, forceOutcome: { scenario: 'MAX_WIN' } },
      },
    ]);
  });

  /** Absent, not `undefined`: the field must not appear on the wire at all in an ordinary spin. */
  it('leaves the field off entirely when the provider declines', () => {
    const { effects } = reduce(
      IDLE,
      { type: 'PRESS' },
      {
        newRoundId: () => ROUND_ID,
        forceOutcome: () => undefined,
      },
    );

    const [effect] = effects;
    expect(effect?.type).toBe('CALL_SPIN');
    expect(Object.keys((effect as { request: object }).request)).toEqual(['roundId', 'stake']);
  });

  it('is consulted once per spin, so a one-shot provider forces exactly one round', () => {
    let remaining = 1;
    const context = {
      newRoundId: () => ROUND_ID,
      forceOutcome: () => (remaining-- > 0 ? ({ scenario: 'NEAR_MISS' } as const) : undefined),
    };

    const first = reduce(IDLE, { type: 'PRESS' }, context);
    const second = reduce(IDLE, { type: 'PRESS' }, context);

    expect(JSON.stringify(first.effects)).toContain('NEAR_MISS');
    expect(JSON.stringify(second.effects)).not.toContain('NEAR_MISS');
  });
});
