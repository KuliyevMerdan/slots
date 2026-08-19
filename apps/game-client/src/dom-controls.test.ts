import { describe, expect, it, vi } from 'vitest';
import type { PanelView } from '@slot/ui';
import { STRINGS } from './i18n.js';
import { createDomControls } from './dom-controls.js';
import type { ControlElement, DomControlHandlers } from './dom-controls.js';

/**
 * The keyboard layer, headless: the DOM arrives as a fake, which is the point of the structural
 * ports — what is asserted is that the buttons say what the view model says, refuse what it
 * refuses, and report activation without interpreting it.
 */

class FakeElement implements ControlElement {
  textContent: string | null = null;
  className = '';
  disabled?: boolean;
  readonly tag: string;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, () => void>();
  removed = false;

  constructor(tag: string) {
    this.tag = tag;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(child: ControlElement): unknown {
    this.children.push(child as FakeElement);
    return child;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  remove(): void {
    this.removed = true;
  }
}

const view = (over: Partial<PanelView> = {}): PanelView => ({
  action: 'SPIN',
  canPress: true,
  canChangeStake: true,
  balance: 10_000 as never,
  stake: 100 as never,
  win: undefined,
  status: '',
  turbo: false,
  canToggleTurbo: true,
  autoplay: false,
  canToggleAutoplay: true,
  autoplayRemaining: undefined,
  ...over,
});

const build = (strings = STRINGS.en) => {
  const host = new FakeElement('div');
  const handlers: DomControlHandlers = {
    onPress: vi.fn(),
    onBetDown: vi.fn(),
    onBetUp: vi.fn(),
    onToggleTurbo: vi.fn(),
    onToggleAutoplay: vi.fn(),
  };
  const controls = createDomControls({
    doc: { createElement: (tag) => new FakeElement(tag) },
    host,
    strings,
    handlers,
  });
  const group = host.children[0] as FakeElement;
  const [betDown, spin, betUp, turbo, auto] = group.children as [
    FakeElement,
    FakeElement,
    FakeElement,
    FakeElement,
    FakeElement,
  ];
  return { controls, handlers, group, betDown, spin, betUp, turbo, auto };
};

describe('the keyboard control layer', () => {
  it('is real buttons, in the order a player scans the panel', () => {
    const { group } = build();

    expect(group.attributes.get('role')).toBe('group');
    expect(group.children.map((child) => child.tag)).toEqual([
      'button',
      'button',
      'button',
      'button',
      'button',
    ]);
  });

  it('renders the same view model the Pixi panel renders', () => {
    const { controls, spin, betDown, turbo, auto } = build();

    controls.render(view({ action: 'STOP', canChangeStake: false, turbo: true, autoplay: true }));

    expect(spin.textContent).toBe('STOP');
    expect(spin.disabled).toBe(false);
    expect(betDown.disabled).toBe(true);
    expect(turbo.attributes.get('aria-pressed')).toBe('true');
    expect(auto.attributes.get('aria-pressed')).toBe('true');
  });

  it('counts an autoplay run down on the button, exactly as the pill does', () => {
    const { controls, auto } = build();

    controls.render(view({ autoplay: true, autoplayRemaining: 9 }));
    expect(auto.textContent).toBe('AUTO 9');

    controls.render(view());
    expect(auto.textContent).toBe('AUTO');
  });

  it('reports activation without interpreting it', () => {
    const { handlers, spin, betUp, turbo, auto } = build();

    spin.listeners.get('click')?.();
    betUp.listeners.get('click')?.();
    turbo.listeners.get('click')?.();
    auto.listeners.get('click')?.();

    expect(handlers.onPress).toHaveBeenCalledTimes(1);
    expect(handlers.onBetUp).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleTurbo).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleAutoplay).toHaveBeenCalledTimes(1);
  });

  it('speaks the session locale — the RU catalogue reaches the keyboard too', () => {
    const { spin, turbo } = build(STRINGS.ru);

    expect(spin.textContent).toBe('СПИН');
    expect(turbo.textContent).toBe('ТУРБО');
  });

  it('takes the whole group down on destroy', () => {
    const { controls, group } = build();

    controls.destroy();

    expect(group.removed).toBe(true);
  });
});
