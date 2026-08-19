import type { HistoryRes } from '@slot/protocol';
import { format } from '@slot/money';
import type { Strings } from './i18n.js';

/**
 * The round-history panel — the player-visible half of the wire's `history` call.
 *
 * A history is a document, so it is DOM: scroll, focus order and a screen-reader story arrive for
 * free, and nothing here spends from the ticker budget. It lists the server's response verbatim —
 * every number was settled money by the time the server stored it — and states `retention`
 * honestly, because "your last N rounds" is only true for the N this server actually keeps
 * (the regulated-market record is months of rows behind a real RGS; this is not that, and says so).
 *
 * Everything DOM arrives injected and structural (the dom-controls pattern), so the panel tests
 * headless in Node. The fetch is a port for the same reason the engine's transport is: this module
 * renders a response, it does not know where responses come from.
 */

export interface HistoryElement {
  textContent: string | null;
  className: string;
  hidden?: boolean;
  setAttribute(name: string, value: string): void;
  appendChild(child: unknown): unknown;
  /** Clears and refills — the real DOM's own `replaceChildren`. */
  replaceChildren(...children: unknown[]): void;
  remove(): void;
}

export interface HistoryDocument {
  createElement(tag: string): HistoryElement;
}

export interface HistoryPanelOptions {
  doc: HistoryDocument;
  host: { appendChild(child: unknown): unknown };
  /** The session's currency — every amount below is formatted with it, like the HUD's. */
  currency: string;
  strings: Strings;
  fetchHistory(): Promise<HistoryRes>;
}

export interface HistoryPanel {
  /** The panel's root, for the drawer to show and hide. */
  readonly element: HistoryElement;
  /** Refetch and re-render — the drawer calls this on every open, so the list is never stale. */
  refresh(): Promise<void>;
  destroy(): void;
}

export function createHistoryPanel({
  doc,
  host,
  currency,
  strings,
  fetchHistory,
}: HistoryPanelOptions): HistoryPanel {
  const root = doc.createElement('div');
  root.className = 'history';

  const status = doc.createElement('p');
  status.className = 'history-status';
  root.appendChild(status);

  const list = doc.createElement('div');
  list.className = 'history-list';
  root.appendChild(list);

  const retention = doc.createElement('p');
  retention.className = 'history-retention';
  root.appendChild(retention);

  const timeOf = new Intl.DateTimeFormat(strings.locale, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const money = (amount: HistoryRes['rounds'][number]['stake']): string =>
    format(amount, { currency, locale: strings.locale });

  const render = (response: HistoryRes): void => {
    status.textContent = response.rounds.length === 0 ? strings.historyEmpty : '';

    list.replaceChildren();
    for (const round of response.rounds) {
      const row = doc.createElement('div');
      row.className = 'history-row';

      const when = doc.createElement('span');
      when.className = 'history-when';
      when.textContent = timeOf.format(new Date(round.at));
      row.appendChild(when);

      const stake = doc.createElement('span');
      stake.className = 'history-stake';
      stake.textContent = money(round.stake);
      row.appendChild(stake);

      const win = doc.createElement('span');
      win.className = round.totalWin > 0 ? 'history-win history-win-paid' : 'history-win';
      win.textContent =
        money(round.totalWin) + (round.capped ? ` ${strings.historyCappedMark}` : '');
      row.appendChild(win);

      if (round.freeSpins > 0) {
        const feature = doc.createElement('span');
        feature.className = 'history-feature';
        feature.textContent = strings.historyFreeSpins(round.freeSpins);
        row.appendChild(feature);
      }

      list.appendChild(row);
    }

    retention.textContent = strings.historyRetention(response.retention);
  };

  host.appendChild(root);

  return {
    element: root,
    async refresh() {
      try {
        render(await fetchHistory());
      } catch {
        // The history is a convenience, never load-bearing: a failed fetch is a sentence in the
        // panel, not an error screen over a game that is working.
        status.textContent = strings.historyError;
        list.replaceChildren();
        retention.textContent = '';
      }
    },
    destroy() {
      root.remove();
    },
  };
}
