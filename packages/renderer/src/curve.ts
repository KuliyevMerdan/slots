/**
 * The spin curve — five stages, pure, and the only part of the reel a test can drive.
 *
 * Everything here is `(motion, dt) → motion`: no Pixi, no ticker, no DOM. That is deliberate and it
 * is the same split the engine and the simulator use, for the same reason. How a reel *feels* is the
 * single detail that separates a slot that reads as professional from one that does not, and feel
 * is exactly the thing you cannot verify by reading code — so the arithmetic under it lives where a
 * test can assert the properties that must hold: **a reel lands exactly on the server's stop**, a
 * slam stop lands sooner *on the same stop*, and no stage ever leaves the position undefined.
 *
 * Positions are in **symbols**, not pixels, and increase forever. The renderer takes
 * `position mod stripLength` to decide which symbols to draw, so nothing here needs to know how big
 * a symbol is on screen.
 *
 * Time is in milliseconds and always arrives as a delta. Frame counting would make the whole game
 * run at a different speed on a 120 Hz phone.
 */

export type ReelPhase =
  /** Not spinning. `position` is a whole number: the reel is parked on a stop. */
  | 'IDLE'
  /** The brief backwards dip before the reel launches. ~60 ms, and it is what sells the launch. */
  | 'ANTICIPATION'
  | 'ACCELERATING'
  /** Full speed, symbols blurred, waiting for a target and for this reel's turn to stop. */
  | 'CRUISING'
  | 'DECELERATING'
  /** Travelling back the overshoot. Stage 5, and the reason a stop feels like weight. */
  | 'SETTLING'
  | 'STOPPED';

export interface SpinCurve {
  /** Stage 1: how long the dip lasts, and how far back it goes. */
  anticipationMs: number;
  dipSymbols: number;
  /** Stage 2. */
  accelerateMs: number;
  /** Stage 3, in symbols per second. */
  maxSpeed: number;
  /** The shortest a reel may cruise, so a zero-latency mock still looks like a spin. */
  minCruiseMs: number;
  /** Stage 4. */
  decelerateMs: number;
  /** Symbols travelled *past* the stop before the spring back. Stage 5. */
  overshoot: number;
  settleMs: number;
  /** How far a reel must still travel when deceleration begins — it may not stop on a sixpence. */
  minDecelerateSymbols: number;
  /** Between one reel's stop and the next. 120–180 ms is the industry's whole cadence. */
  staggerMs: number;
  /**
   * Extra cruise for a reel under scatter anticipation. Two scatters on reels 1–2 and the rest of
   * the game slows down — cheap to build, instantly recognisable to anyone from the industry.
   */
  anticipationHoldMs: number;
  /** A slam stop replaces `decelerateMs` and skips the hold. The reel still lands on its stop. */
  slamDecelerateMs: number;
  /** Above this speed, in symbols per second, the blurred texture is drawn. */
  blurAboveSpeed: number;
}

export const DEFAULT_CURVE: SpinCurve = {
  anticipationMs: 60,
  dipSymbols: 0.18,
  accelerateMs: 200,
  maxSpeed: 26,
  minCruiseMs: 320,
  decelerateMs: 460,
  overshoot: 0.32,
  settleMs: 170,
  minDecelerateSymbols: 6,
  staggerMs: 140,
  anticipationHoldMs: 900,
  slamDecelerateMs: 220,
  blurAboveSpeed: 8,
};

export interface ReelMotion {
  readonly phase: ReelPhase;
  /** Absolute, in symbols, monotonically increasing except for the dip and the settle. */
  readonly position: number;
  /** Symbols per second, derived — the renderer reads it to decide whether to draw blurred. */
  readonly velocity: number;
  /** Milliseconds spent in the current phase. */
  readonly elapsed: number;
  /** Position when the current phase began. */
  readonly from: number;
  /** Total travel planned for the deceleration, including the overshoot. */
  readonly distance: number;
  /** Where this reel must come to rest. Absolute, so it is a *plan*, not a modulus to chase. */
  readonly landing: number | null;
  /** The server's stop index, kept so a target can arrive before the reel is ready to use it. */
  readonly stop: number | null;
  /**
   * Cruise time this reel must burn *on top of* the minimum before it may begin stopping — its share
   * of the stagger, plus the scatter anticipation. Additive rather than a countdown: a 140 ms
   * stagger that expires inside a 320 ms minimum cruise is not a stagger at all.
   */
  readonly holdMs: number;
  /** The player asked for the short version. */
  readonly slam: boolean;
  /** Cumulative cruise time, so a zero-latency response still produces a spin worth watching. */
  readonly cruisedMs: number;
}

export const parked = (position = 0): ReelMotion => ({
  phase: 'IDLE',
  position,
  velocity: 0,
  elapsed: 0,
  from: position,
  distance: 0,
  landing: null,
  stop: null,
  holdMs: 0,
  slam: false,
  cruisedMs: 0,
});

/* ── easing ───────────────────────────────────────────────────────────────────────────────────
 * Named rather than inlined, because which curve is on which stage is a design decision someone
 * will want to change, and it should be changeable in one legible place.
 */

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Stage 1 — out and back, so the dip returns to where it started. */
const easeDip = (t: number): number => Math.sin(clamp01(t) * Math.PI);

/** Stage 2 — slow to start, hard at the end. */
const easeInCubic = (t: number): number => {
  const u = clamp01(t);
  return u * u * u;
};

/** Stage 4 — the classic: nearly all the distance early, a long tail into the stop. */
const easeOutQuint = (t: number): number => {
  const u = 1 - clamp01(t);
  return 1 - u * u * u * u * u;
};

/**
 * Stage 5 — a damped bounce back from the overshoot.
 *
 * Returns 1 at `t = 1` exactly, which is what makes the reel land on an integer stop rather than
 * near one. A spring that only *approaches* its rest position is how reels end up a pixel off.
 */
const easeSettle = (t: number): number => {
  const u = clamp01(t);
  if (u >= 1) return 1;
  return 1 - Math.cos(u * Math.PI * 1.5) * (1 - u) * (1 - u);
};

/* ── the machine ──────────────────────────────────────────────────────────────────────────── */

export interface SpinRequest {
  /** Reel index, which decides this reel's share of the stagger. */
  reel: number;
  slam: boolean;
  /** Extra hold before this reel may stop — scatter anticipation. */
  anticipated: boolean;
}

/** Launch a reel. The target may not be known yet; the reel cruises until it is. */
export const startSpin = (
  motion: ReelMotion,
  { reel, slam, anticipated }: SpinRequest,
  curve: SpinCurve,
): ReelMotion => ({
  ...parked(motion.position),
  phase: slam ? 'ACCELERATING' : 'ANTICIPATION',
  from: motion.position,
  slam,
  holdMs: slam ? 0 : reel * curve.staggerMs + (anticipated ? curve.anticipationHoldMs : 0),
});

/**
 * Hand the reel the outcome the server committed to.
 *
 * Called on `REELS_TARGETED`, which can arrive while the reel is still accelerating — an in-process
 * `MockTransport` answers in under a millisecond — so the target is *stored* and consumed when the
 * reel reaches a phase that can act on it.
 */
export const target = (motion: ReelMotion, stop: number, slam: boolean): ReelMotion => ({
  ...motion,
  stop,
  slam: motion.slam || slam,
  holdMs: slam ? 0 : motion.holdMs,
});

/** Cut every remaining wait: the player pressed again and wants the outcome now. */
export const slam = (motion: ReelMotion, curve: SpinCurve): ReelMotion => {
  if (
    motion.phase === 'DECELERATING' ||
    motion.phase === 'SETTLING' ||
    motion.phase === 'STOPPED'
  ) {
    return motion;
  }
  return {
    ...motion,
    slam: true,
    holdMs: 0,
    cruisedMs: Math.max(motion.cruisedMs, curve.minCruiseMs),
  };
};

/**
 * Where this reel will come to rest, given where it is now.
 *
 * The landing is **absolute and computed once**: the smallest position that is congruent to the
 * server's stop, at least `minDecelerateSymbols` ahead. Everything after this point is interpolation
 * towards a fixed number, which is why the reel lands on the stop exactly rather than approximately.
 */
const planLanding = (
  position: number,
  stop: number,
  stripLength: number,
  ahead: number,
): number => {
  const earliest = position + ahead;
  const remainder = (((stop - earliest) % stripLength) + stripLength) % stripLength;
  return earliest + remainder;
};

export interface AdvanceOptions {
  stripLength: number;
  curve: SpinCurve;
}

/**
 * One frame. Total, allocation-free apart from the returned object, and never reads a clock.
 *
 * The returned `ReelMotion` is a new object per reel per frame — the one allocation the ticker makes
 * and the one worth making: it keeps this function pure and testable, and five small objects a frame
 * is nothing next to the per-frame closures and array literals the performance rules actually ban.
 */
export function advance(motion: ReelMotion, dtMs: number, options: AdvanceOptions): ReelMotion {
  const { curve, stripLength } = options;
  const dt = Math.max(0, dtMs);
  const elapsed = motion.elapsed + dt;

  switch (motion.phase) {
    case 'IDLE':
    case 'STOPPED':
      return motion.velocity === 0 ? motion : { ...motion, velocity: 0 };

    case 'ANTICIPATION': {
      if (elapsed >= curve.anticipationMs) {
        // Snapped back to where the dip began: the reel launches from its resting stop, not from
        // wherever the last frame happened to land inside the curve.
        return {
          ...motion,
          phase: 'ACCELERATING',
          elapsed: 0,
          position: motion.from,
          velocity: 0,
        };
      }
      const position = motion.from - curve.dipSymbols * easeDip(elapsed / curve.anticipationMs);
      return {
        ...motion,
        elapsed,
        position,
        velocity: (position - motion.position) / (dt / 1000 || 1),
      };
    }

    case 'ACCELERATING': {
      const speed = curve.maxSpeed * easeInCubic(elapsed / curve.accelerateMs);
      const position = motion.position + (speed * dt) / 1000;
      if (elapsed >= curve.accelerateMs) {
        return {
          ...motion,
          phase: 'CRUISING',
          elapsed: 0,
          from: position,
          position,
          velocity: curve.maxSpeed,
        };
      }
      return { ...motion, elapsed, position, velocity: speed };
    }

    case 'CRUISING': {
      const position = motion.position + (curve.maxSpeed * dt) / 1000;
      const cruisedMs = motion.cruisedMs + dt;
      const ready = motion.stop !== null && cruisedMs >= curve.minCruiseMs + motion.holdMs;

      if (!ready) {
        return { ...motion, elapsed, position, cruisedMs, velocity: curve.maxSpeed };
      }

      const landing = planLanding(
        position,
        motion.stop as number,
        stripLength,
        curve.minDecelerateSymbols,
      );
      return {
        ...motion,
        phase: 'DECELERATING',
        elapsed: 0,
        from: position,
        position,
        landing,
        distance: landing - position + curve.overshoot,
        cruisedMs,
        velocity: curve.maxSpeed,
      };
    }

    case 'DECELERATING': {
      const duration = motion.slam ? curve.slamDecelerateMs : curve.decelerateMs;
      if (elapsed >= duration) {
        const position = motion.from + motion.distance;
        return { ...motion, phase: 'SETTLING', elapsed: 0, from: position, position, velocity: 0 };
      }
      const position = motion.from + motion.distance * easeOutQuint(elapsed / duration);
      return {
        ...motion,
        elapsed,
        position,
        velocity: (position - motion.position) / (dt / 1000 || 1),
      };
    }

    case 'SETTLING': {
      const landing = motion.landing ?? motion.position;
      if (elapsed >= curve.settleMs) {
        // Snapped, not eased into: the reel must sit on the server's stop to the float, because the
        // symbols the player is looking at are read from this number.
        return {
          ...motion,
          phase: 'STOPPED',
          elapsed: 0,
          position: landing,
          from: landing,
          velocity: 0,
        };
      }
      const position = motion.from + (landing - motion.from) * easeSettle(elapsed / curve.settleMs);
      return {
        ...motion,
        elapsed,
        position,
        velocity: (position - motion.position) / (dt / 1000 || 1),
      };
    }
  }
}

/** Every reel has come to rest on its stop. */
export const isStopped = (motion: ReelMotion): boolean => motion.phase === 'STOPPED';

/** Whether this frame should draw the blurred symbol texture rather than the sharp one. */
export const isBlurred = (motion: ReelMotion, curve: SpinCurve): boolean =>
  Math.abs(motion.velocity) > curve.blurAboveSpeed;

/**
 * The same curve, faster — turbo, and the compliance switch that turns it off.
 *
 * Only the *durations* scale. Speed, overshoot and the blur threshold are unchanged, because turbo
 * is meant to shorten a spin rather than to make it a different animation: the reel still dips,
 * still overshoots and still settles, and a player who turns it on has not been given a different
 * game. A jurisdiction that forbids turbo (the UK preset, C6) simply never applies a factor — and
 * one that mandates a minimum spin duration raises `minCruiseMs` instead of forbidding anything.
 */
export function scaleCurve(curve: SpinCurve, factor: number): SpinCurve {
  if (factor <= 0) throw new RangeError(`a spin curve cannot be scaled by ${factor}`);

  return {
    ...curve,
    anticipationMs: curve.anticipationMs * factor,
    accelerateMs: curve.accelerateMs * factor,
    minCruiseMs: curve.minCruiseMs * factor,
    decelerateMs: curve.decelerateMs * factor,
    settleMs: curve.settleMs * factor,
    staggerMs: curve.staggerMs * factor,
    anticipationHoldMs: curve.anticipationHoldMs * factor,
    slamDecelerateMs: curve.slamDecelerateMs * factor,
  };
}

/** How much faster turbo is. One number, so the debug panel and the compliance layer share it. */
export const TURBO_FACTOR = 0.4;
