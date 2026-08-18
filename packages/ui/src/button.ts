import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { UI_FONT, UI_PALETTE } from './theme.js';

/**
 * The spin button — one button, whose meaning depends on the phase.
 *
 * That is not a shortcut, it is the interruption contract: the engine has exactly one player input
 * (`PRESS`), and what it does — spin, slam the reels, skip a presentation — is the engine's decision,
 * not this button's. So this class has no idea what a spin is. It reports a press and renders a
 * label it was given.
 */

export interface SpinButtonOptions {
  radius?: number;
  onPress: () => void;
}

export class SpinButton {
  readonly view = new Container();

  readonly #face = new Graphics();
  readonly #label: Text;
  readonly #radius: number;
  #enabled = true;
  #pressed = false;

  constructor({ radius = 46, onPress }: SpinButtonOptions) {
    this.#radius = radius;
    this.#label = new Text({
      text: 'SPIN',
      style: new TextStyle({
        fontFamily: UI_FONT,
        fontSize: radius * 0.42,
        fontWeight: '700',
        fill: 0x0b1020,
        letterSpacing: 1.5,
      }),
    });
    this.#label.anchor.set(0.5);

    this.view.addChild(this.#face, this.#label);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.on('pointerdown', () => {
      this.#pressed = true;
      this.#draw();
    });
    this.view.on('pointerupoutside', () => {
      this.#pressed = false;
      this.#draw();
    });
    this.view.on('pointerup', () => {
      this.#pressed = false;
      this.#draw();
      if (this.#enabled) onPress();
    });

    this.#draw();
  }

  /** The label is the phase made legible: SPIN · STOP · SKIP. The caller decides which. */
  set label(text: string) {
    if (this.#label.text !== text) this.#label.text = text;
  }

  set enabled(value: boolean) {
    if (this.#enabled === value) return;
    this.#enabled = value;
    this.view.cursor = value ? 'pointer' : 'default';
    this.#draw();
  }

  get radius(): number {
    return this.#radius;
  }

  #draw(): void {
    const scale = this.#pressed && this.#enabled ? 0.96 : 1;
    const fill = !this.#enabled
      ? UI_PALETTE.disabled
      : this.#pressed
        ? UI_PALETTE.accentPressed
        : UI_PALETTE.accent;

    this.#face
      .clear()
      .circle(0, 0, this.#radius * scale)
      .fill({ color: fill })
      .stroke({ width: 3, color: 0xffffff, alpha: this.#enabled ? 0.22 : 0.08 });

    this.#label.alpha = this.#enabled ? 1 : 0.45;
    this.#label.scale.set(scale);
  }
}
