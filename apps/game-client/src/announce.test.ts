import { describe, expect, it } from 'vitest';
import type { PanelView } from '@slot/ui';
import { createAnnouncer } from './announce.js';

const view = (over: Partial<PanelView> = {}): PanelView => ({
  action: 'SPIN',
  canPress: true,
  canChangeStake: true,
  balance: 98_000 as never,
  stake: 100 as never,
  win: undefined,
  status: '',
  turbo: false,
  canToggleTurbo: true,
  ...over,
});

const announcer = (region: { textContent: string | null } | null = { textContent: null }) => ({
  region,
  it: createAnnouncer({ currency: 'EUR', locale: 'en', region }),
});

describe('the live region', () => {
  it('says the money and what to do, in that order', () => {
    const { it: announce } = announcer();

    expect(announce.announce(view())).toBe('balance €980.00, stake €1.00, ready to spin');
  });

  it('adds the win only once there is one', () => {
    const { it: announce } = announcer();

    expect(announce.announce(view({ win: 0 as never }))).not.toContain('win');
    expect(announce.announce(view({ win: 450 as never }))).toContain('win €4.50');
  });

  it('prefers the server’s own words when something went wrong', () => {
    const { it: announce } = announcer();

    const said = announce.announce(view({ action: 'RETRY', status: 'WALLET UNAVAILABLE' }));

    expect(said).toContain('wallet unavailable');
    expect(said).toContain('connection problem, press to retry');
  });

  it('says a frozen game is frozen, rather than leaving silence', () => {
    const { it: announce } = announcer();

    expect(announce.announce(view({ action: 'FROZEN' }))).toContain('needs a reload');
  });

  it('writes into the region it was given', () => {
    const { region, it: announce } = announcer();

    announce.announce(view());

    expect(region?.textContent).toContain('ready to spin');
  });

  /**
   * The property that decides whether this is usable: a slot renders every frame, and re-writing an
   * identical sentence makes some screen readers announce it again. A player would hear the balance
   * sixty times a second.
   */
  it('says nothing when nothing changed', () => {
    const { it: announce } = announcer();

    expect(announce.announce(view())).not.toBeNull();
    expect(announce.announce(view())).toBeNull();
    expect(announce.announce(view())).toBeNull();
    expect(announce.announce(view({ action: 'STOP' }))).not.toBeNull();
  });

  it('works without a region at all, for a shell that was cut down', () => {
    const { it: announce } = announcer(null);

    expect(() => announce.announce(view())).not.toThrow();
  });
});
