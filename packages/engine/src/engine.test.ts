import { describe, expect, it, vi } from 'vitest';
import type { AuthenticateRes, FeatureSpinRes, SettleRes, SpinRes } from '@slot/protocol';
import { SlotError } from '@slot/protocol';
import { SlotEngine } from './engine.js';
import type { RgsPort } from './engine.js';
import type { EngineEvent } from './types.js';
import {
  ROUND_ID,
  authRes,
  featureSpinRes,
  feature,
  settleRes,
  spinRes,
} from './__fixtures__/round.js';

/**
 * The driver, against a stub port.
 *
 * The engine may not depend on `@slot/transport`, which is why `RgsPort` exists — and why this file
 * can drive the whole machine with an object literal. The two actually meet in the root soak suite,
 * where a real simulator sits behind a real transport.
 */

class StubPort implements RgsPort {
  readonly calls: string[] = [];
  authenticateWith: () => Promise<AuthenticateRes> = () => Promise.resolve(authRes());
  spinWith: () => Promise<SpinRes> = () => Promise.resolve(spinRes());
  featureSpinWith: (step: number) => Promise<FeatureSpinRes> = (step) =>
    Promise.resolve(featureSpinRes(step));
  settleWith: () => Promise<SettleRes> = () => Promise.resolve(settleRes());

  authenticate(): Promise<AuthenticateRes> {
    this.calls.push('authenticate');
    return this.authenticateWith();
  }

  spin(): Promise<SpinRes> {
    this.calls.push('spin');
    return this.spinWith();
  }

  featureSpin(request: { step: number }): Promise<FeatureSpinRes> {
    this.calls.push(`featureSpin:${request.step}`);
    return this.featureSpinWith(request.step);
  }

  settle(): Promise<SettleRes> {
    this.calls.push('settle');
    return this.settleWith();
  }
}

const engineOver = (port: RgsPort) => new SlotEngine({ port, newRoundId: () => ROUND_ID });

describe('start', () => {
  it('authenticates and lands in IDLE', async () => {
    const port = new StubPort();
    const engine = engineOver(port);

    await engine.start('demo-token');

    expect(port.calls).toEqual(['authenticate']);
    expect(engine.state.phase).toBe('IDLE');
  });

  it('raises the failure rather than starting a game that has no session', async () => {
    const port = new StubPort();
    port.authenticateWith = () => Promise.reject(new SlotError('SESSION_EXPIRED', 'nope'));
    const engine = engineOver(port);

    await engine.start('bad-token');

    expect(engine.state).toMatchObject({ phase: 'ERROR', recovery: 'DISMISS' });
  });

  /**
   * A safety net for a port that is not a transport. `@slot/transport` classifies everything before
   * it gets here, so this only fires for a stub or a future implementation that forgot — and it
   * stays recoverable rather than freezing the game over somebody else's slip.
   */
  it('classifies a port that throws something that is not a SlotError', async () => {
    const port = new StubPort();
    port.authenticateWith = () => Promise.reject(new TypeError('undefined is not a function'));
    const engine = engineOver(port);

    await engine.start('t');

    expect(engine.state).toMatchObject({ phase: 'ERROR', recovery: 'RETRY' });
  });
});

describe('effects', () => {
  it('performs the call the reducer asked for and feeds the answer back', async () => {
    const port = new StubPort();
    port.spinWith = () => Promise.resolve(spinRes({ totalWin: 500, next: 'SETTLE' }));
    const engine = engineOver(port);
    await engine.start('t');

    engine.send({ type: 'PRESS' });
    await engine.settled();

    expect(port.calls).toEqual(['authenticate', 'spin']);
    expect(engine.state.phase).toBe('STOPPING');
  });

  /** A round is a sequence, not a fan-out: free spin 2 must not start before free spin 1 answered. */
  it('runs a whole feature in order', async () => {
    const port = new StubPort();
    port.spinWith = () =>
      Promise.resolve(
        spinRes({
          totalWin: 0,
          feature: feature({ total: 3, remaining: 3 }),
          next: 'FEATURE_SPIN',
        }),
      );
    port.featureSpinWith = (step) =>
      Promise.resolve(
        featureSpinRes(step, {
          feature: feature({ total: 3, remaining: 3 - step, step }),
          next: step === 3 ? 'SETTLE' : 'FEATURE_SPIN',
        }),
      );

    const engine = engineOver(port);
    await engine.start('t');

    engine.send({ type: 'PRESS' });
    await engine.settled();

    for (let guard = 0; guard < 20 && engine.state.phase !== 'IDLE'; guard += 1) {
      const phase = engine.state.phase;
      if (phase === 'STOPPING') engine.send({ type: 'REELS_STOPPED' });
      else if (phase === 'WIN_PRESENTATION') engine.send({ type: 'PRESENTATION_COMPLETE' });
      else if (phase === 'FEATURE_INTRO') engine.send({ type: 'INTRO_COMPLETE' });
      else if (phase === 'FEATURE_OUTRO') engine.send({ type: 'OUTRO_COMPLETE' });
      await engine.settled();
    }

    expect(port.calls).toEqual([
      'authenticate',
      'spin',
      'featureSpin:1',
      'featureSpin:2',
      'featureSpin:3',
      'settle',
    ]);
    expect(engine.state.phase).toBe('IDLE');
  });

  it('turns a rejected call into an error the machine can act on', async () => {
    const port = new StubPort();
    port.spinWith = () => Promise.reject(new SlotError('INSUFFICIENT_FUNDS', 'no funds'));
    const engine = engineOver(port);
    await engine.start('t');

    engine.send({ type: 'PRESS' });
    await engine.settled();

    expect(engine.state).toMatchObject({ phase: 'ERROR', recovery: 'DISMISS' });
    expect(engine.send({ type: 'DISMISS_ERROR' }).phase).toBe('IDLE');
  });
});

describe('events', () => {
  it('publishes to every listener, with the state as of that event', async () => {
    const port = new StubPort();
    const engine = engineOver(port);
    const seen: EngineEvent[] = [];
    engine.on((event) => seen.push(event));

    await engine.start('t');

    expect(seen.map((event) => event.type)).toEqual([
      'PHASE_CHANGED',
      'SESSION_READY',
      'BALANCE_CHANGED',
    ]);
  });

  it('stops publishing once unsubscribed', async () => {
    const engine = engineOver(new StubPort());
    const listener = vi.fn();
    const off = engine.on(listener);

    await engine.start('t');
    const delivered = listener.mock.calls.length;
    off();
    engine.send({ type: 'PRESS' });

    expect(listener.mock.calls).toHaveLength(delivered);
  });
});
