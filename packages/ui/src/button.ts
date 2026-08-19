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

/**
 * A small on/off pill — turbo today, sound and autoplay when they land.
 *
 * It renders the state it is told and reports a tap. Whether turbo is *allowed* is not its business:
 * a jurisdiction that forbids it (the UK preset, C6) disables the control from above, exactly as the
 * bet selector is disabled mid-round.
 */
export interface ToggleButtonOptions {
  label: string;
  onToggle: (on: boolean) => void;
  width?: number;
  height?: number;
}

export class ToggleButton {
  readonly view = new Container();

  readonly #face = new Graphics();
  readonly #label: Text;
  readonly #width: number;
  readonly #height: number;
  #on = false;
  #enabled = true;

  constructor({ label, onToggle, width = 92, height = 40 }: ToggleButtonOptions) {
    this.#width = width;
    this.#height = height;

    this.#label = new Text({
      text: label,
      style: new TextStyle({
        fontFamily: UI_FONT,
        fontSize: 13,
        fontWeight: '700',
        fill: UI_PALETTE.text,
        letterSpacing: 2,
      }),
    });
    this.#label.anchor.set(0.5);
    this.#label.position.set(width / 2, height / 2);

    this.view.addChild(this.#face, this.#label);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.on('pointertap', () => {
      if (!this.#enabled) return;
      this.#on = !this.#on;
      this.#draw();
      onToggle(this.#on);
    });

    this.#draw();
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  get on(): boolean {
    return this.#on;
  }

  /** Adopt state from above without reporting it back — the caller owns the truth. */
  set on(value: boolean) {
    if (this.#on === value) return;
    this.#on = value;
    this.#draw();
  }

  /** Mutable for the same reason the spin button's is: AUTO shows how many spins remain. */
  set label(text: string) {
    if (this.#label.text !== text) this.#label.text = text;
  }

  set enabled(value: boolean) {
    if (this.#enabled === value) return;
    this.#enabled = value;
    this.view.cursor = value ? 'pointer' : 'default';
    this.#draw();
  }

  #draw(): void {
    this.#face
      .clear()
      .roundRect(0, 0, this.#width, this.#height, this.#height / 2)
      .fill({
        color: this.#on ? UI_PALETTE.accent : UI_PALETTE.panelEdge,
        alpha: this.#on ? 0.9 : 0.5,
      })
      .stroke({ width: 2, color: this.#on ? UI_PALETTE.accent : UI_PALETTE.panelEdge, alpha: 0.8 });

    this.#label.style.fill = this.#on ? 0x0b1020 : UI_PALETTE.textMuted;
    this.view.alpha = this.#enabled ? 1 : 0.5;
  }
}
