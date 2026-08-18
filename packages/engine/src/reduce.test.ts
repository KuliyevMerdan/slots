import { describe, expect, it } from 'vitest';
import type { ErrorCode, PendingRound } from '@slot/protocol';
import { SlotError } from '@slot/protocol';
import { minor } from '@slot/money';
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

    expect(events).toContainEqual({ type: 'FEATURE_PROGRESS', feature: retriggered });
  });

  it('runs the outro after the last free spin, then settles', () => {
    const spinning = step(triggered.state, { type: 'INTRO_COMPLETE' }).state;
    const last = feature({ total: 10, remaining: 0, step: 10, cumulativeWin: minor(750) });
    const stopped = step(spinning, {
      type: 'FEATURE_SPIN_RESOLVED',
      response: featureSpinRes(10, { feature: last, next: 'SETTLE' }),
    }).state;

    // This last free spin paid nothing, so there is no presentation to sit through — the reels
    // landing is enough to end the feature.
    const outro = step(stopped, { type: 'REELS_STOPPED' });
    expect(outro.state.phase).toBe('FEATURE_OUTRO');
    expect(outro.events).toContainEqual({ type: 'FEATURE_ENDED', cumulativeWin: minor(750) });

    const settling = step(outro.state, { type: 'OUTRO_COMPLETE' });
    expect(settling.state.phase).toBe('SETTLING');
    expect(settling.effects).toEqual([{ type: 'CALL_SETTLE', request: { roundId: ROUND_ID } }]);
  });

  it('runs the outro after a *winning* last free spin too, once its presentation is done', () => {
    const spinning = step(triggered.state, { type: 'INTRO_COMPLETE' }).state;
    const last = feature({ total: 10, remaining: 0, step: 10, cumulativeWin: minor(900) });
    const presenting = drive(
      spinning,
      {
        type: 'FEATURE_SPIN_RESOLVED',
        response: featureSpinRes(10, { totalWin: 150, feature: last, next: 'SETTLE' }),
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

/* ── totality ─────────────────────────────────────────────────────────────────────────────── */

const ALL_INPUTS: EngineInput[] = [
  { type: 'AUTHENTICATED', response: authRes() },
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
