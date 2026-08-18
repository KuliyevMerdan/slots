import { describe, expect, it, vi } from 'vitest';
import type { GameConfig, Minor } from '@slot/protocol';
import { BetSelector } from './bet-selector.js';
import { ControlPanel } from './panel.js';

/**
 * The control surface, headless.
 *
 * What matters here is not how it looks — that is a screenshot's job — but that it cannot produce an
 * illegal request. The stake it reports is always one of the server's bet levels, and the panel
 * renders whatever view model it is handed without deciding anything about phases.
 */

const LEVELS = [20, 40, 100, 200] as Minor[];

const config = { betLevels: LEVELS } as unknown as GameConfig;

const selector = () => {
  const changes: Minor[] = [];
  const bet = new BetSelector({
    levels: LEVELS,
    currency: 'EUR',
    onChange: (stake) => changes.push(stake),
  });
  // The two step buttons, in the order they were added: down, then up.
  const [, , , down, up] = bet.view.children;
  return {
    bet,
    changes,
    down: down as { emit: (event: string) => void },
    up: up as { emit: (event: string) => void },
  };
};

describe('the bet selector', () => {
  it('only ever reports a stake the server offered', () => {
    const { changes, up } = selector();

    up.emit('pointertap');
    up.emit('pointertap');

    expect(changes).toEqual([40, 100]);
    for (const stake of changes) expect(LEVELS).toContain(stake);
  });

  it('stops at both ends of the table rather than wrapping', () => {
    const { changes, down, up } = selector();

    down.emit('pointertap');
    expect(changes).toEqual([]);

    for (let step = 0; step < 10; step += 1) up.emit('pointertap');
    expect(changes.at(-1)).toBe(LEVELS.at(-1));
    expect(changes).toHaveLength(LEVELS.length - 1);
  });

  it('does not change the stake while a round is in flight', () => {
    const { bet, changes, up } = selector();

    bet.enabled = false;
    up.emit('pointertap');

    expect(changes).toEqual([]);
  });
});

describe('the control panel', () => {
  const build = () => {
    const presses: number[] = [];
    const stakes: Minor[] = [];
    const panel = new ControlPanel({
      config,
      currency: 'EUR',
      onPress: () => presses.push(1),
      onStakeChange: (stake) => stakes.push(stake),
    });
    return { panel, presses, stakes };
  };

  it('renders whatever the caller says the phase means', () => {
    const { panel } = build();

    panel.render({
      action: 'STOP',
      canPress: true,
      canChangeStake: false,
      balance: 999_980 as Minor,
      stake: 20 as Minor,
      win: undefined,
      status: '',
    });

    // The win readout is hidden rather than zeroed: a dead spin shows no win, it does not show 0.00.
    expect(panel.hud.win.view.visible).toBe(false);
  });

  it('shows the win when there is one', () => {
    const { panel } = build();

    panel.render({
      action: 'SKIP',
      canPress: true,
      canChangeStake: false,
      balance: 999_980 as Minor,
      stake: 20 as Minor,
      win: 140 as Minor,
      status: '',
    });

    expect(panel.hud.win.view.visible).toBe(true);
  });

  it('reports a press without interpreting it', () => {
    const { panel, presses } = build();
    const spy = vi.fn();
    // Pixi types `emit` against the real pointer-event payload; the button reads nothing off it, so
    // a test drives the listener through the narrow shape it actually uses.
    const face = panel.button.view as unknown as {
      on: (event: string, listener: () => void) => void;
      emit: (event: string) => void;
    };
    face.on('pointerup', spy);

    face.emit('pointerup');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(presses).toEqual([1]);
  });
});
