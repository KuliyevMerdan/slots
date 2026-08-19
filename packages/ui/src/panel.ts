import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { GameConfig, Minor } from '@slot/protocol';
import { BetSelector } from './bet-selector.js';
import { SpinButton, ToggleButton } from './button.js';
import { Hud } from './hud.js';
import { UI_FONT, UI_PALETTE } from './theme.js';

/**
 * The control bar: stake on the left, the button in the middle, the numbers above.
 *
 * It takes a **view model, not an engine**. `ui → protocol, money` is the whole dependency list, so
 * this package has never heard of a phase machine; the client maps engine state onto the handful of
 * facts below. That is what keeps the control panel renderable in isolation — and what stops the
 * interruption contract leaking into a button.
 */

export interface PanelView {
  /** SPIN · STOP · SKIP — the caller decides, because the caller knows the phase. */
  action: string;
  canPress: boolean;
  /** Stake changes are only legal between rounds. */
  canChangeStake: boolean;
  balance: Minor;
  stake: Minor;
  /** `undefined` hides the win readout entirely, which is the right look for a dead spin. */
  win: Minor | undefined;
  /** Shown under the button — free spins remaining, an error, a reconnect notice. */
  status: string;
  /** Turbo is a presentation preference, so the client owns it and the panel only reflects it. */
  turbo: boolean;
  /** A jurisdiction may forbid turbo outright — `jurisdictionRules.turboAllowed`, applied above. */
  canToggleTurbo: boolean;
  /** An autoplay run is active. The controller lives above the engine; this only reflects it. */
  autoplay: boolean;
  /** Off where the jurisdiction forbids it (`autoplayAllowed`), and while nothing could start one. */
  canToggleAutoplay: boolean;
  /** Spins left in the active run — rendered on the AUTO button itself. `undefined` when idle. */
  autoplayRemaining: number | undefined;
}

/** The panel's fixed captions, injectable so the wiring site can localise them (C6, en/ru). */
export interface PanelLabels {
  bet: string;
  balance: string;
  win: string;
  turbo: string;
  auto: string;
}

export const DEFAULT_PANEL_LABELS: PanelLabels = {
  bet: 'BET',
  balance: 'BALANCE',
  win: 'WIN',
  turbo: 'TURBO',
  auto: 'AUTO',
};

export interface ControlPanelOptions {
  config: GameConfig;
  currency: string;
  locale?: string;
  width?: number;
  labels?: PanelLabels;
  onPress: () => void;
  onStakeChange: (stake: Minor) => void;
  onToggleTurbo: (on: boolean) => void;
  onToggleAutoplay: (on: boolean) => void;
}

export class ControlPanel {
  readonly view = new Container();
  readonly button: SpinButton;
  readonly bet: BetSelector;
  readonly turbo: ToggleButton;
  readonly auto: ToggleButton;
  readonly hud: Hud;

  readonly #status: Text;
  readonly #width: number;
  readonly #plate: Graphics;
  readonly #labels: PanelLabels;

  constructor({
    config,
    currency,
    locale = 'en',
    width = 760,
    labels = DEFAULT_PANEL_LABELS,
    onPress,
    onStakeChange,
    onToggleTurbo,
    onToggleAutoplay,
  }: ControlPanelOptions) {
    this.#width = width;
    this.#labels = labels;

    this.hud = new Hud({
      currency,
      locale,
      balanceCaption: labels.balance,
      winCaption: labels.win,
    });
    this.hud.layout(width);

    this.bet = new BetSelector({
      levels: config.betLevels,
      currency,
      locale,
      caption: labels.bet,
      onChange: onStakeChange,
    });
    this.button = new SpinButton({ onPress });
    this.turbo = new ToggleButton({ label: labels.turbo, onToggle: onToggleTurbo });
    this.auto = new ToggleButton({ label: labels.auto, onToggle: onToggleAutoplay });

    this.#status = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: UI_FONT,
        fontSize: 13,
        fontWeight: '600',
        fill: UI_PALETTE.textMuted,
        letterSpacing: 1,
      }),
    });
    this.#status.anchor.set(0.5, 0);

    const barTop = 62;
    const barHeight = 96;
    this.#plate = new Graphics()
      .roundRect(0, barTop, width, barHeight, 16)
      .fill({ color: UI_PALETTE.panel, alpha: 0.72 })
      .stroke({ width: 2, color: UI_PALETTE.panelEdge, alpha: 0.7 });

    this.bet.view.position.set(24, barTop + (barHeight - this.bet.height) / 2);
    this.button.view.position.set(width / 2, barTop + barHeight / 2);
    this.turbo.view.position.set(
      width - 24 - this.turbo.width,
      barTop + (barHeight - this.turbo.height) / 2,
    );
    this.auto.view.position.set(
      width - 24 - this.turbo.width - 12 - this.auto.width,
      barTop + (barHeight - this.auto.height) / 2,
    );
    this.#status.position.set(width / 2, barTop + barHeight + 10);

    this.view.addChild(
      this.hud.view,
      this.#plate,
      this.bet.view,
      this.button.view,
      this.turbo.view,
      this.auto.view,
      this.#status,
    );
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return 190;
  }

  /** One call per engine event. Every field is a fact the engine already published. */
  render(model: PanelView): void {
    this.button.label = model.action;
    this.button.enabled = model.canPress;
    this.bet.enabled = model.canChangeStake;
    this.bet.stake = model.stake;
    this.turbo.on = model.turbo;
    this.turbo.enabled = model.canToggleTurbo;
    this.auto.on = model.autoplay;
    this.auto.enabled = model.canToggleAutoplay;
    this.auto.label =
      model.autoplayRemaining === undefined
        ? this.#labels.auto
        : `${this.#labels.auto} ${String(model.autoplayRemaining)}`;
    this.hud.balance.amount = model.balance;

    if (model.win === undefined) {
      this.hud.win.visible = false;
    } else {
      this.hud.win.visible = true;
      this.hud.win.amount = model.win;
    }

    if (this.#status.text !== model.status) this.#status.text = model.status;
  }
}
