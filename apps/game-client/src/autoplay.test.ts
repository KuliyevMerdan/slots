import { describe, expect, it } from 'vitest';
import type { JurisdictionRules, Minor } from '@slot/protocol';
import { JURISDICTION_PRESETS, SlotError } from '@slot/protocol';
import { SlotEngine } from '@slot/engine';
import { SimServer, createSimConfig, createSimState } from '@slot/rgs-sim';
import { MockTransport } from '@slot/transport';
import { AutoplayController } from './autoplay.js';
import type { AutoplayView } from './autoplay.js';

/**
 * The controller is a player, so the test gives it a real table: the actual simulator behind the
 * actual transport, with the renderer's half played by the same switch the soak suite uses. The
 * timers are collected rather than waited out — an autoplay run at UK pace is 2.5 s a spin, and a
 * test that sleeps through one is a test nobody runs.
 */

const NOW = 1_700_000_000_000;

const roundId = (index: number): string =>
  `01890000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;

function table(rules?: JurisdictionRules, devMode = false) {
  const sim = new SimServer({
    initialState: createSimState({
      serverSeed: 'autoplay-seed',
      balance: 1_000_000 as Minor,
      expiresAt: 4_102_444_800_000,
    }),
    config: createSimConfig({
      devMode,
      ...(rules === undefined ? {} : { jurisdictionRules: rules }),
    }),
    now: () => NOW,
  });

  let counter = 0;
  let force: { scenario: 'FREE_SPINS_TRIGGER' } | undefined;
  const engine = new SlotEngine({
    port: new MockTransport({ backend: sim, sleep: async () => {} }),
    newRoundId: () => roundId((counter += 1)),
    forceOutcome: () => {
      const outcome = force;
      force = undefined;
      return outcome;
    },
  });

  /** The renderer's half of the loop, exactly as the soak suite fakes it. */
  const renderer = async (): Promise<void> => {
    for (let guard = 0; guard < 60; guard += 1) {
      await engine.settled();
      const phase = engine.state.phase;
      if (phase === 'STOPPING') engine.send({ type: 'REELS_STOPPED' });
      else if (phase === 'WIN_PRESENTATION') engine.send({ type: 'PRESENTATION_COMPLETE' });
      else if (phase === 'FEATURE_INTRO') engine.send({ type: 'INTRO_COMPLETE' });
      else if (phase === 'FEATURE_OUTRO') engine.send({ type: 'OUTRO_COMPLETE' });
      else return;
    }
    throw new Error('the round never came home');
  };

  const timers: Array<{ run: () => void; delay: number }> = [];
  const views: AutoplayView[] = [];

  return {
    sim,
    engine,
    timers,
    views,
    forceFeature: () => {
      force = { scenario: 'FREE_SPINS_TRIGGER' };
    },
    controller: (controllerRules = rules ?? JURISDICTION_PRESETS.DEFAULT) =>
      new AutoplayController({
        engine,
        rules: controllerRules,
        onChange: (view) => views.push(view),
        now: () => NOW,
        schedule: (run, delay) => {
          const timer = { run, delay };
          timers.push(timer);
          return () => {
            const at = timers.indexOf(timer);
            if (at !== -1) timers.splice(at, 1);
          };
        },
      }),
    /** Fire every scheduled press, then let the fake renderer finish whatever round it started. */
    flush: async (): Promise<void> => {
      while (timers.length > 0) {
        timers.shift()?.run();
        await renderer();
      }
    },
  };
}

describe('an autoplay run', () => {
  it('plays the planned rounds and stops as COMPLETE, with the engine none the wiser', async () => {
    const t = table();
    await t.engine.start(t.sim.issueSession().token);
    const auto = t.controller();

    expect(auto.start({ spins: 3 })).toBe(true);
    await t.flush();

    expect(t.sim.state.rounds).toHaveLength(3);
    expect(auto.view).toEqual({ active: false, remaining: undefined, stopped: 'COMPLETE' });
    // The engine ends where a human player would have left it.
    expect(t.engine.state.phase).toBe('IDLE');
  });

  it('counts the run down where the AUTO button can watch it', async () => {
    const t = table();
    await t.engine.start(t.sim.issueSession().token);
    const auto = t.controller();

    auto.start({ spins: 2 });
    await t.flush();

    const remaining = t.views.map((view) => view.remaining);
    expect(remaining[0]).toBe(2);
    expect(remaining[remaining.length - 1]).toBeUndefined();
  });

  it('is refused outright where the jurisdiction forbids it', async () => {
    const t = table(JURISDICTION_PRESETS.UK);
    await t.engine.start(t.sim.issueSession().token);
    const auto = t.controller(JURISDICTION_PRESETS.UK);

    expect(auto.start({ spins: 10 })).toBe(false);
    expect(auto.view.stopped).toBe('NOT_ALLOWED');
    expect(t.timers).toHaveLength(0);
    expect(t.sim.state.rounds).toHaveLength(0);
  });

  it('paces automatic presses exactly as it would a human one', async () => {
    // An operator override: autoplay permitted, but the 2.5 s floor still applies. This is the
    // combination that proves autoplay is not a way around the pacing rule.
    const paced: JurisdictionRules = {
      minSpinIntervalMs: 2_500,
      turboAllowed: true,
      autoplayAllowed: true,
      realityCheckIntervalMs: 0,
    };
    const t = table(paced);
    await t.engine.start(t.sim.issueSession().token);
    const auto = t.controller(paced);

    auto.start({ spins: 2 });
    // The first press goes out immediately — nothing has spun yet.
    expect(t.timers[0]?.delay).toBe(0);
    t.timers.shift()?.run();
    await t.engine.settled();
    for (const input of ['REELS_STOPPED', 'PRESENTATION_COMPLETE'] as const) {
      if (t.engine.state.phase !== 'IDLE') t.engine.send({ type: input });
      await t.engine.settled();
    }

    // The clock has not moved, so the second press waits out the whole interval.
    expect(t.timers[0]?.delay).toBe(2_500);
    auto.destroy();
  });

  it('stops on the feature so the player watches what they won', async () => {
    const t = table(undefined, true);
    await t.engine.start(t.sim.issueSession().token);
    const auto = t.controller();

    t.forceFeature();
    auto.start({ spins: 10, stopOnFeature: true });
    await t.flush();

    expect(auto.view.stopped).toBe('FEATURE');
    expect(t.engine.state.phase).toBe('IDLE');
    // The feature round itself was finished, not abandoned mid-way.
    expect(t.sim.state.rounds[0]?.state).toBe('SETTLED');
  });

  it('stops the run the moment an error rises', async () => {
    const t = table();
    await t.engine.start(t.sim.issueSession().token);
    const auto = t.controller();

    auto.start({ spins: 5 });
    t.engine.send({
      type: 'CALL_FAILED',
      error: new SlotError('INSUFFICIENT_FUNDS', 'dry'),
    });

    expect(auto.view.active).toBe(false);
    auto.destroy();
  });

  it('a second toggle stops a running plan cleanly', async () => {
    const t = table();
    await t.engine.start(t.sim.issueSession().token);
    const auto = t.controller();

    auto.start({ spins: 50 });
    auto.stop();

    expect(auto.view).toEqual({ active: false, remaining: undefined, stopped: null });
    expect(t.timers).toHaveLength(0);
  });
});
