import { describe, expect, it } from 'vitest';
import { commitmentOf, stopsForStep } from '@slot/game-math';
import { createSimConfig } from '@slot/rgs-sim';
import { withFairnessAudit } from './fairness.js';
import type { AuditedPort } from './fairness.js';
import type { TelemetryEvent } from './telemetry.js';

/**
 * The auditor, held to both of its own outcomes: silence for a server whose reveal reproduces the
 * round, one ERROR for a server whose reveal does not. The honest responses are built with the
 * same `@slot/game-math` primitives the auditor checks with — which is exactly the property under
 * test: the procedure needs nothing from the server it checks.
 */

const config = createSimConfig();
const ROUND = '01890000-0000-7000-8000-000000000001';
const REVEAL = 'server-seed-under-test';
const CLIENT_SEED = 'player-entropy';

const port = (tamper: { reveal?: string; stops?: number[] }): AuditedPort => {
  const stops0 = tamper.stops ?? stopsForStep(config, REVEAL, ROUND, CLIENT_SEED, 0);
  return {
    authenticate: () => Promise.resolve({ config } as never),
    spin: () =>
      Promise.resolve({
        result: { stops: stops0 },
        fairness: { commitment: commitmentOf(REVEAL) },
      } as never),
    featureSpin: () => Promise.reject(new Error('not in this test')),
    settle: () =>
      Promise.resolve({
        fairness: {
          commitment: commitmentOf(REVEAL),
          reveal: tamper.reveal ?? REVEAL,
          next: commitmentOf('the-next-seed'),
        },
      } as never),
  };
};

const play = async (tamper: { reveal?: string; stops?: number[] } = {}) => {
  const reports: TelemetryEvent[] = [];
  const audited = withFairnessAudit(port(tamper), {
    report: (event) => {
      reports.push(event);
    },
  });
  await audited.authenticate({ token: 't' } as never);
  await audited.spin({ roundId: ROUND, stake: 100, clientSeed: CLIENT_SEED } as never);
  await audited.settle({ roundId: ROUND } as never);
  return reports;
};

describe('the fairness auditor', () => {
  it('stays silent when the reveal reproduces the round', async () => {
    expect(await play()).toHaveLength(0);
  });

  it('reports a reveal that does not hash to the commitment', async () => {
    const reports = await play({ reveal: 'a-different-seed' });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ name: 'assert_fairness_reveal_invalid', roundId: ROUND });
  });

  it('reports served stops the revealed seed cannot reproduce', async () => {
    const honest = stopsForStep(config, REVEAL, ROUND, CLIENT_SEED, 0);
    const wrong = honest.map((stop, reel) => (reel === 0 ? (stop + 1) % 10 : stop));
    const reports = await play({ stops: wrong });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.detail).toMatchObject({ reveal: REVEAL });
  });
});
