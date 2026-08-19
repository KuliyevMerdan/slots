import { describe, expect, it } from 'vitest';
import type { Minor } from '@slot/protocol';
import { JURISDICTION_PRESETS } from '@slot/protocol';
import { canSpin, nextSpinAllowedAt, spinDelay } from './pacing.js';
import {
  acknowledgeRealityCheck,
  minutesPlayed,
  realityCheckDue,
  startRealityCheck,
} from './reality.js';
import {
  limitBreached,
  netLoss,
  recordCredit,
  recordStake,
  stakeWithinLimit,
  startTally,
} from './limits.js';
import { afterRound, autoplayPermitted, startAutoplay } from './autoplay.js';
import type { AutoplayPlan } from './autoplay.js';

const NOW = 1_700_000_000_000;
const UK = JURISDICTION_PRESETS.UK;
const DEFAULT = JURISDICTION_PRESETS.DEFAULT;
const m = (value: number): Minor => value as Minor;

describe('pacing — the client half of the wire rule', () => {
  it('allows the first spin immediately, in every regime', () => {
    expect(canSpin(UK, undefined, NOW)).toBe(true);
    expect(canSpin(DEFAULT, undefined, NOW)).toBe(true);
  });

  it('holds the button for the remainder of the interval, to the millisecond', () => {
    expect(canSpin(UK, NOW, NOW + 2_499)).toBe(false);
    expect(canSpin(UK, NOW, NOW + 2_500)).toBe(true);
    expect(spinDelay(UK, NOW, NOW + 1_000)).toBe(1_500);
    expect(nextSpinAllowedAt(UK, NOW)).toBe(NOW + 2_500);
  });

  it('never holds under DEFAULT rules — the floor is zero', () => {
    expect(canSpin(DEFAULT, NOW, NOW)).toBe(true);
    expect(spinDelay(DEFAULT, NOW, NOW)).toBe(0);
  });
});

describe('the reality check schedule', () => {
  it('is never due where the rules set no interval', () => {
    const state = startRealityCheck(NOW);
    expect(realityCheckDue(DEFAULT, state, NOW + 100 * 3_600_000)).toBe(false);
  });

  it('falls due one interval after play began, and again one interval after each acknowledgement', () => {
    const state = startRealityCheck(NOW);

    expect(realityCheckDue(UK, state, NOW + 3_599_999)).toBe(false);
    expect(realityCheckDue(UK, state, NOW + 3_600_000)).toBe(true);

    const acknowledged = acknowledgeRealityCheck(state, NOW + 3_600_000);
    expect(realityCheckDue(UK, acknowledged, NOW + 3_600_001)).toBe(false);
    expect(realityCheckDue(UK, acknowledged, NOW + 7_200_000)).toBe(true);
  });

  it('states whole minutes since play began — the anchor never moves on acknowledge', () => {
    const state = acknowledgeRealityCheck(startRealityCheck(NOW), NOW + 3_600_000);
    expect(minutesPlayed(state, NOW + 3_690_000)).toBe(61);
  });
});

describe('session limits', () => {
  it('tracks the tally from server numbers and floors the loss at zero', () => {
    let tally = startTally(NOW);
    tally = recordStake(tally, m(100));
    tally = recordStake(tally, m(100));
    tally = recordCredit(tally, m(500));

    expect(tally.spins).toBe(2);
    // In profit: the session has lost nothing.
    expect(netLoss(tally)).toBe(0);

    tally = recordStake(tally, m(1_000));
    expect(netLoss(tally)).toBe(700);
  });

  it('reports the loss limit only once net loss exceeds it', () => {
    let tally = startTally(NOW);
    tally = recordStake(tally, m(500));

    expect(limitBreached({ maxLoss: m(500) }, tally, NOW)).toBeNull();
    tally = recordStake(tally, m(1));
    expect(limitBreached({ maxLoss: m(500) }, tally, NOW)).toBe('LOSS');
  });

  it('ends a session on time, and says time before loss when both have gone', () => {
    let tally = startTally(NOW);
    tally = recordStake(tally, m(10_000));
    const limits = { maxSessionMs: 3_600_000, maxLoss: m(100) };

    expect(limitBreached(limits, tally, NOW + 3_599_999)).toBe('LOSS');
    expect(limitBreached(limits, tally, NOW + 3_600_000)).toBe('SESSION_TIME');
  });

  it('applies the player’s own stake ceiling', () => {
    expect(stakeWithinLimit({ maxSingleStake: m(200) }, m(200))).toBe(true);
    expect(stakeWithinLimit({ maxSingleStake: m(200) }, m(201))).toBe(false);
    expect(stakeWithinLimit({}, m(1_000_000))).toBe(true);
  });
});

describe('autoplay stop conditions', () => {
  const plan: AutoplayPlan = {
    spins: 3,
    stopOnSingleWinOver: m(1_000),
    stopOnLossExceeding: m(250),
    stopOnFeature: true,
  };
  const dead = { stake: m(100), totalWin: m(0), triggeredFeature: false };

  it('reads permission from the jurisdiction, not from a client preference', () => {
    expect(autoplayPermitted(UK)).toBe(false);
    expect(autoplayPermitted(DEFAULT)).toBe(true);
  });

  it('runs the planned count down and stops as COMPLETE', () => {
    let state = startAutoplay({ spins: 2 });

    const first = afterRound(state, { spins: 2 }, dead);
    expect(first.stop).toBeNull();
    state = first.state;

    const second = afterRound(state, { spins: 2 }, dead);
    expect(second.stop).toBe('COMPLETE');
  });

  it('stops on a single win over the limit — even on the last planned spin, the win is the reason', () => {
    const state = { remaining: 1, staked: m(0), credited: m(0) };
    const { stop } = afterRound(state, plan, {
      stake: m(100),
      totalWin: m(5_000),
      triggeredFeature: false,
    });

    expect(stop).toBe('WIN_LIMIT');
  });

  it('stops when the run’s net loss crosses the limit', () => {
    let state = startAutoplay({ spins: 10, stopOnLossExceeding: m(250) });

    for (const expected of [null, null, 'LOSS_LIMIT'] as const) {
      const result = afterRound(state, { spins: 10, stopOnLossExceeding: m(250) }, dead);
      expect(result.stop).toBe(expected);
      state = result.state;
    }
  });

  it('stops on a feature so the player watches what they won', () => {
    const { stop } = afterRound(startAutoplay(plan), plan, {
      stake: m(100),
      totalWin: m(0),
      triggeredFeature: true,
    });

    expect(stop).toBe('FEATURE');
  });
});
