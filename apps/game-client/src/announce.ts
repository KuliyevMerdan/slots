import { format } from '@slot/money';
import type { PanelView } from '@slot/ui';

/**
 * The screen-reader story for a game made of pixels.
 *
 * A canvas is a rectangle with nothing in the accessibility tree: the balance, the stake, the win
 * and what the machine is doing are all *drawn*, so to a screen reader the page is empty. The HTML
 * shell carries one polite live region and this turns the panel's view model into the sentence that
 * goes in it.
 *
 * Two rules keep it usable rather than merely present.
 *
 * **It announces state, not events.** The region is `aria-atomic`, so each update replaces the last
 * — a reader hears "balance €9.80, stake €1, spinning" and later "balance €9.80, win €4.50, ready",
 * rather than a running commentary it cannot get ahead of.
 *
 * **It only speaks when something changed.** A slot renders on every frame; writing the same
 * sentence back into a live region re-announces it in some screen readers, which is how an
 * accessible game becomes an unusable one. The last sentence is remembered and identical updates
 * are dropped.
 */

/** What the machine is doing, in words a player can act on rather than a phase name. */
const ACTIVITY: Record<PanelView['action'], string> = {
  SPIN: 'ready to spin',
  STOP: 'spinning',
  SKIP: 'showing the win',
  RETRY: 'connection problem, press to retry',
  OK: 'press to continue',
  FROZEN: 'the game has stopped and needs a reload',
};

export interface AnnouncerOptions {
  currency: string;
  locale?: string;
  /** The live region. Absent in a test, or if the shell was cut down. */
  region: { textContent: string | null } | null;
}

export interface Announcer {
  /** Idempotent: an unchanged view is not re-announced. Returns what was said, or `null`. */
  announce(view: PanelView): string | null;
}

export function createAnnouncer({ currency, locale, region }: AnnouncerOptions): Announcer {
  const money = (amount: number): string =>
    format(amount as never, { currency, ...(locale === undefined ? {} : { locale }) });
  let last: string | null = null;

  return {
    announce(view) {
      const parts = [
        `balance ${money(view.balance)}`,
        `stake ${money(view.stake)}`,
        ...(view.win === undefined || view.win === 0 ? [] : [`win ${money(view.win)}`]),
        // The status line is the server's own words when something went wrong, so it is worth more
        // than the generic activity — but the activity still says what to do about it.
        ...(view.status === '' ? [] : [view.status.toLowerCase()]),
        ACTIVITY[view.action],
      ];

      const sentence = parts.join(', ');
      if (sentence === last) return null;

      last = sentence;
      if (region !== null) region.textContent = sentence;
      return sentence;
    },
  };
}
