import { describe, expect, it } from 'vitest';
import { SlotError } from '@slot/protocol';
import type { Minor, RoundId } from '@slot/protocol';
import type { EngineEvent } from '@slot/engine';
import { EventLog } from './log.js';

/**
 * The log's one real idea is correlation: events that do not name their round are attributed to
 * the round that is open, because an exported session should read as rounds, not as a stream.
 */

const roundId = 'round-0001' as RoundId;
const minor = (value: number): Minor => value as Minor;

const spinStarted: EngineEvent = { type: 'SPIN_STARTED', roundId, stake: minor(100) };
const winsPresented: EngineEvent = { type: 'WINS_PRESENTED', wins: [], totalWin: minor(0) };
const settled: EngineEvent = {
  type: 'ROUND_SETTLED',
  totalWin: minor(0),
  capped: false,
  balance: minor(900),
};
const stakeChanged: EngineEvent = { type: 'STAKE_CHANGED', stake: minor(200) };

const clock = (start = 1_000): (() => number) => {
  let at = start;
  return () => at++;
};

describe('the event log', () => {
  it('attributes events inside a round to that round, and stops at the settle', () => {
    const log = new EventLog({ now: clock() });

    log.record(spinStarted);
    log.record(winsPresented);
    log.record(settled);
    log.record(stakeChanged);

    const [first, second, third, fourth] = log.entries();
    expect(first?.roundId).toBe(roundId);
    expect(second?.roundId).toBe(roundId); // carried — the event itself names no round
    expect(third?.roundId).toBe(roundId); // the settle is the round's last word
    expect(fourth?.roundId).toBeUndefined(); // after it, no round is open
  });

  it('prefers the roundId an error carries over the round that happens to be open', () => {
    const log = new EventLog({ now: clock() });
    const other = 'round-0002' as RoundId;

    log.record(spinStarted);
    log.record({
      type: 'ERROR_RAISED',
      error: new SlotError('TIMEOUT', 'took too long', { roundId: other }),
      recovery: 'RETRY',
    });

    expect(log.entries()[1]?.roundId).toBe(other);
  });

  it('caps the log by dropping the oldest entries, and keeps seq monotonic across the cut', () => {
    const log = new EventLog({ now: clock(), capacity: 3 });

    for (let index = 0; index < 5; index++) log.record(stakeChanged);

    const entries = log.entries();
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.seq)).toEqual([2, 3, 4]);
  });

  it('exports JSON that says where the cap cut', () => {
    const log = new EventLog({ now: clock(), capacity: 2 });
    for (let index = 0; index < 4; index++) log.record(stakeChanged);

    const exported = JSON.parse(log.export()) as {
      exportedAt: number;
      droppedBeforeSeq: number;
      entries: unknown[];
    };
    expect(exported.droppedBeforeSeq).toBe(2);
    expect(exported.entries).toHaveLength(2);
  });

  it('timestamps from the injected clock', () => {
    const log = new EventLog({ now: clock(42_000) });
    log.record(stakeChanged);
    expect(log.entries()[0]?.at).toBe(42_000);
  });

  it('clears to empty, and keeps counting seq from where it was', () => {
    const log = new EventLog({ now: clock() });
    log.record(stakeChanged);
    log.clear();
    expect(log.entries()).toHaveLength(0);
    log.record(stakeChanged);
    expect(log.entries()[0]?.seq).toBe(1);
  });
});
