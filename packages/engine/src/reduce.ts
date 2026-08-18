import type { ForceOutcome, Minor, RoundIdFactory } from '@slot/protocol';
import { SlotError } from '@slot/protocol';
import type {
  EngineEffect,
  EngineEvent,
  EngineInput,
  EngineState,
  Recovery,
  Transition,
} from './types.js';

/**
 * The round FSM: `(state, input) → (state, events, effects)`.
 *
 * Pure, total, and free of Pixi, the DOM and the network — a state machine you can test without a
 * canvas is a state machine you can actually test. The `switch` at the bottom has no `default`, so
 * TypeScript proves every phase is handled; adding a phase to the union breaks the build until it
 * is.
 *
 * Two rules carry most of the value:
 *
 * 1. **Inputs are validated against the current phase.** There is one player input — `PRESS` — and
 *    what it means depends on where the machine is: a spin from `IDLE`, a slam stop from `SPINNING`,
 *    a skip from `WIN_PRESENTATION`. A press that the phase cannot service is *rejected*, never
 *    queued. That single rule kills the most common class of slot bug — the second spin that starts
 *    while the first is still paying out.
 * 2. **The engine decides that an interruption is legal; the renderer implements it.** A skip emits
 *    `SKIPPED` and advances the state; completing the timelines is somebody else's job. Keeping
 *    that split is why the behaviour stays testable.
 */

export interface ReduceContext {
  /** Mints round ids. Injected, because this package may not reach for `crypto` (or a clock). */
  newRoundId: RoundIdFactory;
  /**
   * A forced outcome for the **next** spin, or `undefined` for a real one.
   *
   * A development affordance with two independent gates, and this is neither of them: the client
   * only supplies a provider behind `__DEV_TOOLS__` (so a production bundle has no way to ask), and
   * the server refuses the field unless `GameConfig.devMode` is on (docs/protocol.md §8). It lives
   * here rather than in the driver because the request is built here — and because C4 and C5 present
   * near misses, features and max wins, which are otherwise developed by waiting for one.
   *
   * Consulted once per **base** spin. A free spin inside a feature is not forced: getting *into* the
   * feature on demand is what makes it developable, and threading the provider through the feature
   * sequencing would buy a second dev affordance nobody has asked for yet.
   */
  forceOutcome?: () => ForceOutcome | undefined;
}

/** `{ forceOutcome }` only when there is one — the field must be absent, not undefined, on the wire. */
const forced = (context: ReduceContext): { forceOutcome?: ForceOutcome } => {
  const outcome = context.forceOutcome?.();
  return outcome === undefined ? {} : { forceOutcome: outcome };
};

/* ── builders ─────────────────────────────────────────────────────────────────────────────── */

const nothing = (state: EngineState): Transition => ({ state, events: [], effects: [] });

/** An input this phase cannot service. Dropped, and said out loud so a debug log can show it. */
const rejectInput = (state: EngineState, input: EngineInput): Transition => ({
  state,
  events: [{ type: 'INPUT_REJECTED', input: input.type, phase: state.phase }],
  effects: [],
});

const move = (
  from: EngineState,
  to: EngineState,
  events: EngineEvent[] = [],
  effects: EngineEffect[] = [],
): Transition => ({
  state: to,
  events:
    from.phase === to.phase
      ? events
      : [{ type: 'PHASE_CHANGED', from: from.phase, to: to.phase }, ...events],
  effects,
});

/* ── errors ───────────────────────────────────────────────────────────────────────────────── */

/**
 * The error taxonomy, as behaviour rather than documentation.
 *
 * `RECOVERABLE` keeps the round alive and offers a retry; `PLAYER` returns to `IDLE` with a modal
 * and no retry, because retrying changes nothing; `FATAL` freezes, because the client and the server
 * disagree about reality and improvising is the one thing that must not happen.
 */
const recoveryFor = (error: SlotError): Recovery =>
  error.errorClass === 'RECOVERABLE'
    ? 'RETRY'
    : error.errorClass === 'PLAYER'
      ? 'DISMISS'
      : 'FROZEN';

const raise = (state: EngineState, error: SlotError): Transition => {
  const recovery = recoveryFor(error);
  // Never nest an error inside an error: a failure while already failed resumes to the same place.
  const resume = state.phase === 'ERROR' ? state.resume : state;

  return move(state, { phase: 'ERROR', error, recovery, resume }, [
    { type: 'ERROR_RAISED', error, recovery },
  ]);
};

/**
 * The call that would re-drive this phase, rebuilt from the phase itself.
 *
 * Deriving it rather than remembering it is what makes "a retry reuses the same `roundId`" a
 * structural property instead of a convention someone has to keep.
 */
const effectFor = (state: EngineState): EngineEffect | undefined => {
  switch (state.phase) {
    case 'SPINNING':
      return { type: 'CALL_SPIN', request: { roundId: state.roundId, stake: state.stake } };
    case 'FEATURE_SPINNING':
      return {
        type: 'CALL_FEATURE_SPIN',
        request: { roundId: state.roundId, step: state.step },
      };
    case 'SETTLING':
      return { type: 'CALL_SETTLE', request: { roundId: state.roundId } };
    default:
      return undefined;
  }
};

/* ── the shared "what happens after the presentation" step ────────────────────────────────── */

/**
 * Advance out of a presentation according to the server's `next`.
 *
 * The client never infers this from the result — it is told. A feature that ends goes through its
 * outro first; everything else goes straight to the call the server asked for.
 */
function advance(
  state: Extract<EngineState, { phase: 'WIN_PRESENTATION' | 'STOPPING' }>,
): Transition {
  const base = { config: state.config, balance: state.balance, stake: state.stake };
  const round = { roundId: state.roundId, result: state.result, feature: state.feature };

  switch (state.next) {
    case 'IDLE':
      // A zero-win base round settled atomically on the server. Nothing to credit, nothing to call.
      return move(state, { phase: 'IDLE', ...base });

    case 'FEATURE_SPIN': {
      const feature = state.feature;
      if (feature === undefined) {
        // The server asked for a free spin without saying what feature it belongs to. That is a
        // disagreement about reality, not something to guess at.
        return raise(state, illegal('the server asked for a feature spin but sent no feature'));
      }

      // Step 0 means the feature has just been awarded and its intro has not played yet.
      if (feature.step === 0) {
        return move(state, { phase: 'FEATURE_INTRO', ...base, ...round }, [
          { type: 'FEATURE_AWARDED', total: feature.total },
        ]);
      }

      const step = feature.step + 1;
      return move(
        state,
        { phase: 'FEATURE_SPINNING', ...base, ...round, step, slam: false },
        [],
        [{ type: 'CALL_FEATURE_SPIN', request: { roundId: state.roundId, step } }],
      );
    }

    case 'SETTLE': {
      // A feature that has run out gets its outro before the credit lands.
      if (state.feature !== undefined) {
        return move(state, { phase: 'FEATURE_OUTRO', ...base, ...round }, [
          { type: 'FEATURE_ENDED', cumulativeWin: state.feature.cumulativeWin },
        ]);
      }

      return move(
        state,
        { phase: 'SETTLING', ...base, ...round },
        [],
        [{ type: 'CALL_SETTLE', request: { roundId: state.roundId } }],
      );
    }
  }
}

/**
 * A `FATAL` the engine raises itself when the server's own response does not hang together — a
 * feature spin with no feature, a resolved round with no result. `ILLEGAL_TRANSITION` is right for
 * these: the two sides disagree about reality, and there is nothing safe to improvise.
 */
const illegal = (message: string): SlotError => new SlotError('ILLEGAL_TRANSITION', message);

/* ── phase handlers ───────────────────────────────────────────────────────────────────────── */

function idle(
  state: Extract<EngineState, { phase: 'IDLE' }>,
  input: EngineInput,
  context: ReduceContext,
): Transition {
  switch (input.type) {
    case 'PRESS': {
      const roundId = context.newRoundId();
      return move(
        state,
        {
          phase: 'SPINNING',
          config: state.config,
          balance: state.balance,
          stake: state.stake,
          roundId,
          slam: false,
        },
        [{ type: 'SPIN_STARTED', roundId, stake: state.stake }],
        [{ type: 'CALL_SPIN', request: { roundId, stake: state.stake, ...forced(context) } }],
      );
    }

    case 'SET_STAKE': {
      // Validated against the config the server sent: the bet ladder is the server's, and a stake
      // off it would be rejected on the next spin anyway. Better to refuse the input than the round.
      if (!state.config.betLevels.includes(input.stake)) return rejectInput(state, input);
      return move(state, { ...state, stake: input.stake }, [
        { type: 'STAKE_CHANGED', stake: input.stake },
      ]);
    }

    default:
      return rejectInput(state, input);
  }
}

function spinning(
  state: Extract<EngineState, { phase: 'SPINNING' }>,
  input: EngineInput,
): Transition {
  switch (input.type) {
    case 'SPIN_RESOLVED': {
      const { response } = input;
      return move(
        state,
        {
          phase: 'STOPPING',
          config: state.config,
          balance: response.balance,
          stake: state.stake,
          roundId: state.roundId,
          result: response.result,
          feature: response.feature,
          next: response.next,
          slam: state.slam,
        },
        [
          { type: 'BALANCE_CHANGED', balance: response.balance },
          {
            type: 'REELS_TARGETED',
            stops: response.result.stops,
            view: response.result.view,
            slam: state.slam,
          },
        ],
      );
    }

    // The slam stop. The engine records that the player asked; the renderer takes the shortest
    // legal deceleration when the outcome lands.
    case 'PRESS':
      if (state.slam) return rejectInput(state, input);
      return move(state, { ...state, slam: true }, [{ type: 'SKIPPED', phase: 'SPINNING' }]);

    default:
      return rejectInput(state, input);
  }
}

function stopping(
  state: Extract<EngineState, { phase: 'STOPPING' }>,
  input: EngineInput,
): Transition {
  switch (input.type) {
    case 'REELS_STOPPED': {
      // No win means nothing to present — go straight on. A feature can still have been awarded.
      if (state.result.totalWin <= 0) return advance(state);

      return move(
        state,
        {
          phase: 'WIN_PRESENTATION',
          config: state.config,
          balance: state.balance,
          stake: state.stake,
          roundId: state.roundId,
          result: state.result,
          feature: state.feature,
          next: state.next,
          wins: state.result.wins,
        },
        [
          {
            type: 'WINS_PRESENTED',
            wins: state.result.wins,
            totalWin: state.result.totalWin,
          },
        ],
      );
    }

    default:
      // Including `PRESS`: the reels are already on their way down, and the interruption contract
      // does not offer anything shorter than the slam that has already been applied.
      return rejectInput(state, input);
  }
}

function presenting(
  state: Extract<EngineState, { phase: 'WIN_PRESENTATION' }>,
  input: EngineInput,
): Transition {
  switch (input.type) {
    case 'PRESENTATION_COMPLETE':
      return advance(state);

    case 'PRESS': {
      // Skip: the renderer snaps its timelines to the end, the counter lands on the final number,
      // and the state advances exactly as if the presentation had run its course.
      const advanced = advance(state);
      return {
        ...advanced,
        events: [{ type: 'SKIPPED', phase: 'WIN_PRESENTATION' }, ...advanced.events],
      };
    }

    default:
      return rejectInput(state, input);
  }
}

function featureIntro(
  state: Extract<EngineState, { phase: 'FEATURE_INTRO' }>,
  input: EngineInput,
): Transition {
  if (input.type !== 'INTRO_COMPLETE' && input.type !== 'PRESS') return rejectInput(state, input);

  const feature = state.feature;
  if (feature === undefined) return raise(state, illegal('a feature intro with no feature'));

  const step = feature.step + 1;
  const skipped: EngineEvent[] =
    input.type === 'PRESS' ? [{ type: 'SKIPPED', phase: 'FEATURE_INTRO' }] : [];

  return move(
    state,
    {
      phase: 'FEATURE_SPINNING',
      config: state.config,
      balance: state.balance,
      stake: state.stake,
      roundId: state.roundId,
      result: state.result,
      feature,
      step,
      slam: false,
    },
    skipped,
    [{ type: 'CALL_FEATURE_SPIN', request: { roundId: state.roundId, step } }],
  );
}

function featureSpinning(
  state: Extract<EngineState, { phase: 'FEATURE_SPINNING' }>,
  input: EngineInput,
): Transition {
  switch (input.type) {
    case 'FEATURE_SPIN_RESOLVED': {
      const { response } = input;
      return move(
        state,
        {
          phase: 'STOPPING',
          config: state.config,
          // Unchanged by a free spin, but taken from the response all the same — the client never
          // decides that a balance did not move.
          balance: response.balance,
          stake: state.stake,
          roundId: state.roundId,
          result: response.result,
          feature: response.feature,
          next: response.next,
          slam: state.slam,
        },
        [
          { type: 'FEATURE_PROGRESS', feature: response.feature },
          {
            type: 'REELS_TARGETED',
            stops: response.result.stops,
            view: response.result.view,
            slam: state.slam,
          },
        ],
      );
    }

    case 'PRESS':
      if (state.slam) return rejectInput(state, input);
      return move(state, { ...state, slam: true }, [
        { type: 'SKIPPED', phase: 'FEATURE_SPINNING' },
      ]);

    default:
      return rejectInput(state, input);
  }
}

function featureOutro(
  state: Extract<EngineState, { phase: 'FEATURE_OUTRO' }>,
  input: EngineInput,
): Transition {
  if (input.type !== 'OUTRO_COMPLETE' && input.type !== 'PRESS') return rejectInput(state, input);

  const skipped: EngineEvent[] =
    input.type === 'PRESS' ? [{ type: 'SKIPPED', phase: 'FEATURE_OUTRO' }] : [];

  return move(
    state,
    {
      phase: 'SETTLING',
      config: state.config,
      balance: state.balance,
      stake: state.stake,
      roundId: state.roundId,
      result: state.result,
      feature: state.feature,
    },
    skipped,
    [{ type: 'CALL_SETTLE', request: { roundId: state.roundId } }],
  );
}

function settling(
  state: Extract<EngineState, { phase: 'SETTLING' }>,
  input: EngineInput,
): Transition {
  if (input.type !== 'SETTLE_RESOLVED') return rejectInput(state, input);

  const { response } = input;
  return move(
    state,
    { phase: 'IDLE', config: state.config, balance: response.balance, stake: state.stake },
    [
      {
        type: 'ROUND_SETTLED',
        totalWin: response.totalWin,
        capped: response.capped,
        balance: response.balance,
      },
      { type: 'BALANCE_CHANGED', balance: response.balance },
    ],
  );
}

function errored(state: Extract<EngineState, { phase: 'ERROR' }>, input: EngineInput): Transition {
  switch (input.type) {
    case 'RETRY': {
      if (state.recovery !== 'RETRY') return rejectInput(state, input);
      const effect = effectFor(state.resume);
      if (effect === undefined) return rejectInput(state, input);
      return move(state, state.resume, [{ type: 'ERROR_CLEARED' }], [effect]);
    }

    case 'DISMISS_ERROR': {
      if (state.recovery !== 'DISMISS') return rejectInput(state, input);
      const session = sessionOf(state.resume);
      if (session === undefined) return rejectInput(state, input);
      return move(state, { phase: 'IDLE', ...session }, [{ type: 'ERROR_CLEARED' }]);
    }

    // A resolution that arrives after the machine already gave up — a retry that finally answered,
    // for instance. Dropped rather than applied: the machine has moved on and re-entering a round
    // from a stale response is exactly the kind of improvisation `FATAL` exists to forbid.
    default:
      return rejectInput(state, input);
  }
}

/** The HUD numbers, where the phase has them. `BOOTING` and `ERROR` may not. */
export function sessionOf(
  state: EngineState,
): { config: EngineStateConfig; balance: Minor; stake: Minor } | undefined {
  if (state.phase === 'BOOTING') return undefined;
  if (state.phase === 'ERROR') return sessionOf(state.resume);
  return { config: state.config, balance: state.balance, stake: state.stake };
}

type EngineStateConfig = Extract<EngineState, { phase: 'IDLE' }>['config'];

/* ── resume ───────────────────────────────────────────────────────────────────────────────── */

/**
 * Rebuild the machine from `authenticate` — including a round that was left in flight.
 *
 * This *is* the recovery story (docs/protocol.md §5): there is no reconciliation endpoint and no
 * client-side replay of what it thinks happened. The server says where the round is, and the machine
 * drops into the phase that continues it, letting the ordinary transitions carry it home.
 */
function authenticated(
  state: EngineState,
  response: Extract<EngineInput, { type: 'AUTHENTICATED' }>['response'],
): Transition {
  const { config, balance } = response;
  const pending = response.pendingRound;
  const ready: EngineEvent[] = [
    { type: 'SESSION_READY', session: response.session, config, balance },
    { type: 'BALANCE_CHANGED', balance },
  ];

  const firstBetLevel = config.betLevels[0];
  if (firstBetLevel === undefined) {
    return raise(state, illegal('the server sent a config with no bet levels'));
  }

  const stake = pending?.stake ?? firstBetLevel;
  const base = { config, balance, stake };

  if (pending === undefined) return move(state, { phase: 'IDLE', ...base }, ready);

  // Debited but never resolved: the server resolves it when the same `roundId` is sent again, so
  // the machine goes back to waiting for exactly that call.
  if (pending.state === 'OPEN' && pending.feature === undefined) {
    return move(
      state,
      { phase: 'SPINNING', ...base, roundId: pending.roundId, slam: false },
      ready,
      [{ type: 'CALL_SPIN', request: { roundId: pending.roundId, stake } }],
    );
  }

  const result = pending.result;
  if (result === undefined) {
    return raise(state, illegal('the server sent a resolved pending round with no result'));
  }

  // Land the reels on what was already decided, then let the normal flow continue — into the next
  // free spin, or into the settle the server is waiting for.
  return move(
    state,
    {
      phase: 'STOPPING',
      ...base,
      roundId: pending.roundId,
      result,
      feature: pending.feature,
      next: pending.next,
      slam: true,
    },
    [
      ...ready,
      { type: 'REELS_TARGETED', stops: result.stops, view: result.view, slam: true },
      ...(pending.feature === undefined
        ? []
        : [{ type: 'FEATURE_PROGRESS', feature: pending.feature } as EngineEvent]),
    ],
  );
}

/* ── the reducer ──────────────────────────────────────────────────────────────────────────── */

export function reduce(state: EngineState, input: EngineInput, context: ReduceContext): Transition {
  // Two inputs any phase must answer the same way.
  if (input.type === 'CALL_FAILED') return raise(state, input.error);
  if (input.type === 'AUTHENTICATED') return authenticated(state, input.response);

  switch (state.phase) {
    case 'BOOTING':
      return rejectInput(state, input);
    case 'IDLE':
      return idle(state, input, context);
    case 'SPINNING':
      return spinning(state, input);
    case 'STOPPING':
      return stopping(state, input);
    case 'WIN_PRESENTATION':
      return presenting(state, input);
    case 'FEATURE_INTRO':
      return featureIntro(state, input);
    case 'FEATURE_SPINNING':
      return featureSpinning(state, input);
    case 'FEATURE_OUTRO':
      return featureOutro(state, input);
    case 'SETTLING':
      return settling(state, input);
    case 'ERROR':
      return errored(state, input);
  }
}

export const initialState: EngineState = { phase: 'BOOTING' };

export { nothing as noTransition };
