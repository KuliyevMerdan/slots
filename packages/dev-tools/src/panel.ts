import { ERROR_CODES, FORCE_OUTCOME_SCENARIOS } from '@slot/protocol';
import type { ErrorCode, ForceOutcome, JurisdictionId } from '@slot/protocol';
import type { EngineEvent, EngineState } from '@slot/engine';
import { EventLog } from './log.js';

/**
 * The debug panel — the developer's hands on every seam the architecture already exposes.
 *
 * Nothing here is a new capability. Forcing an outcome is the client's existing one-shot
 * `forceOutcome` provider; fault injection is the simulator's `setFaults` (or `/dev/faults` over
 * HTTP); expiring the session is `expireSession`; the state inspector reads the engine's own
 * `state` and the server's `/dev/state` summary. The panel is those seams made visible — which is
 * why it lives in its own package the production bundle never contains, and why removing it
 * removes nothing the game uses.
 *
 * Everything DOM arrives injected and structural (the `dom-controls.ts` pattern), so the whole
 * panel tests headless in Node with a fake document a few lines long. Every capability port is
 * optional: a section whose port is absent is not rendered, so the same panel serves the
 * in-process simulator (which has no network to fault) and the HTTP path (which has no live
 * jurisdiction switch) without either pretending.
 */

/* ── structural DOM ports ─────────────────────────────────────────────────────────────────── */

export interface PanelElement {
  textContent: string | null;
  className: string;
  disabled?: boolean;
  /** The drawer shows and hides the panel through this. */
  hidden?: boolean;
  /** Inputs and selects. Plain string — the panel parses; the DOM would have done the same. */
  value?: string;
  setAttribute(name: string, value: string): void;
  /** `unknown` so the real DOM's generic `appendChild` satisfies this structurally. */
  appendChild(child: unknown): unknown;
  addEventListener(type: string, listener: () => void): void;
  remove(): void;
}

export interface PanelDocument {
  createElement(tag: string): PanelElement;
}

/* ── capability ports ─────────────────────────────────────────────────────────────────────── */

/** The engine, structurally — `SlotEngine` satisfies this; a five-line fake satisfies it too. */
export interface EnginePort {
  readonly state: EngineState;
  on(listener: (event: EngineEvent) => void): () => void;
}

/**
 * The fault dial, as the panel sees it.
 *
 * Structurally identical to `@slot/rgs-sim`'s `FaultConfig` — deliberately not imported, because
 * the dependency table says `dev-tools → protocol, money, engine` and the simulator is not on it.
 * The wiring site hands over an object the simulator's own type satisfies (the ADR-0003 shape:
 * when the boundary forbids the import, take the shape as an argument).
 */
export interface FaultView {
  latencyMs?: number;
  jitterMs?: number;
  errorRates?: Partial<Record<ErrorCode, number>>;
  dropRate?: number;
  slowMs?: number;
  slowRate?: number;
}

export interface DebugPanelOptions {
  doc: PanelDocument;
  /** Where the panel renders — the drawer body the client owns. */
  host: { appendChild(child: unknown): unknown };
  engine: EnginePort;
  /** Injected clock for the log's timestamps. Defaults to `Date.now`. */
  now?: () => number;
  /** Arm the next spin with a forced outcome — the client's existing one-shot provider. */
  force(outcome: ForceOutcome): void;
  /** Read and write the fault dial. Absent → the section is not rendered. */
  faults?: {
    get(): Promise<FaultView>;
    set(view: FaultView): Promise<void>;
  };
  /** Switch jurisdiction. `set` is expected to restart the session — a regime is not hot-swapped. */
  jurisdiction?: {
    current: JurisdictionId;
    options: readonly JurisdictionId[];
    set(id: JurisdictionId): void;
  };
  /** Kill the session now — the producer of `SESSION_EXPIRED` on demand. */
  session?: {
    expire(): void;
  };
  /** The server's own account of what is true — `/dev/state`, or the sim's state summary. */
  serverState?: () => Promise<unknown>;
  /** The export seam: receives the log as JSON; the client turns it into a download. */
  download?: (filename: string, text: string) => void;
  logCapacity?: number;
}

export interface DebugPanel {
  /** The panel's root, for the client to place. */
  readonly element: PanelElement;
  /** The log, exposed so the console keeps working as an inspector beside the panel. */
  readonly log: EventLog;
  destroy(): void;
}

/* ── the state inspector's summary ────────────────────────────────────────────────────────── */

/**
 * The engine's state, curated for reading.
 *
 * Deliberately not `JSON.stringify(state)`: a session phase carries the whole `GameConfig` —
 * strips, paytable, paylines — and a resume chain nests entire states. The inspector answers
 * "where is the machine and what money does it hold", and the fields below are that answer.
 */
export function summarize(state: EngineState): Record<string, unknown> {
  const summary: Record<string, unknown> = { phase: state.phase };

  if ('balance' in state) summary['balance'] = state.balance;
  if ('stake' in state) summary['stake'] = state.stake;
  if ('roundId' in state) summary['roundId'] = state.roundId;
  if ('roundWin' in state) summary['roundWin'] = state.roundWin;
  if ('capped' in state && state.capped) summary['capped'] = true;
  if ('step' in state) summary['step'] = state.step;
  if ('next' in state) summary['next'] = state.next;
  if ('slam' in state && state.slam) summary['slam'] = true;
  if ('feature' in state && state.feature !== undefined) {
    summary['feature'] = { total: state.feature.total, remaining: state.feature.remaining };
  }
  if (state.phase === 'ERROR') {
    summary['error'] = {
      code: state.error.code,
      class: state.error.errorClass,
      recovery: state.recovery,
    };
    summary['resume'] = state.resume.phase;
  }
  if (state.phase === 'REAUTHENTICATING') {
    summary['error'] = { code: state.error.code };
    summary['resume'] = state.resume.phase;
  }

  return summary;
}

/* ── the panel ────────────────────────────────────────────────────────────────────────────── */

/** How many log lines the panel shows live. The export carries the full log; this is a tail. */
const VISIBLE_LOG_LINES = 14;

export function createDebugPanel(options: DebugPanelOptions): DebugPanel {
  const { doc, host, engine, force } = options;
  const log = new EventLog({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.logCapacity === undefined ? {} : { capacity: options.logCapacity }),
  });

  const root = doc.createElement('div');
  root.className = 'devtools';

  const section = (title: string): PanelElement => {
    const box = doc.createElement('section');
    box.className = 'devtools-section';
    const heading = doc.createElement('h3');
    heading.textContent = title;
    box.appendChild(heading);
    root.appendChild(box);
    return box;
  };

  const button = (parent: PanelElement, label: string, onActivate: () => void): PanelElement => {
    const element = doc.createElement('button');
    element.textContent = label;
    element.setAttribute('type', 'button');
    element.addEventListener('click', onActivate);
    parent.appendChild(element);
    return element;
  };

  const note = (parent: PanelElement): PanelElement => {
    const line = doc.createElement('p');
    line.className = 'devtools-note';
    line.textContent = '';
    parent.appendChild(line);
    return line;
  };

  const labelled = (parent: PanelElement, label: string, field: PanelElement): void => {
    const row = doc.createElement('label');
    row.className = 'devtools-field';
    const caption = doc.createElement('span');
    caption.textContent = label;
    row.appendChild(caption);
    row.appendChild(field);
    parent.appendChild(row);
  };

  const numberInput = (parent: PanelElement, label: string, initial: string): PanelElement => {
    const field = doc.createElement('input');
    field.setAttribute('type', 'number');
    field.setAttribute('min', '0');
    field.value = initial;
    labelled(parent, label, field);
    return field;
  };

  /* ── force outcome ── */
  {
    const box = section('FORCE OUTCOME');
    const armed = note(box);
    for (const scenario of FORCE_OUTCOME_SCENARIOS) {
      button(box, scenario, () => {
        force({ scenario });
        armed.textContent = `armed: ${scenario} (next spin)`;
      });
    }
  }

  /* ── fault injection ── */
  if (options.faults !== undefined) {
    const faults = options.faults;
    const box = section('FAULTS');
    const status = note(box);

    const latency = numberInput(box, 'latency ms', '0');
    const jitter = numberInput(box, 'jitter ms', '0');
    const drop = numberInput(box, 'drop rate 0..1', '0');
    const slowMs = numberInput(box, 'slow ms', '0');
    const slowRate = numberInput(box, 'slow rate 0..1', '0');

    const errorCode = doc.createElement('select');
    for (const code of ERROR_CODES) {
      const option = doc.createElement('option');
      option.value = code;
      option.textContent = code;
      errorCode.appendChild(option);
    }
    errorCode.value = ERROR_CODES[0];
    labelled(box, 'error code', errorCode);
    const errorRate = numberInput(box, 'error rate 0..1', '0');

    /** `NaN`-safe and zero-omitting: an empty field means "not this fault", not "this fault at 0". */
    const rate = (field: PanelElement): number | undefined => {
      const parsed = Number(field.value ?? '');
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    };

    const read = (): FaultView => {
      const latencyMs = rate(latency);
      const jitterMs = rate(jitter);
      const dropRate = rate(drop);
      const slow = rate(slowMs);
      const slowChance = rate(slowRate);
      const chosenRate = rate(errorRate);
      const code = (errorCode.value ?? ERROR_CODES[0]) as ErrorCode;
      return {
        ...(latencyMs === undefined ? {} : { latencyMs }),
        ...(jitterMs === undefined ? {} : { jitterMs }),
        ...(dropRate === undefined ? {} : { dropRate }),
        ...(slow === undefined ? {} : { slowMs: slow }),
        ...(slowChance === undefined ? {} : { slowRate: slowChance }),
        ...(chosenRate === undefined ? {} : { errorRates: { [code]: chosenRate } }),
      };
    };

    const write = (view: FaultView): void => {
      latency.value = String(view.latencyMs ?? 0);
      jitter.value = String(view.jitterMs ?? 0);
      drop.value = String(view.dropRate ?? 0);
      slowMs.value = String(view.slowMs ?? 0);
      slowRate.value = String(view.slowRate ?? 0);
      const [code, chosenRate] = Object.entries(view.errorRates ?? {})[0] ?? [];
      if (code !== undefined) {
        errorCode.value = code;
        errorRate.value = String(chosenRate);
      } else {
        errorRate.value = '0';
      }
    };

    button(box, 'APPLY', () => {
      faults.set(read()).then(
        () => {
          status.textContent = 'faults applied';
        },
        (cause: unknown) => {
          status.textContent = `apply failed: ${String(cause)}`;
        },
      );
    });

    button(box, 'CLEAR', () => {
      faults.set({}).then(
        () => {
          write({});
          status.textContent = 'faults cleared';
        },
        (cause: unknown) => {
          status.textContent = `clear failed: ${String(cause)}`;
        },
      );
    });

    // Show what the server is actually doing right now, not what the fields happen to hold.
    faults.get().then(write, () => {
      status.textContent = 'could not read current faults';
    });
  }

  /* ── jurisdiction ── */
  if (options.jurisdiction !== undefined) {
    const jurisdiction = options.jurisdiction;
    const box = section('JURISDICTION');
    const select = doc.createElement('select');
    for (const id of jurisdiction.options) {
      const option = doc.createElement('option');
      option.value = id;
      option.textContent = id;
      select.appendChild(option);
    }
    select.value = jurisdiction.current;
    labelled(box, 'regime', select);
    // A regime change restarts the session — behind a button rather than the select's own change
    // event, so browsing the list cannot reload the game out from under the developer.
    button(box, 'APPLY & RESTART', () => {
      jurisdiction.set((select.value ?? jurisdiction.current) as JurisdictionId);
    });
  }

  /* ── session ── */
  if (options.session !== undefined) {
    const session = options.session;
    const box = section('SESSION');
    const status = note(box);
    button(box, 'EXPIRE SESSION', () => {
      session.expire();
      status.textContent = 'session expired — the next call will be refused';
    });
  }

  /* ── state inspector ── */
  const inspector = section('STATE');
  const engineState = doc.createElement('pre');
  engineState.className = 'devtools-state';
  inspector.appendChild(engineState);

  if (options.serverState !== undefined) {
    const serverState = options.serverState;
    const view = doc.createElement('pre');
    view.className = 'devtools-state';
    view.textContent = '';
    button(inspector, 'FETCH SERVER STATE', () => {
      serverState().then(
        (state) => {
          view.textContent = JSON.stringify(state, null, 2);
        },
        (cause: unknown) => {
          view.textContent = `fetch failed: ${String(cause)}`;
        },
      );
    });
    inspector.appendChild(view);
  }

  const renderState = (): void => {
    engineState.textContent = JSON.stringify(summarize(engine.state), null, 2);
  };

  /* ── event log ── */
  const logBox = section('EVENT LOG');
  const logCount = note(logBox);
  const logLines = doc.createElement('pre');
  logLines.className = 'devtools-log';
  logBox.appendChild(logLines);

  const renderLog = (): void => {
    const entries = log.entries();
    logCount.textContent = `${String(entries.length)} entries`;
    logLines.textContent = entries
      .slice(-VISIBLE_LOG_LINES)
      .map((entry) => {
        const at = new Date(entry.at).toISOString().slice(11, 23);
        const round = entry.roundId === undefined ? '' : ` ${entry.roundId.slice(-8)}`;
        return `${at} ${entry.type}${round}`;
      })
      .join('\n');
  };

  if (options.download !== undefined) {
    const download = options.download;
    button(logBox, 'EXPORT', () => {
      download('slot-event-log.json', log.export());
    });
  }
  button(logBox, 'CLEAR', () => {
    log.clear();
    renderLog();
  });

  /* ── live wiring ── */
  const unsubscribe = engine.on((event) => {
    log.record(event);
    renderLog();
    renderState();
  });

  renderState();
  renderLog();
  host.appendChild(root);

  return {
    element: root,
    log,
    destroy() {
      unsubscribe();
      root.remove();
    },
  };
}
