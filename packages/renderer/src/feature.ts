import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { FeatureProgress, Minor } from '@slot/protocol';
import { format } from '@slot/money';
import { Timeline } from './timeline.js';
import { FONT_STACK, SYMBOL_SIZE, WIN_PALETTE } from './theme.js';

/**
 * The feature: its intro, its outro, the counter that runs through it, and the ambience that tells
 * the player they are somewhere else.
 *
 * **Everything here is presentation of arithmetic the server already did.** `FeatureProgress` arrives
 * with `total`, `remaining` and `cumulativeWin` already folded — retriggers included — so this class
 * displays numbers and never adds them up. That rule is what makes a retrigger a rendering detail
 * rather than a reconciliation problem: the client notices that `total` grew and says so.
 *
 * The intro and the outro are `Timeline`s, like the win presentation, so a skip completes them
 * exactly as finishing would (C4's contract, reused rather than re-implemented).
 */

const INTRO_MS = 1_600;
const OUTRO_MS = 1_800;
/** How long "+5 FREE SPINS" stays on screen. It rides a spin, so it cannot be a blocking step. */
const RETRIGGER_MS = 1_400;

export interface FeatureScreensOptions {
  width: number;
  height: number;
  currency: string;
  locale?: string;
}

export class FeatureScreens {
  readonly view = new Container();

  readonly #currency: string;
  readonly #locale: string;
  readonly #ambience: Graphics;
  readonly #counter: Container;
  readonly #counterText: Text;
  readonly #counterWin: Text;
  readonly #banner: Container;
  readonly #bannerTitle: Text;
  readonly #bannerDetail: Text;
  readonly #flash: Text;
  #flashMs = 0;

  constructor({ width, height, currency, locale = 'en' }: FeatureScreensOptions) {
    this.#currency = currency;
    this.#locale = locale;

    // Ambience: a warm border around the reel area. Cheap, and the player knows instantly that the
    // rules changed — which is the entire job of a feature background.
    this.#ambience = new Graphics()
      .roundRect(-10, -10, width + 20, height + 20, 18)
      .stroke({ width: 6, color: WIN_PALETTE.bannerEdge, alpha: 0.75 });
    this.#ambience.visible = false;

    this.#counterText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_STACK,
        fontSize: SYMBOL_SIZE * 0.2,
        fontWeight: '700',
        fill: WIN_PALETTE.bannerText,
        letterSpacing: 3,
      }),
    });
    this.#counterText.anchor.set(0.5, 0.5);

    this.#counterWin = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_STACK,
        fontSize: SYMBOL_SIZE * 0.18,
        fontWeight: '700',
        fill: WIN_PALETTE.amount,
      }),
    });
    this.#counterWin.anchor.set(0.5, 0.5);

    const counterPlate = new Graphics()
      .roundRect(-SYMBOL_SIZE * 1.5, -SYMBOL_SIZE * 0.3, SYMBOL_SIZE * 3, SYMBOL_SIZE * 0.6, 14)
      .fill({ color: WIN_PALETTE.bannerPlate, alpha: 0.92 })
      .stroke({ width: 2, color: WIN_PALETTE.bannerEdge, alpha: 0.7 });

    this.#counterText.position.set(0, -SYMBOL_SIZE * 0.1);
    this.#counterWin.position.set(0, SYMBOL_SIZE * 0.13);
    this.#counter = new Container();
    this.#counter.addChild(counterPlate, this.#counterText, this.#counterWin);
    this.#counter.position.set(width / 2, -SYMBOL_SIZE * 0.34);
    this.#counter.visible = false;

    this.#bannerTitle = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_STACK,
        fontSize: SYMBOL_SIZE * 0.34,
        fontWeight: '700',
        fill: WIN_PALETTE.bannerText,
        letterSpacing: 6,
      }),
    });
    this.#bannerTitle.anchor.set(0.5);

    this.#bannerDetail = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_STACK,
        fontSize: SYMBOL_SIZE * 0.44,
        fontWeight: '700',
        fill: WIN_PALETTE.amount,
      }),
    });
    this.#bannerDetail.anchor.set(0.5);

    const bannerPlate = new Graphics()
      .roundRect(-SYMBOL_SIZE * 2, -SYMBOL_SIZE * 0.8, SYMBOL_SIZE * 4, SYMBOL_SIZE * 1.6, 24)
      .fill({ color: WIN_PALETTE.bannerPlate, alpha: 0.95 })
      .stroke({ width: 3, color: WIN_PALETTE.bannerEdge, alpha: 0.9 });

    this.#bannerTitle.position.set(0, -SYMBOL_SIZE * 0.32);
    this.#bannerDetail.position.set(0, SYMBOL_SIZE * 0.22);
    this.#banner = new Container();
    this.#banner.addChild(bannerPlate, this.#bannerTitle, this.#bannerDetail);
    this.#banner.position.set(width / 2, height / 2);
    this.#banner.visible = false;

    this.#flash = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_STACK,
        fontSize: SYMBOL_SIZE * 0.28,
        fontWeight: '700',
        fill: WIN_PALETTE.bannerText,
        stroke: { color: WIN_PALETTE.lineShadow, width: 6 },
      }),
    });
    this.#flash.anchor.set(0.5);
    this.#flash.position.set(width / 2, height * 0.24);
    this.#flash.visible = false;

    this.view.addChild(this.#ambience, this.#counter, this.#flash, this.#banner);
  }

  get active(): boolean {
    return this.#ambience.visible;
  }

  /** The retrigger announcement currently on screen, if any. Readable so a test can assert it. */
  get announcement(): string | null {
    return this.#flash.visible ? this.#flash.text : null;
  }

  /** What the counter reads — the server's numbers, formatted. */
  get counter(): string {
    return this.#counterText.text;
  }

  /** The feature is on: warm border, counter visible. Also the state a mid-feature resume lands in. */
  setActive(on: boolean): void {
    this.#ambience.visible = on;
    this.#counter.visible = on;
    if (!on) {
      this.#flash.visible = false;
      this.#flashMs = 0;
    }
  }

  /**
   * The counter, straight from the server's numbers.
   *
   * `remaining` is `total - step`, computed by the server; the client displays it. A retrigger is
   * simply a `total` that grew, and the caller says so by passing `added`. `roundWin` is the round's
   * **payable** total — already capped by the server, so the counter cannot climb past what the
   * balance will actually receive.
   */
  progress(feature: FeatureProgress, roundWin: Minor): void {
    this.setActive(true);
    this.#counterText.text = `FREE SPIN ${String(Math.min(feature.step + 1, feature.total))} / ${String(feature.total)}`;
    this.#counterWin.text = this.#money(roundWin);
  }

  /** "+5 FREE SPINS", riding whatever else is on screen. */
  retrigger(added: number): void {
    this.#flash.text = `+${String(added)} FREE SPINS`;
    this.#flash.visible = true;
    this.#flashMs = RETRIGGER_MS;
  }

  /** Frame-driven, so the flash pauses with the tab and cannot outlive a round. */
  update(deltaMs: number): void {
    if (this.#flashMs <= 0) return;
    this.#flashMs -= deltaMs;
    if (this.#flashMs <= 0) this.#flash.visible = false;
  }

  intro(total: number, speed = 1): Timeline {
    return new Timeline([
      {
        durationMs: INTRO_MS * speed,
        onEnter: () => {
          this.setActive(true);
          this.#banner.visible = true;
          this.#bannerTitle.text = 'FREE SPINS';
          this.#bannerDetail.text = `${String(total)} SPINS`;
        },
        onLeave: () => {
          this.#banner.visible = false;
        },
      },
    ]);
  }

  /**
   * The outro counts the feature's total up, the same way a big win does — it is the number the
   * player has been watching accumulate, and showing it as a jump wastes the one moment that pays
   * the feature off.
   */
  outro(cumulativeWin: Minor, speed = 1): Timeline {
    return new Timeline([
      {
        durationMs: OUTRO_MS * speed,
        onEnter: () => {
          this.#banner.visible = true;
          this.#bannerTitle.text = 'FEATURE COMPLETE';
        },
        onProgress: (progress) => {
          const shown = Math.round(cumulativeWin * (1 - (1 - progress) ** 3)) as Minor;
          this.#bannerDetail.text = this.#money(shown);
        },
        onLeave: () => {
          this.#banner.visible = false;
          this.setActive(false);
        },
      },
    ]);
  }

  /** Everything off — the state every round outside a feature must start from. */
  clear(): void {
    this.#banner.visible = false;
    this.setActive(false);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  #money(amount: Minor): string {
    return format(amount, { currency: this.#currency, locale: this.#locale });
  }
}
