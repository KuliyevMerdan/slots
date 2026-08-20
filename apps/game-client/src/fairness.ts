import type {
  AuthenticateReq,
  AuthenticateRes,
  FeatureSpinReq,
  FeatureSpinRes,
  GameConfig,
  SettleReq,
  SettleRes,
  SpinReq,
  SpinRes,
} from '@slot/protocol';
import { commitmentOf, stopsForStep } from '@slot/game-math';
import type { Telemetry } from './telemetry.js';

/**
 * The fairness auditor (C8) — the client finally *opening* the verification toolkit it has
 * shipped since R4. A dev-build decorator over the transport: it watches the round's fairness
 * fields go past — the commitment that binds at open, the reveal that closes — and re-runs the
 * player's whole procedure from `docs/fairness.md` with `@slot/game-math` alone: the revealed
 * seed must hash to the commitment the player held before the bet, and every step's `stops[]`
 * must recompute from it exactly. A server that fails this is not unlucky, it is lying — which
 * is why the report is an ERROR beside the paytable-drift assertion, not a curiosity.
 *
 * Presentation-independent and engine-invisible: nothing above the transport learns the audit
 * exists, and a build without `__ASSERT_MATH__` never constructs it. Servers that do not offer
 * the capability (the simulators, by design — they honour `forceOutcome` instead) simply never
 * carry the fields, and the auditor stays silent.
 */

/** The four calls, structurally — any `RgsTransport` satisfies this, and the engine's port. */
export interface AuditedPort {
  authenticate(request: AuthenticateReq): Promise<AuthenticateRes>;
  spin(request: SpinReq): Promise<SpinRes>;
  featureSpin(request: FeatureSpinReq): Promise<FeatureSpinRes>;
  settle(request: SettleReq): Promise<SettleRes>;
}

interface OpenAudit {
  commitment: string;
  clientSeed: string | undefined;
  /** `stops[]` per step, as the server answered them — step 0 is the base spin. */
  stops: number[][];
}

export function withFairnessAudit(port: AuditedPort, telemetry: Telemetry): AuditedPort {
  let config: GameConfig | undefined;
  const open = new Map<string, OpenAudit>();

  const verify = (roundId: string, reveal: string): void => {
    const audit = open.get(roundId);
    open.delete(roundId);
    if (audit === undefined || config === undefined) return;

    const failures: string[] = [];
    if (commitmentOf(reveal) !== audit.commitment) {
      failures.push('the revealed seed does not hash to the commitment');
    } else {
      audit.stops.forEach((stops, step) => {
        const recomputed = stopsForStep(
          config as GameConfig,
          reveal,
          roundId,
          audit.clientSeed,
          step,
        );
        if (recomputed.join(',') !== stops.join(',')) {
          failures.push(`step ${String(step)}: recomputed stops disagree with the served outcome`);
        }
      });
    }
    if (failures.length === 0) return;

    telemetry.report({
      name: 'assert_fairness_reveal_invalid',
      level: 'ERROR',
      message: 'the fairness reveal does not reproduce the round it closes',
      roundId,
      detail: { failures, commitment: audit.commitment, reveal },
    });
  };

  return {
    async authenticate(request) {
      const response = await port.authenticate(request);
      config = response.config;
      return response;
    },
    async spin(request) {
      const response = await port.spin(request);
      if (response.fairness !== undefined) {
        open.set(request.roundId, {
          commitment: response.fairness.commitment,
          clientSeed: request.clientSeed,
          stops: [response.result.stops],
        });
        // A dead round settles atomically: the reveal rides the spin response itself.
        if (response.fairness.reveal !== undefined)
          verify(request.roundId, response.fairness.reveal);
      }
      return response;
    },
    async featureSpin(request) {
      const response = await port.featureSpin(request);
      const audit = open.get(request.roundId);
      if (audit !== undefined) audit.stops[request.step] = [...response.result.stops];
      return response;
    },
    async settle(request) {
      const response = await port.settle(request);
      if (response.fairness !== undefined) verify(request.roundId, response.fairness.reveal);
      return response;
    },
  };
}
