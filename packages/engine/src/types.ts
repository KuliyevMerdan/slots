import type {
  AuthenticateRes,
  FeatureProgress,
  FeatureSpinReq,
  FeatureSpinRes,
  GameConfig,
  Minor,
  RoundId,
  RoundResult,
  SettleReq,
  SettleRes,
  SlotError,
  SpinReq,
  SpinRes,
  Win,
} from '@slot/protocol';
// The wire's session — who the player is, in what currency, until when. Aliased because this module
// already has a `Session`, which is a different thing: the money a phase carries.
import type { Session as PlayerSession } from '@slot/protocol';

/**
 * The round lifecycle, as a discriminated union.
 *
 * Every phase carries exactly the data that phase can have, which is the point of writing it this
 * way: there is no `result?: RoundResult` hanging off `IDLE` for someone to read by accident, and
 * the compiler proves the `switch` in `reduce.ts` is total. A slot has one genuinely hard bug class
 * — an input arriving in a state that cannot service it — and an exhaustive union is what turns
 * that from a runtime surprise into a compile error.
 */

export const PHASES = [
  'BOOTING',
  'IDLE',
  'SPINNING',
  'STOPPING',
  'WIN_PRESENTATION',
  'FEATURE_INTRO',
  'FEATURE_SPINNING',
  'FEATURE_OUTRO',
  'SETTLING',
  'REAUTHENTICATING',
  'ERROR',
] as const;

export type Phase = (typeof PHASES)[number];

/** Present in every phase that has a session: the numbers the HUD shows, always server-supplied. */
interface Session {
  config: GameConfig;
  /** Authoritative. The engine copies it from a response and never computes it. */
  balance: Minor;
  stake: Minor;
}

/** Carried by every phase inside an open round. */
interface Round {
  roundId: RoundId;
  /** The most recent spin's outcome — base or free spin. */
  result: RoundResult;
  /**
   * What this round will pay, as the server last stated it — already capped.
   *
   * Distinct from `result.totalWin`, which is what the math paid for the latest grid: the ceiling is
   * a fact about the round, and the presentation must count to the payable figure rather than the
   * raw one (docs/protocol.md D7). Copied from the response like every other number here.
   */
  roundWin: Minor;
  capped: boolean;
  feature: FeatureProgress | undefined;
}

/**
 * What the client must do when the current presentation finishes. Copied from the server's `next`,
 * never inferred from the result — adding a feature type later must not silently change behaviour.
 */
export type Continuation = 'IDLE' | 'FEATURE_SPIN' | 'SETTLE';

/**
 * How an error can be left.
 *
 * Derived from the error's class, so the taxonomy is not documentation — it is the state machine.
 * `RECOVERABLE` keeps the failed call so a retry re-issues it with the same `roundId`.
 */
export type Recovery = 'RETRY' | 'DISMISS' | 'FROZEN';

export type EngineState =
  /** Before `authenticate` has answered. There is no balance to show yet. */
  | { readonly phase: 'BOOTING' }
  | ({ readonly phase: 'IDLE' } & Session)
  /** The request is in flight and the reels are already accelerating. */
  | ({ readonly phase: 'SPINNING' } & Session & {
        readonly roundId: RoundId;
        /** The player pressed again: the renderer must take the shortest legal deceleration. */
        readonly slam: boolean;
      })
  /** The outcome is known and the reels are decelerating onto it. */
  | ({ readonly phase: 'STOPPING' } & Session &
      Round & { readonly next: Continuation; readonly slam: boolean })
  | ({ readonly phase: 'WIN_PRESENTATION' } & Session &
      Round & { readonly next: Continuation; readonly wins: readonly Win[] })
  | ({ readonly phase: 'FEATURE_INTRO' } & Session & Round)
  | ({ readonly phase: 'FEATURE_SPINNING' } & Session &
      Round & { readonly step: number; readonly slam: boolean })
  | ({ readonly phase: 'FEATURE_OUTRO' } & Session & Round)
  | ({ readonly phase: 'SETTLING' } & Session & Round)
  /**
   * The session expired under an open round, and the machine is getting a fresh one instead of
   * abandoning the money (docs/protocol.md §5, D9). Not an error phase: the player sees a pause,
   * not a modal, and the round in `resume` is still the round being played.
   */
  | {
      readonly phase: 'REAUTHENTICATING';
      /**
       * The call phase the expiry interrupted. Re-entered — and its call re-issued — when the fresh
       * session carries no `pendingRound`; superseded by the server's own account when it does,
       * because a re-authenticate is a full §5 resume and the server's view wins.
       */
      readonly resume: EngineState;
      /** The `SESSION_EXPIRED` that started this. Kept for telemetry and the status line. */
      readonly error: SlotError;
    }
  | {
      readonly phase: 'ERROR';
      readonly error: SlotError;
      readonly recovery: Recovery;
      /**
       * The state the failure happened in.
       *
       * `RETRY` returns here and **reconstructs the request from it** rather than replaying a
       * request the driver handed over. That is a stronger guarantee than trusting the caller: the
       * `roundId` comes from the round that is still open, so a retry structurally cannot mint a
       * new one.
       */
      readonly resume: EngineState;
    };

/* ── inputs ───────────────────────────────────────────────────────────────────────────────── */

/**
 * Everything that can happen to the machine.
 *
 * Note that there is **one** player input — `PRESS` — rather than a `SPIN` and a `SKIP`. The button
 * is the same button; what it means depends on the phase, and letting the *caller* decide would put
 * the interruption contract in the UI where it cannot be tested.
 */
export type EngineInput =
  | { readonly type: 'AUTHENTICATED'; readonly response: AuthenticateRes }
  /** The transparent mid-round re-authenticate answered. Only `REAUTHENTICATING` services it. */
  | { readonly type: 'REAUTHENTICATED'; readonly response: AuthenticateRes }
  | { readonly type: 'PRESS' }
  | { readonly type: 'SET_STAKE'; readonly stake: Minor }
  /** From the renderer: the reels finished decelerating. */
  | { readonly type: 'REELS_STOPPED' }
  /** From the renderer: the win tweens finished (or were completed by a skip). */
  | { readonly type: 'PRESENTATION_COMPLETE' }
  | { readonly type: 'INTRO_COMPLETE' }
  | { readonly type: 'OUTRO_COMPLETE' }
  | { readonly type: 'SPIN_RESOLVED'; readonly response: SpinRes }
  | { readonly type: 'FEATURE_SPIN_RESOLVED'; readonly response: FeatureSpinRes }
  | { readonly type: 'SETTLE_RESOLVED'; readonly response: SettleRes }
  | { readonly type: 'CALL_FAILED'; readonly error: SlotError }
  | { readonly type: 'RETRY' }
  | { readonly type: 'DISMISS_ERROR' };

export type InputType = EngineInput['type'];

/* ── effects ──────────────────────────────────────────────────────────────────────────────── */

/**
 * A call the driver must make. The reducer stays pure by describing the call rather than making it —
 * the same split as `rgs-sim`, and for the same reason: a state machine you can test without a
 * network is a state machine you can actually test.
 */
export type EngineEffect =
  | { readonly type: 'CALL_SPIN'; readonly request: SpinReq }
  | { readonly type: 'CALL_FEATURE_SPIN'; readonly request: FeatureSpinReq }
  | { readonly type: 'CALL_SETTLE'; readonly request: SettleReq }
  /**
   * Get a fresh token through the lobby seam and `authenticate` with it. Carries no request —
   * the token is the driver's to obtain, because a pure reducer has no lobby.
   */
  | { readonly type: 'CALL_REAUTHENTICATE' };

/* ── events ───────────────────────────────────────────────────────────────────────────────── */

/**
 * What the renderer subscribes to. The engine emits; it never reaches into the renderer, which is
 * what keeps this package free of Pixi and unit-testable without a canvas.
 */
export type EngineEvent =
  | { readonly type: 'PHASE_CHANGED'; readonly from: Phase; readonly to: Phase }
  /**
   * `session` is carried because the client cannot format money without `currency`, and the currency
   * is the server's — the same rule as the balance. It is published rather than stored in every
   * phase: it does not change within a session, so a listener captures it once.
   */
  | {
      readonly type: 'SESSION_READY';
      readonly session: PlayerSession;
      readonly config: GameConfig;
      readonly balance: Minor;
    }
  | { readonly type: 'BALANCE_CHANGED'; readonly balance: Minor }
  | { readonly type: 'STAKE_CHANGED'; readonly stake: Minor }
  | { readonly type: 'SPIN_STARTED'; readonly roundId: RoundId; readonly stake: Minor }
  /** The reels have a target. `slam` says the player asked for the short deceleration. */
  | {
      readonly type: 'REELS_TARGETED';
      readonly stops: readonly number[];
      readonly view: readonly (readonly string[])[];
      readonly slam: boolean;
    }
  | {
      readonly type: 'WINS_PRESENTED';
      readonly wins: readonly Win[];
      readonly totalWin: Minor;
    }
  | { readonly type: 'FEATURE_AWARDED'; readonly total: number }
  | {
      readonly type: 'FEATURE_PROGRESS';
      readonly feature: FeatureProgress;
      /** What the round will pay so far, already capped — the counter above the reels shows it. */
      readonly roundWin: Minor;
    }
  | { readonly type: 'FEATURE_ENDED'; readonly roundWin: Minor }
  | {
      readonly type: 'ROUND_SETTLED';
      readonly totalWin: Minor;
      readonly capped: boolean;
      readonly balance: Minor;
    }
  /** The player interrupted. The renderer completes its timelines; the engine decided it was legal. */
  | { readonly type: 'SKIPPED'; readonly phase: Phase }
  /**
   * The session expired under an open round and the machine is renewing it transparently. Not
   * `ERROR_RAISED` — nothing is asked of the player — but telemetry wants to count these, and the
   * status line wants to say why the game paused.
   */
  | { readonly type: 'SESSION_RENEWING'; readonly error: SlotError }
  | { readonly type: 'ERROR_RAISED'; readonly error: SlotError; readonly recovery: Recovery }
  | { readonly type: 'ERROR_CLEARED' }
  /** An input the current phase cannot service. Emitted so the debug log can show it was dropped. */
  | { readonly type: 'INPUT_REJECTED'; readonly input: InputType; readonly phase: Phase };

export interface Transition {
  readonly state: EngineState;
  readonly events: readonly EngineEvent[];
  readonly effects: readonly EngineEffect[];
}
