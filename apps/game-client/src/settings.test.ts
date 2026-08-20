import { describe, expect, it, vi } from 'vitest';
import { createSettingsPanel } from './settings.js';
import type { SettingsElement } from './settings.js';
import { DEFAULT_PROTECTION } from './persistence.js';
import { STRINGS } from './i18n.js';

/**
 * The protection picker, headless: a fake DOM, assertions about what a player can set and what
 * the wiring is handed back. The panel's whole contract is "render the current settings, emit a
 * complete fresh object on every change" — the enforcement lives in the wiring and is
 * `@slot/compliance`'s arithmetic, tested where it lives.
 */

class FakeElement implements SettingsElement {
  textContent: string | null = null;
  className = '';
  hidden?: boolean;
  value?: string;
  checked?: boolean;
  readonly tag: string;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  children: FakeElement[] = [];
  removed = false;

  constructor(tag: string) {
    this.tag = tag;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  appendChild(child: unknown): unknown {
    this.children.push(child as FakeElement);
    return child;
  }

  remove(): void {
    this.removed = true;
  }
}

const doc = { createElement: (tag: string): FakeElement => new FakeElement(tag) };

const all = (root: FakeElement, predicate: (element: FakeElement) => boolean): FakeElement[] => {
  const found: FakeElement[] = [];
  const walk = (element: FakeElement): void => {
    if (predicate(element)) found.push(element);
    for (const child of element.children) walk(child);
  };
  walk(root);
  return found;
};

const open = (onChange: (next: unknown) => void = () => undefined) => {
  const host = new FakeElement('aside');
  const panel = createSettingsPanel({
    doc,
    host,
    strings: STRINGS.en,
    current: DEFAULT_PROTECTION,
    spinsChoices: [10, 25, 50],
    multipleChoices: [10, 25],
    minutesChoices: [30, 60],
    lossChoices: [{ minor: 100_000, label: '€1,000.00' }],
    onChange,
  });
  const root = host.children[0];
  if (root === undefined) throw new Error('the panel did not mount');
  return { panel, root };
};

describe('the protection picker', () => {
  it('says what it is before anything else — limits stop play, nothing changes the game', () => {
    const { root } = open();
    expect(root.children[0]?.textContent).toBe(STRINGS.en.settingsIntro);
  });

  it('renders the current settings selected, with every optional limit off', () => {
    const { root } = open();
    const selects = all(root, (element) => element.tag === 'select');
    // spins, win stop, loss stop, session time, session loss — in document order.
    expect(selects.map((select) => select.value)).toEqual(['25', '', '', '', '']);
    const checkbox = all(root, (element) => element.tag === 'input')[0];
    expect(checkbox?.checked).toBe(true);
  });

  it('hands the wiring a complete settings object on every change', () => {
    const onChange = vi.fn();
    const { root } = open(onChange);
    const selects = all(root, (element) => element.tag === 'select');

    const winStop = selects[1];
    if (winStop === undefined) throw new Error('no win-stop select');
    winStop.value = '25';
    winStop.listeners.get('change')?.();

    expect(onChange).toHaveBeenLastCalledWith({
      autoplaySpins: 25,
      stopOnFeature: true,
      winLimitX: 25,
    });

    const sessionLoss = selects[4];
    if (sessionLoss === undefined) throw new Error('no session-loss select');
    sessionLoss.value = '100000';
    sessionLoss.listeners.get('change')?.();

    expect(onChange).toHaveBeenLastCalledWith({
      autoplaySpins: 25,
      stopOnFeature: true,
      winLimitX: 25,
      maxLossMinor: 100_000,
    });
  });

  it('turning a limit back off removes the field rather than zeroing it', () => {
    const onChange = vi.fn();
    const { root } = open(onChange);
    const selects = all(root, (element) => element.tag === 'select');
    const sessionTime = selects[3];
    if (sessionTime === undefined) throw new Error('no session-time select');

    sessionTime.value = '60';
    sessionTime.listeners.get('change')?.();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxSessionMinutes: 60 }));

    sessionTime.value = '';
    sessionTime.listeners.get('change')?.();
    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect('maxSessionMinutes' in last).toBe(false);
  });

  it('shows session-loss money only as the labels the wiring pre-formatted', () => {
    const { root } = open();
    const options = all(root, (element) => element.tag === 'option');
    expect(options.some((option) => option.textContent === '€1,000.00')).toBe(true);
  });

  it('removes its root on destroy', () => {
    const { panel, root } = open();
    panel.destroy();
    expect(root.removed).toBe(true);
  });
});
