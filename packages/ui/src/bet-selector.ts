import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Minor } from '@slot/protocol';
import { format } from '@slot/money';
import { UI_FONT, UI_PALETTE } from './theme.js';

/**
 * The bet selector — steps through `GameConfig.betLevels`, and never invents a stake.
 *
 * The levels are the server's: every one of them is a whole multiple of the payline count, which is
 * what makes the line bet exact arithmetic rather than a rounding decision. A free-text field would
 * be a way to send a stake the server will refuse.
 */

export interface BetSelectorOptions {
  levels: readonly Minor[];
  currency: string;
  locale?: string;
  onChange: (stake: Minor) => void;
  width?: number;
  height?: number;
  /** Injectable so the wiring site can localise it (C6, en/ru). */
  caption?: string;
}

export class BetSelector {
  readonly view = new Container();

  readonly #levels: readonly Minor[];
  readonly #currency: string;
  readonly #locale: string;
  readonly #onChange: (stake: Minor) => void;
  readonly #value: Text;
  readonly #caption: Text;
  readonly #down: Container;
  readonly #up: Container;
  readonly #width: number;
  readonly #height: number;
  #index = 0;
  #enabled = true;

  constructor({
    levels,
    currency,
    locale = 'en',
    onChange,
    width = 190,
    height = 62,
    caption = 'BET',
  }: BetSelectorOptions) {
    this.#levels = levels;
    this.#currency = currency;
    this.#locale = locale;
    this.#onChange = onChange;
    this.#width = width;
    this.#height = height;

    const plate = new Graphics()
      .roundRect(0, 0, width, height, 12)
      .fill({ color: UI_PALETTE.panel })
      .stroke({ width: 2, color: UI_PALETTE.panelEdge });

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
    this.#caption.position.set(width / 2, 10);
    this.#caption.anchor.set(0.5, 0);

    this.#value = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: UI_FONT,
        fontSize: 20,
        fontWeight: '700',
        fill: UI_PALETTE.text,
      }),
    });
    this.#value.anchor.set(0.5, 0);
    this.#value.position.set(width / 2, height * 0.44);

    this.#down = this.#step('−', 0, -1);
    this.#up = this.#step('+', width - height, 1);

    this.view.addChild(plate, this.#caption, this.#value, this.#down, this.#up);
    this.#render();
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  /** Adopt the stake the engine reports. The HUD shows server numbers; it does not choose them. */
  set stake(stake: Minor) {
    const index = this.#levels.indexOf(stake);
    if (index === -1 || index === this.#index) return;
    this.#index = index;
    this.#render();
  }

  set enabled(value: boolean) {
    if (this.#enabled === value) return;
    this.#enabled = value;
    this.#render();
  }

  #step(glyph: string, x: number, direction: 1 | -1): Container {
    const button = new Container();
    const size = this.#height;
    const face = new Graphics()
      .roundRect(2, 2, size - 4, size - 4, 10)
      .fill({ color: UI_PALETTE.panelEdge, alpha: 0.55 });

    const label = new Text({
      text: glyph,
      style: new TextStyle({
        fontFamily: UI_FONT,
        fontSize: 24,
        fontWeight: '700',
        fill: UI_PALETTE.text,
      }),
    });
    label.anchor.set(0.5);
    label.position.set(size / 2, size / 2);

    button.addChild(face, label);
    button.position.x = x;
    button.eventMode = 'static';
    button.cursor = 'pointer';
    button.on('pointertap', () => {
      this.#move(direction);
    });
    return button;
  }

  #move(direction: 1 | -1): void {
    if (!this.#enabled) return;
    const next = Math.min(Math.max(this.#index + direction, 0), this.#levels.length - 1);
    if (next === this.#index) return;

    this.#index = next;
    this.#render();
    const stake = this.#levels[next];
    if (stake !== undefined) this.#onChange(stake);
  }

  #render(): void {
    const stake = this.#levels[this.#index];
    this.#value.text =
      stake === undefined ? '—' : format(stake, { currency: this.#currency, locale: this.#locale });

    const atFloor = this.#index === 0;
    const atCeiling = this.#index === this.#levels.length - 1;
    this.#down.alpha = this.#enabled && !atFloor ? 1 : 0.3;
    this.#up.alpha = this.#enabled && !atCeiling ? 1 : 0.3;
    this.view.alpha = this.#enabled ? 1 : 0.65;
  }
}
