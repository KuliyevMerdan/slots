import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Minor, Win } from '@slot/protocol';
import { format } from '@slot/money';
import { Timeline } from './timeline.js';
import type { TimelineStep } from './timeline.js';
import { tierFor } from './tiers.js';
import type { WinTierId } from './tiers.js';
import type { ReelSet } from './reels.js';
import { FONT_STACK, SYMBOL_SIZE, WIN_PALETTE } from './theme.js';

/**
 * The win presentation: paylines, symbol emphasis, and a counter that rolls.
 *
 * **Sequenced from the server's `wins[]` and nothing else.** The client does not work out what won —
 * it lights what it was told won, in the order it was told, and the dev build re-evaluates the grid
 * separately to catch a server that disagrees with itself (ADR-0001).
 *
 * The whole sequence is a `Timeline`, which means the skip is not a special case: `complete()` runs
 * every remaining step to its end, so the counter lands on the final number and the highlights clear
 * themselves exactly as they would have. That is the renderer's half of the interruption contract —
 * the engine already decided the skip was legal.
 */

/** An untiered win still gets a beat: long enough to read, short enough not to be a wait. */
const BASE_COUNT_UP_MS = 650;
const PER_WIN_MS = 700;
/**
 * The whole per-win cycle fits in this, however many wins there are.
 *
 * A max-win screen can pay twenty lines at once, and twenty × 700 ms is a twelve-second slideshow
 * the player will mash through — which is exactly the behaviour to design out rather than to
 * survive. Many wins become a rhythm; a few still get their beat each.
 */
const WIN_CYCLE_BUDGET_MS = 2_800;
/** How many times a highlight swells during one step. */
const PULSE_CYCLES = 2;

export interface WinPresentationOptions {
  reels: ReelSet;
  /** From `GameConfig`: row per reel, one entry per line. The geometry of a payline, as data. */
  paylines: readonly (readonly number[])[];
  currency: string;
  locale?: string;
  /**
   * The rolling amount, for whoever shows it — the client feeds it to the HUD. Called with the
   * **final** total before the presentation ends, always, including when it is skipped.
   */
  onAmount?: (amount: Minor) => void;
  labels?: WinLabels;
}

/** The banner's one sentence, injectable for the same reason the feature's are (C6, en/ru). */
export interface WinLabels {
  tier(id: WinTierId): string;
}

export const DEFAULT_WIN_LABELS: WinLabels = {
  tier: (id) => `${id} WIN`,
};

export interface PresentationInput {
  wins: readonly Win[];
  totalWin: Minor;
  stake: Minor;
  /** Turbo and the like: every duration is multiplied by this. */
  speed?: number;
}

const pulseAt = (progress: number): number => Math.abs(Math.sin(progress * Math.PI * PULSE_CYCLES));

/** Ease-out so the counter sprints and then lands, rather than crawling to its number. */
const countUpEase = (progress: number): number => 1 - (1 - progress) ** 3;

export class WinPresentation {
  readonly view = new Container();

  readonly #reels: ReelSet;
  readonly #paylines: readonly (readonly number[])[];
  readonly #currency: string;
  readonly #locale: string;
  readonly #labels: WinLabels;
  readonly #onAmount: ((amount: Minor) => void) | undefined;

  readonly #lines = new Graphics();
  readonly #banner: Container;
  readonly #bannerTier: Text;
  readonly #bannerAmount: Text;
  readonly #lineAmount: Text;

  constructor({
    reels,
    paylines,
    currency,
    locale = 'en',
    onAmount,
    labels = DEFAULT_WIN_LABELS,
  }: WinPresentationOptions) {
    this.#reels = reels;
    this.#paylines = paylines;
    this.#currency = currency;
    this.#locale = locale;
    this.#labels = labels;
    this.#onAmount = onAmount;

    this.#lineAmount = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_STACK,
        fontSize: SYMBOL_SIZE * 0.24,
        fontWeight: '700',
        fill: WIN_PALETTE.amount,
        stroke: { color: WIN_PALETTE.lineShadow, width: 5 },
      }),
    });
    this.#lineAmount.anchor.set(0.5);
    this.#lineAmount.visible = false;

    this.#bannerTier = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_STACK,
        fontSize: SYMBOL_SIZE * 0.3,
        fontWeight: '700',
        fill: WIN_PALETTE.bannerText,
        letterSpacing: 6,
      }),
    });
    this.#bannerTier.anchor.set(0.5);

    this.#bannerAmount = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_STACK,
        fontSize: SYMBOL_SIZE * 0.46,
        fontWeight: '700',
        fill: WIN_PALETTE.amount,
      }),
    });
    this.#bannerAmount.anchor.set(0.5);

    const plate = new Graphics()
      .roundRect(-SYMBOL_SIZE * 1.9, -SYMBOL_SIZE * 0.72, SYMBOL_SIZE * 3.8, SYMBOL_SIZE * 1.44, 24)
      .fill({ color: WIN_PALETTE.bannerPlate, alpha: 0.94 })
      .stroke({ width: 3, color: WIN_PALETTE.bannerEdge, alpha: 0.85 });

    this.#bannerTier.position.set(0, -SYMBOL_SIZE * 0.3);
    this.#bannerAmount.position.set(0, SYMBOL_SIZE * 0.18);

    this.#banner = new Container();
    this.#banner.addChild(plate, this.#bannerTier, this.#bannerAmount);
    this.#banner.visible = false;
    this.#banner.position.set(reels.width / 2, reels.height / 2);

    this.view.addChild(this.#lines, this.#lineAmount, this.#banner);
  }

  /**
   * Build the sequence for one spin's wins.
   *
   * Returns a finished timeline when there is nothing to show, so the caller does not need a special
   * case for a dead spin — and the engine's `PRESENTATION_COMPLETE` still arrives on the next frame.
   */
  build({ wins, totalWin, stake, speed = 1 }: PresentationInput): Timeline {
    if (wins.length === 0 || totalWin <= 0) {
      this.clear();
      return new Timeline([]);
    }

    const tier = tierFor(totalWin, stake);
    const everyPosition = wins.flatMap((win) => win.positions);
    const steps: TimelineStep[] = [];

    // 1 — the total, counted up over every winning cell at once.
    steps.push({
      durationMs: (tier?.countUpMs ?? BASE_COUNT_UP_MS) * speed,
      onEnter: () => {
        this.#lines.clear();
        this.#lineAmount.visible = false;
        this.#reels.setEmphasis(everyPosition);
        if (tier !== null) {
          this.#banner.visible = true;
          this.#bannerTier.text = this.#labels.tier(tier.id);
        }
      },
      onProgress: (progress) => {
        const shown = Math.round(totalWin * countUpEase(progress)) as Minor;
        this.#bannerAmount.text = this.#money(shown);
        this.#reels.pulse(pulseAt(progress));
        this.#onAmount?.(shown);
      },
    });

    // 2 — a tiered win holds on its number. An ordinary one does not earn the pause.
    if (tier !== null) {
      steps.push({
        durationMs: tier.holdMs * speed,
        onProgress: (progress) => {
          this.#reels.pulse(pulseAt(progress));
        },
      });
    }

    // 3 — then each win in turn, in the order the server sent them.
    if (wins.length > 1) {
      const perWinMs = Math.min(PER_WIN_MS, WIN_CYCLE_BUDGET_MS / wins.length);
      for (const win of wins) {
        steps.push({
          durationMs: perWinMs * speed,
          onEnter: () => {
            this.#banner.visible = false;
            this.#reels.setEmphasis(win.positions);
            this.#drawWin(win);
          },
          onProgress: (progress) => {
            this.#reels.pulse(pulseAt(progress));
          },
        });
      }
    }

    // 4 — and the screen is handed back exactly as it was found. Duration zero: this step exists to
    // be *left*, which is what makes a skip safe.
    steps.push({
      durationMs: 0,
      onLeave: () => {
        this.clear();
        this.#onAmount?.(totalWin);
      },
    });

    return new Timeline(steps);
  }

  /** Everything off: no line, no label, no banner, no dimmed reels. */
  clear(): void {
    this.#lines.clear();
    this.#lineAmount.visible = false;
    this.#banner.visible = false;
    this.#reels.setEmphasis(null);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  #money(amount: Minor): string {
    return format(amount, { currency: this.#currency, locale: this.#locale });
  }

  /**
   * Draw one win: a line through the payline's cells, a ring around each paying position, and the
   * amount beside the last one.
   *
   * A scatter win has no line — it pays anywhere — so it gets rings only, which is also how a player
   * reads the difference at a glance.
   */
  #drawWin(win: Win): void {
    this.#lines.clear();

    const payline = win.line === undefined ? undefined : this.#paylines[win.line];
    if (payline !== undefined) {
      payline.forEach((row, reel) => {
        const { x, y } = this.#reels.centreOf(reel, row);
        if (reel === 0) this.#lines.moveTo(x, y);
        else this.#lines.lineTo(x, y);
      });
      this.#lines.stroke({ width: 6, color: WIN_PALETTE.lineShadow, alpha: 0.55 });

      payline.forEach((row, reel) => {
        const { x, y } = this.#reels.centreOf(reel, row);
        if (reel === 0) this.#lines.moveTo(x, y);
        else this.#lines.lineTo(x, y);
      });
      this.#lines.stroke({ width: 3, color: WIN_PALETTE.line });
    }

    for (const [reel, row] of win.positions) {
      const { x, y } = this.#reels.centreOf(reel, row);
      this.#lines
        .roundRect(
          x - SYMBOL_SIZE / 2,
          y - SYMBOL_SIZE / 2,
          SYMBOL_SIZE,
          SYMBOL_SIZE,
          SYMBOL_SIZE * 0.16,
        )
        .stroke({ width: 4, color: WIN_PALETTE.ring, alpha: 0.9 });
    }

    const last = win.positions[win.positions.length - 1];
    if (last !== undefined) {
      const { x, y } = this.#reels.centreOf(last[0], last[1]);
      this.#lineAmount.text = this.#money(win.amount);
      this.#lineAmount.position.set(x, y - SYMBOL_SIZE * 0.62);
      this.#lineAmount.visible = true;
    }
  }
}
