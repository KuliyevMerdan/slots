import type { Minor, RoundId } from '@slot/protocol';
import type { MovementKind } from '../ledger/ledger.js';
import type { RgsMetrics } from './metrics.js';

/**
 * The domain's mouth — the events the HTTP layer cannot see, spoken at the site they happen.
 *
 * ADR-0005 swallows two failures by design: a rollback that cannot be delivered, and a ledger
 * write that fails after the wallet already moved. The *money* story is right — reconciliation
 * finds the drift — but until R6 the failure itself was silent, and ops heard the echo without
 * the bang. This port is the bang: the domain reports the event with the `roundId` and the
 * correlation id on it, and the composition decides what an event becomes — a pino line, a
 * metric, both. The domain stays free of any logging library, for the same reason it takes a
 * clock as an argument (ADR-0003: when a module needs something its boundary forbids, it takes
 * the shape as an argument).
 */

export type RgsEvent =
  | {
      /** A confirmed debit's round could not open, and the reversal failed too — the orphan. */
      readonly type: 'wallet.rollback_failed';
      readonly roundId: RoundId;
      readonly playerId: string;
      readonly amount: Minor;
      readonly correlationId?: string;
      readonly cause: unknown;
    }
  | {
      /** The reversal landed: the debit is undone and the ref is stakeable again (§4). */
      readonly type: 'wallet.rollback_delivered';
      readonly roundId: RoundId;
      readonly playerId: string;
      readonly amount: Minor;
      readonly correlationId?: string;
    }
  | {
      /** The wallet moved the money and the journal refused the entry — drift, until reconciled. */
      readonly type: 'ledger.record_failed';
      readonly kind: MovementKind;
      readonly ref: string;
      readonly roundId: RoundId;
      readonly playerId: string;
      readonly amount: Minor;
      readonly correlationId?: string;
      readonly cause: unknown;
    }
  | {
      /** A spin retry arrived for an open round with no recorded answer — §5, resumed. */
      readonly type: 'round.resumed_unresolved';
      readonly roundId: RoundId;
      readonly playerId: string;
      readonly correlationId?: string;
    };

export interface RgsObserver {
  event(event: RgsEvent): void;
}

/** The default: a domain nobody is listening to still plays correctly. */
export const noopObserver: RgsObserver = { event: () => undefined };

export const fanoutObserver = (...observers: readonly RgsObserver[]): RgsObserver => ({
  event: (event) => {
    for (const observer of observers) observer.event(event);
  },
});

/**
 * The slice of a pino logger the observer needs — structural, so the tests hand in a recorder
 * and the package never imports the logging library the composition happens to use.
 */
export interface ObserverLog {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/** Events as log lines: the two money failures are `error`, the recoveries tell their §5 story. */
export const pinoObserver = (log: ObserverLog): RgsObserver => ({
  event: (event) => {
    switch (event.type) {
      case 'wallet.rollback_failed':
        log.error(
          { ...event, event: event.type },
          'wallet rollback undeliverable — a standing stake with no round until the retry resumes it or reconciliation reports the orphan',
        );
        return;
      case 'ledger.record_failed':
        log.error(
          { ...event, event: event.type },
          'ledger entry lost after a confirmed wallet movement — the journal drifts until reconciliation finds it',
        );
        return;
      case 'wallet.rollback_delivered':
        log.warn(
          { ...event, event: event.type },
          'confirmed debit rolled back — the round could not open, the ref is stakeable again (§4)',
        );
        return;
      case 'round.resumed_unresolved':
        log.info(
          { ...event, event: event.type },
          'spin retry resumed a debited, unresolved round (§5)',
        );
        return;
    }
  },
});

/** Events as arithmetic: the failure counter is what an alert fires on. */
export const meteredObserver = (metrics: RgsMetrics): RgsObserver => ({
  event: (event) => {
    if (event.type === 'wallet.rollback_failed' || event.type === 'ledger.record_failed') {
      metrics.moneyWriteFailures.inc({ kind: event.type });
    }
  },
});
