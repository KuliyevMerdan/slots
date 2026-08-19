import { describe, expect, it, vi } from 'vitest';
import type { GameConfig, Minor, RoundId } from '@slot/protocol';
import type { EngineEvent, EngineState } from '@slot/engine';
import { createDebugPanel, summarize } from './panel.js';
import type { DebugPanelOptions, EnginePort, PanelElement } from './panel.js';

/**
 * The panel, headless: the DOM arrives as a fake (the dom-controls pattern), the engine as a
 * five-line stub. What is asserted is the contract — sections appear only for the ports that
 * exist, buttons call the seams they were given, and the log and inspector follow the event
 * stream — not the pixels.
 */

class FakeElement implements PanelElement {
  textContent: string | null = null;
  className = '';
  disabled?: boolean;
  value?: string;
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

  appendChild(child: unknown): unknown {
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

const doc = { createElement: (tag: string): FakeElement => new FakeElement(tag) };

/** Depth-first walk — the panel's structure is a tree of fakes. */
function all(root: FakeElement, predicate: (element: FakeElement) => boolean): FakeElement[] {
  const found: FakeElement[] = [];
  const walk = (element: FakeElement): void => {
    if (predicate(element)) found.push(element);
    for (const child of element.children) walk(child);
  };
  walk(root);
  return found;
}

const buttonByLabel = (root: FakeElement, label: string): FakeElement | undefined =>
  all(root, (element) => element.tag === 'button' && element.textContent === label)[0];

const headings = (root: FakeElement): (string | null)[] =>
  all(root, (element) => element.tag === 'h3').map((element) => element.textContent);

const click = (element: FakeElement | undefined): void => {
  const listener = element?.listeners.get('click');
  if (listener === undefined) throw new Error('no click listener');
  listener();
};

/** Async ports resolve between assertions. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FakeEngine implements EnginePort {
  state: EngineState = { phase: 'BOOTING' };
  #listeners: ((event: EngineEvent) => void)[] = [];

  on(listener: (event: EngineEvent) => void): () => void {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((existing) => existing !== listener);
    };
  }

  emit(event: EngineEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

const minor = (value: number): Minor => value as Minor;
const roundId = 'round-0001' as RoundId;

const idle = (): EngineState =>
  ({
    phase: 'IDLE',
    config: {} as GameConfig,
    balance: minor(5_000),
    stake: minor(100),
  }) as EngineState;

const spinStarted: EngineEvent = { type: 'SPIN_STARTED', roundId, stake: minor(100) };
const stakeChanged: EngineEvent = { type: 'STAKE_CHANGED', stake: minor(200) };

function build(overrides: Partial<DebugPanelOptions> = {}): {
  engine: FakeEngine;
  host: FakeElement;
  force: ReturnType<typeof vi.fn>;
  panel: ReturnType<typeof createDebugPanel>;
} {
  const engine = new FakeEngine();
  const host = new FakeElement('div');
  const force = vi.fn();
  const panel = createDebugPanel({
    doc,
    host,
    engine,
    now: () => 1_700_000_000_000,
    force,
    ...overrides,
  });
  return { engine, host, force, panel };
}

describe('the debug panel', () => {
  it('renders only the sections whose ports exist', () => {
    const { host } = build();
    const root = host.children[0];
    expect(root).toBeDefined();
    if (root === undefined) return;

    expect(headings(root)).toEqual(['FORCE OUTCOME', 'STATE', 'EVENT LOG']);
    expect(buttonByLabel(root, 'FETCH SERVER STATE')).toBeUndefined();
    expect(buttonByLabel(root, 'EXPORT')).toBeUndefined();
  });

  it('renders faults, jurisdiction and session sections when their ports are given', () => {
    const { host } = build({
      faults: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      jurisdiction: { current: 'DEFAULT', options: ['DEFAULT', 'UK'], set: vi.fn() },
      session: { expire: vi.fn() },
      serverState: () => Promise.resolve({}),
      download: vi.fn(),
    });
    const root = host.children[0];
    if (root === undefined) throw new Error('panel did not render');

    expect(headings(root)).toEqual([
      'FORCE OUTCOME',
      'FAULTS',
      'JURISDICTION',
      'SESSION',
      'STATE',
      'EVENT LOG',
    ]);
    expect(buttonByLabel(root, 'FETCH SERVER STATE')).toBeDefined();
    expect(buttonByLabel(root, 'EXPORT')).toBeDefined();
  });

  it('arms a forced scenario for the next spin and says so', () => {
    const { host, force } = build();
    const root = host.children[0];
    if (root === undefined) throw new Error('panel did not render');

    click(buttonByLabel(root, 'MAX_WIN'));

    expect(force).toHaveBeenCalledWith({ scenario: 'MAX_WIN' });
    const armed = all(root, (element) => element.className === 'devtools-note')[0];
    expect(armed?.textContent).toBe('armed: MAX_WIN (next spin)');
  });

  it('loads the current faults into the fields, and applies what the fields say', async () => {
    const set = vi.fn(() => Promise.resolve());
    const { host } = build({
      faults: { get: () => Promise.resolve({ latencyMs: 120, dropRate: 0.25 }), set },
    });
    const root = host.children[0];
    if (root === undefined) throw new Error('panel did not render');
    await flush();

    const inputs = all(root, (element) => element.tag === 'input');
    const [latency, jitter, drop] = inputs;
    expect(latency?.value).toBe('120');
    expect(jitter?.value).toBe('0');
    expect(drop?.value).toBe('0.25');

    if (latency !== undefined) latency.value = '300';
    click(buttonByLabel(root, 'APPLY'));
    await flush();

    expect(set).toHaveBeenCalledWith({ latencyMs: 300, dropRate: 0.25 });
  });

  it('applies a chosen error rate under its code, and clears back to no faults', async () => {
    const set = vi.fn(() => Promise.resolve());
    const { host } = build({ faults: { get: () => Promise.resolve({}), set } });
    const root = host.children[0];
    if (root === undefined) throw new Error('panel did not render');
    await flush();

    const select = all(root, (element) => element.tag === 'select')[0];
    if (select !== undefined) select.value = 'TIMEOUT';
    const errorRate = all(root, (element) => element.tag === 'input')[5];
    if (errorRate !== undefined) errorRate.value = '0.5';

    click(buttonByLabel(root, 'APPLY'));
    await flush();
    expect(set).toHaveBeenLastCalledWith({ errorRates: { TIMEOUT: 0.5 } });

    click(buttonByLabel(root, 'CLEAR'));
    await flush();
    expect(set).toHaveBeenLastCalledWith({});
    expect(errorRate?.value).toBe('0');
  });

  it('switches jurisdiction only on the apply button, never on browsing', () => {
    const setJurisdiction = vi.fn();
    const { host } = build({
      jurisdiction: { current: 'DEFAULT', options: ['DEFAULT', 'UK'], set: setJurisdiction },
    });
    const root = host.children[0];
    if (root === undefined) throw new Error('panel did not render');

    const select = all(root, (element) => element.tag === 'select')[0];
    expect(select?.value).toBe('DEFAULT');
    if (select !== undefined) select.value = 'UK';
    expect(setJurisdiction).not.toHaveBeenCalled();

    click(buttonByLabel(root, 'APPLY & RESTART'));
    expect(setJurisdiction).toHaveBeenCalledWith('UK');
  });

  it('expires the session through the port', () => {
    const expire = vi.fn();
    const { host } = build({ session: { expire } });
    const root = host.children[0];
    if (root === undefined) throw new Error('panel did not render');

    click(buttonByLabel(root, 'EXPIRE SESSION'));
    expect(expire).toHaveBeenCalledOnce();
  });

  it('fetches the server state into the inspector on demand', async () => {
    const { host } = build({ serverState: () => Promise.resolve({ balance: 5_000, seq: 7 }) });
    const root = host.children[0];
    if (root === undefined) throw new Error('panel did not render');

    click(buttonByLabel(root, 'FETCH SERVER STATE'));
    await flush();

    const views = all(root, (element) => element.className === 'devtools-state');
    expect(views[1]?.textContent).toContain('"seq": 7');
  });

  it('follows the engine: the inspector re-renders and the log grows on every event', () => {
    const { host, engine } = build();
    const root = host.children[0];
    if (root === undefined) throw new Error('panel did not render');

    const state = all(root, (element) => element.className === 'devtools-state')[0];
    expect(state?.textContent).toContain('"phase": "BOOTING"');

    engine.state = idle();
    engine.emit(spinStarted);
    engine.emit(stakeChanged);

    expect(state?.textContent).toContain('"phase": "IDLE"');
    const lines = all(root, (element) => element.className === 'devtools-log')[0];
    expect(lines?.textContent).toContain('SPIN_STARTED');
    expect(lines?.textContent).toContain('STAKE_CHANGED');
    // Correlation is visible: the stake change happened inside the round, so its line names it.
    const logLines = (lines?.textContent ?? '').split('\n');
    expect(logLines[1]).toContain(roundId.slice(-8));
  });

  it('exports the log through the download seam and clears it on demand', () => {
    const download = vi.fn();
    const { host, engine } = build({ download });
    const root = host.children[0];
    if (root === undefined) throw new Error('panel did not render');

    engine.emit(spinStarted);
    click(buttonByLabel(root, 'EXPORT'));

    expect(download).toHaveBeenCalledOnce();
    const [filename, text] = download.mock.calls[0] as [string, string];
    expect(filename).toBe('slot-event-log.json');
    const parsed = JSON.parse(text) as { entries: { type: string }[] };
    expect(parsed.entries[0]?.type).toBe('SPIN_STARTED');

    click(buttonByLabel(root, 'CLEAR'));
    const count = all(root, (element) => element.className === 'devtools-note').at(-1);
    expect(count?.textContent).toBe('0 entries');
  });

  it('destroy unsubscribes from the engine and removes the panel', () => {
    const { host, engine, panel } = build();
    const root = host.children[0];
    if (root === undefined) throw new Error('panel did not render');

    panel.destroy();
    engine.emit(spinStarted);

    expect(panel.log.entries()).toHaveLength(0);
    expect(root.removed).toBe(true);
  });
});

describe('the state summary', () => {
  it('answers where the machine is and what money it holds — never the whole config', () => {
    const summary = summarize(idle());
    expect(summary).toEqual({ phase: 'IDLE', balance: 5_000, stake: 100 });
    expect('config' in summary).toBe(false);
  });

  it('names the error, its class and the way out for an ERROR phase', () => {
    const state = {
      phase: 'ERROR',
      error: { code: 'TIMEOUT', errorClass: 'RECOVERABLE' },
      recovery: 'RETRY',
      resume: idle(),
    } as unknown as EngineState;

    expect(summarize(state)).toMatchObject({
      phase: 'ERROR',
      error: { code: 'TIMEOUT', class: 'RECOVERABLE', recovery: 'RETRY' },
      resume: 'IDLE',
    });
  });
});
