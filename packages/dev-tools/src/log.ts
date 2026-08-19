import type { RoundId } from '@slot/protocol';
import type { EngineEvent } from '@slot/engine';

/**
 * The event log — every engine event, timestamped and correlated on `roundId`.
 *
 * Correlation is the point. The engine's events name their round only where the round is the
 * subject (`SPIN_STARTED`, an error raised inside one); everything between — the reels targeting,
 * the wins presenting, the feature progressing — happens *inside* a round without saying which.
 * The log carries the current round across those entries, so an exported session reads as rounds
 * rather than as an undifferentiated stream, and a bug report can say "round X, entry 14" instead
 * of "somewhere in the middle".
 *
 * The clock is injected for the same reason it is everywhere else in this project: a log whose
 * timestamps a test cannot pin is a log whose format a test cannot assert.
 */

export interface LogEntry {
  /** Monotonic within a session, never reused — survives the capacity cap dropping older entries. */
  readonly seq: number;
  /** Epoch ms, from the injected clock. */
  readonly at: number;
  readonly type: EngineEvent['type'];
  /** The round this entry belongs to, carried across entries that do not name one. */
  readonly roundId?: RoundId;
  /** The event itself, whole — the export is for reading a session back, not summarising it. */
  readonly event: EngineEvent;
}

export interface EventLogOptions {
  /** Injected clock. Defaults to `Date.now` — this package is not one of the pure five. */
  now?: () => number;
  /** Oldest entries are dropped beyond this. The cap keeps a long session from eating the tab. */
  capacity?: number;
}

const DEFAULT_CAPACITY = 500;

export class EventLog {
  readonly #now: () => number;
  readonly #capacity: number;
  #entries: LogEntry[] = [];
  #seq = 0;
  /** The round currently open, as far as the event stream has said. */
  #currentRound: RoundId | undefined;

  constructor({ now = () => Date.now(), capacity = DEFAULT_CAPACITY }: EventLogOptions = {}) {
    this.#now = now;
    this.#capacity = capacity;
  }

  record(event: EngineEvent): LogEntry {
    // A new round announces itself before anything inside it is logged.
    if (event.type === 'SPIN_STARTED') this.#currentRound = event.roundId;

    const roundId =
      'roundId' in event
        ? event.roundId
        : ((event.type === 'ERROR_RAISED' ? event.error.roundId : undefined) ?? this.#currentRound);

    const entry: LogEntry = {
      seq: this.#seq++,
      at: this.#now(),
      type: event.type,
      ...(roundId === undefined ? {} : { roundId }),
      event,
    };

    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) {
      this.#entries.splice(0, this.#entries.length - this.#capacity);
    }

    // The settle is the round's last word; entries after it belong to no round until the next spin.
    if (event.type === 'ROUND_SETTLED') this.#currentRound = undefined;

    return entry;
  }

  entries(): readonly LogEntry[] {
    return this.#entries;
  }

  clear(): void {
    this.#entries = [];
  }

  /**
   * The whole log as JSON, newest last — the shape a bug report attaches.
   *
   * `droppedBeforeSeq` says honestly where the cap cut: an export whose first entry is seq 214
   * is a window into a session, not the session, and the reader should know which.
   */
  export(): string {
    const first = this.#entries[0];
    return JSON.stringify(
      {
        exportedAt: this.#now(),
        droppedBeforeSeq: first?.seq ?? 0,
        entries: this.#entries,
      },
      null,
      2,
    );
  }
}
