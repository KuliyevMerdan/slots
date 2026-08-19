import { describe, expect, it, vi } from 'vitest';
import type { HistoryRes, Minor, RoundId } from '@slot/protocol';
import { createHistoryPanel } from './history.js';
import type { HistoryElement } from './history.js';
import { STRINGS } from './i18n.js';

/**
 * The history panel, headless: a fake DOM, a fake fetch, and assertions about what a player would
 * read — server numbers formatted with the session's currency, the retention stated, and a failed
 * fetch that becomes a sentence rather than a broken screen.
 */

class FakeElement implements HistoryElement {
  textContent: string | null = null;
  className = '';
  hidden?: boolean;
  readonly tag: string;
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  removed = false;

  constructor(tag: string) {
    this.tag = tag;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(child: unknown): unknown {
    this.children.push(child as FakeElement);
    return child;
  }

  replaceChildren(...children: unknown[]): void {
    this.children = children as FakeElement[];
  }

  remove(): void {
    this.removed = true;
  }
}

const doc = { createElement: (tag: string): FakeElement => new FakeElement(tag) };

function all(root: FakeElement, predicate: (element: FakeElement) => boolean): FakeElement[] {
  const found: FakeElement[] = [];
  const walk = (element: FakeElement): void => {
    if (predicate(element)) found.push(element);
    for (const child of element.children) walk(child);
  };
  walk(root);
  return found;
}

const byClass = (root: FakeElement, className: string): FakeElement[] =>
  all(root, (element) => element.className.split(' ').includes(className));

const minor = (value: number): Minor => value as Minor;

const response: HistoryRes = {
  rounds: [
    {
      roundId: 'round-0002' as RoundId,
      at: Date.UTC(2026, 7, 19, 12, 30),
      stake: minor(200),
      totalWin: minor(50_000),
      capped: true,
      freeSpins: 10,
    },
    {
      roundId: 'round-0001' as RoundId,
      at: Date.UTC(2026, 7, 19, 12, 29),
      stake: minor(200),
      totalWin: minor(0),
      capped: false,
      freeSpins: 0,
    },
  ],
  retention: 50,
};

describe('the round-history panel', () => {
  it('lists the response verbatim — one row per round, newest first, server numbers formatted', async () => {
    const built = createHistoryPanel({
      doc,
      host: new FakeElement('div'),
      currency: 'EUR',
      strings: STRINGS.en,
      fetchHistory: () => Promise.resolve(response),
    });
    await built.refresh();
    const rows = byClass(built.element as FakeElement, 'history-row');

    expect(rows).toHaveLength(2);
    // The capped feature round: win formatted in the session's currency, marked MAX, spins named.
    expect(byClass(rows[0] as FakeElement, 'history-win')[0]?.textContent).toBe('€500.00 MAX');
    expect(byClass(rows[0] as FakeElement, 'history-feature')[0]?.textContent).toBe(
      '10 free spins',
    );
    // The dead base round: zero win, no capped mark, no feature line.
    expect(byClass(rows[1] as FakeElement, 'history-win')[0]?.textContent).toBe('€0.00');
    expect(byClass(rows[1] as FakeElement, 'history-feature')).toHaveLength(0);
  });

  it('states the retention honestly', async () => {
    const built = createHistoryPanel({
      doc,
      host: new FakeElement('div'),
      currency: 'EUR',
      strings: STRINGS.en,
      fetchHistory: () => Promise.resolve(response),
    });
    await built.refresh();

    expect(byClass(built.element as FakeElement, 'history-retention')[0]?.textContent).toBe(
      'This demo server keeps only the last 50 settled rounds.',
    );
  });

  it('says so when there is nothing to list', async () => {
    const built = createHistoryPanel({
      doc,
      host: new FakeElement('div'),
      currency: 'EUR',
      strings: STRINGS.en,
      fetchHistory: () => Promise.resolve({ rounds: [], retention: 50 }),
    });
    await built.refresh();

    expect(byClass(built.element as FakeElement, 'history-status')[0]?.textContent).toBe(
      'No settled rounds yet.',
    );
    expect(byClass(built.element as FakeElement, 'history-row')).toHaveLength(0);
  });

  it('turns a failed fetch into a sentence, never a broken screen', async () => {
    const built = createHistoryPanel({
      doc,
      host: new FakeElement('div'),
      currency: 'EUR',
      strings: STRINGS.en,
      fetchHistory: () => Promise.reject(new Error('the line is down')),
    });
    await built.refresh();

    expect(byClass(built.element as FakeElement, 'history-status')[0]?.textContent).toBe(
      'Could not load the history.',
    );
    expect(byClass(built.element as FakeElement, 'history-row')).toHaveLength(0);
  });

  it('refetches on every refresh, so the list is never stale', async () => {
    const fetchHistory = vi.fn(() => Promise.resolve(response));
    const built = createHistoryPanel({
      doc,
      host: new FakeElement('div'),
      currency: 'EUR',
      strings: STRINGS.en,
      fetchHistory,
    });

    await built.refresh();
    await built.refresh();

    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });
});
