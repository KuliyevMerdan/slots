import { Container, Text, TextStyle } from 'pixi.js';
import type { Minor } from '@slot/protocol';
import { format } from '@slot/money';
import { UI_FONT, UI_PALETTE } from './theme.js';

/**
 * Balance and win — two numbers, both of them the server's.
 *
 * **The HUD never does arithmetic on money.** Every response carries the authoritative balance after
 * the operation it describes, so this class formats what it is given and nothing else. That is why
 * `settle` is an explicit call: the player sees the post-debit balance during the presentation and
 * the post-credit balance after it, both sent, neither derived.
 */

export interface ReadoutOptions {
  caption: string;
  currency: string;
  locale?: string;
  colour?: number;
  align?: 'left' | 'right';
}

export class Readout {
  readonly view = new Container();

  readonly #caption: Text;
  readonly #value: Text;
  readonly #currency: string;
  readonly #locale: string;

  constructor({
    caption,
    currency,
    locale = 'en',
    colour = UI_PALETTE.text,
    align = 'left',
  }: ReadoutOptions) {
    this.#currency = currency;
    this.#locale = locale;

    this.#caption = new Text({
      text: caption,
      style: new TextStyle({
        fontFamily: UI_FONT,
        fontSize: 12,
        fontWeight: '600',
        fill: UI_PALETTE.textMuted,
        letterSpacing: 2,
      }),
    });

    this.#value = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: UI_FONT,
        fontSize: 24,
        fontWeight: '700',
        fill: colour,
      }),
    });
    this.#value.position.y = 18;

    const anchor = align === 'right' ? 1 : 0;
    this.#caption.anchor.set(anchor, 0);
    this.#value.anchor.set(anchor, 0);

    this.view.addChild(this.#caption, this.#value);
  }

  set amount(amount: Minor) {
    const text = format(amount, { currency: this.#currency, locale: this.#locale });
    if (this.#value.text !== text) this.#value.text = text;
  }

  set visible(value: boolean) {
    this.view.visible = value;
  }
}

export interface HudOptions {
  currency: string;
  locale?: string;
}

/** Balance on the left, win on the right — the layout every player already knows how to read. */
export class Hud {
  readonly view = new Container();
  readonly balance: Readout;
  readonly win: Readout;

  constructor({ currency, locale = 'en' }: HudOptions) {
    this.balance = new Readout({ caption: 'BALANCE', currency, locale });
    this.win = new Readout({
      caption: 'WIN',
      currency,
      locale,
      colour: UI_PALETTE.win,
      align: 'right',
    });
    this.win.visible = false;

    this.view.addChild(this.balance.view, this.win.view);
  }

  /** Place the two readouts at the ends of a bar of the given width. */
  layout(width: number): void {
    this.balance.view.position.set(0, 0);
    this.win.view.position.set(width, 0);
  }
}
