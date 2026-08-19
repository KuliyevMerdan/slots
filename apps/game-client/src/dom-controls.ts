import type { PanelView } from '@slot/ui';
import type { Strings } from './i18n.js';

/**
 * The keyboard's control panel — real `<button>`s, driven by the same `PanelView` the Pixi panel
 * renders.
 *
 * A canvas is a rectangle: the sprite the mouse presses does not exist to the keyboard or the
 * accessibility tree. This layer is the same controls again as DOM — focus order, `:focus-visible`,
 * Enter and Space all arrive for free — and it renders from the same view model, so what the
 * keyboard can do and what the pointer can do cannot disagree. Visually the buttons are transparent
 * until focused (the shell's CSS), because the Pixi panel *is* the visual; this is its shadow in
 * the accessibility tree.
 *
 * Everything DOM arrives injected and structural, which is why this file tests headless in Node.
 */

export interface ControlElement {
  textContent: string | null;
  className: string;
  disabled?: boolean;
  setAttribute(name: string, value: string): void;
  /** `unknown` so the real DOM's generic `appendChild` satisfies this structurally. */
  appendChild(child: unknown): unknown;
  addEventListener(type: string, listener: () => void): void;
  remove(): void;
}

export interface ControlDocument {
  createElement(tag: string): ControlElement;
}

export interface DomControlHandlers {
  onPress(): void;
  onBetDown(): void;
  onBetUp(): void;
  onToggleTurbo(): void;
  onToggleAutoplay(): void;
}

export interface DomControlsOptions {
  doc: ControlDocument;
  /** Where the group is appended — the game root, so the overlay layers with everything else. */
  host: { appendChild(child: unknown): unknown };
  strings: Strings;
  handlers: DomControlHandlers;
}

export interface DomControls {
  /** One call per engine event, beside `panel.render` — the same view, twice rendered. */
  render(view: PanelView): void;
  destroy(): void;
}

export function createDomControls({
  doc,
  host,
  strings,
  handlers,
}: DomControlsOptions): DomControls {
  const group = doc.createElement('div');
  group.className = 'kbd-controls';
  group.setAttribute('role', 'group');

  const button = (label: string, onActivate: () => void): ControlElement => {
    const element = doc.createElement('button');
    element.textContent = label;
    element.setAttribute('type', 'button');
    element.addEventListener('click', onActivate);
    group.appendChild(element);
    return element;
  };

  const betDown = button(`${strings.panel.bet} −`, handlers.onBetDown);
  const spin = button(strings.actionSpin, handlers.onPress);
  const betUp = button(`${strings.panel.bet} +`, handlers.onBetUp);
  const turbo = button(strings.panel.turbo, handlers.onToggleTurbo);
  const auto = button(strings.panel.auto, handlers.onToggleAutoplay);

  host.appendChild(group);

  return {
    render(view) {
      spin.textContent = view.action;
      spin.disabled = !view.canPress;
      betDown.disabled = !view.canChangeStake;
      betUp.disabled = !view.canChangeStake;
      turbo.disabled = !view.canToggleTurbo;
      turbo.setAttribute('aria-pressed', String(view.turbo));
      auto.disabled = !view.canToggleAutoplay;
      auto.setAttribute('aria-pressed', String(view.autoplay));
      auto.textContent =
        view.autoplayRemaining === undefined
          ? strings.panel.auto
          : `${strings.panel.auto} ${String(view.autoplayRemaining)}`;
    },
    destroy() {
      group.remove();
    },
  };
}
