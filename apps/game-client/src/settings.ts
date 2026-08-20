import type { ProtectionSettings } from './persistence.js';
import type { Strings } from './i18n.js';

/**
 * The player-protection picker (C8) — the settings surface `@slot/compliance` was always tested
 * for and never had. It edits two families of rules: the autoplay plan's stop conditions (spins,
 * feature, single-win and run-loss stops) and the session limits (time, net loss). Everything
 * here *stops play*; nothing here changes the game — and the panel says so in its first sentence,
 * because a protection surface that reads like a bonus picker is worse than none.
 *
 * Deliberately player-facing, never dev-gated, and a document rather than canvas — the same
 * argument as the history panel it shares the drawer with. Everything DOM arrives injected and
 * structural (the dom-controls pattern), so the panel tests headless in Node. Money appears only
 * as pre-formatted labels the wiring supplies (`@slot/money` at the edge, as always); the panel
 * itself never formats or computes an amount.
 */

export interface SettingsElement {
  textContent: string | null;
  className: string;
  hidden?: boolean;
  value?: string;
  checked?: boolean;
  appendChild(child: unknown): unknown;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
  remove(): void;
}

export interface SettingsDocument {
  createElement(tag: string): SettingsElement;
}

/** One choice in a select: the encoded value and the sentence the player reads. */
interface Choice {
  value: string;
  label: string;
}

export interface SettingsPanelOptions {
  doc: SettingsDocument;
  host: { appendChild(child: unknown): unknown };
  strings: Strings;
  /** The settings as they stand — the panel renders them selected. */
  current: ProtectionSettings;
  /** The offered ladders, decided by the wiring: spins per run, stake multiples, minutes. */
  spinsChoices: readonly number[];
  multipleChoices: readonly number[];
  minutesChoices: readonly number[];
  /** Session-loss choices arrive with their money already formatted — the panel shows, never sums. */
  lossChoices: ReadonlyArray<{ minor: number; label: string }>;
  onChange(next: ProtectionSettings): void;
}

export interface SettingsPanel {
  /** The panel's root, for the drawer to show and hide. */
  readonly element: SettingsElement;
  destroy(): void;
}

export function createSettingsPanel({
  doc,
  host,
  strings,
  current,
  spinsChoices,
  multipleChoices,
  minutesChoices,
  lossChoices,
  onChange,
}: SettingsPanelOptions): SettingsPanel {
  // The panel's own copy — every control edits it and hands a fresh object out, so the wiring
  // can never be surprised by a mutation it did not see.
  let settings: ProtectionSettings = { ...current };

  const root = doc.createElement('div');
  root.className = 'settings';

  const intro = doc.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent = strings.settingsIntro;
  root.appendChild(intro);

  const heading = (text: string): void => {
    const element = doc.createElement('h3');
    element.className = 'settings-heading';
    element.textContent = text;
    root.appendChild(element);
  };

  const row = (label: string, control: SettingsElement): void => {
    const container = doc.createElement('div');
    container.className = 'settings-row';
    const caption = doc.createElement('span');
    caption.className = 'settings-label';
    caption.textContent = label;
    container.appendChild(caption);
    control.setAttribute('aria-label', label);
    container.appendChild(control);
    root.appendChild(container);
  };

  const select = (
    label: string,
    choices: readonly Choice[],
    selected: string,
    apply: (value: string) => void,
  ): void => {
    const control = doc.createElement('select');
    control.className = 'settings-select';
    for (const choice of choices) {
      const option = doc.createElement('option');
      option.setAttribute('value', choice.value);
      option.textContent = choice.label;
      if (choice.value === selected) option.setAttribute('selected', '');
      control.appendChild(option);
    }
    control.value = selected;
    control.addEventListener('change', () => {
      apply(control.value ?? '');
      onChange({ ...settings });
    });
    row(label, control);
  };

  /** OFF plus a ladder — the encoding for every optional limit: `''` is "no limit". */
  const offOr = (choices: readonly Choice[]): Choice[] => [
    { value: '', label: strings.settingsOff },
    ...choices,
  ];
  const numberOr = (value: string): number | undefined =>
    value === '' ? undefined : Number(value);

  heading(strings.settingsAutoplayHeading);

  select(
    strings.settingsAutoplaySpins,
    spinsChoices.map((spins) => ({ value: String(spins), label: String(spins) })),
    String(settings.autoplaySpins),
    (value) => {
      settings = { ...settings, autoplaySpins: Number(value) };
    },
  );

  {
    const control = doc.createElement('input');
    control.className = 'settings-check';
    control.setAttribute('type', 'checkbox');
    control.checked = settings.stopOnFeature;
    control.addEventListener('change', () => {
      settings = { ...settings, stopOnFeature: control.checked === true };
      onChange({ ...settings });
    });
    row(strings.settingsStopOnFeature, control);
  }

  const multiples: Choice[] = multipleChoices.map((multiple) => ({
    value: String(multiple),
    label: strings.settingsStakeMultiple(multiple),
  }));

  select(
    strings.settingsStopOnWinOver,
    offOr(multiples),
    settings.winLimitX === undefined ? '' : String(settings.winLimitX),
    (value) => {
      const winLimitX = numberOr(value);
      settings = { ...settings, ...(winLimitX === undefined ? {} : { winLimitX }) };
      if (winLimitX === undefined) delete (settings as { winLimitX?: number }).winLimitX;
    },
  );

  select(
    strings.settingsStopOnLossOver,
    offOr(multiples),
    settings.lossLimitX === undefined ? '' : String(settings.lossLimitX),
    (value) => {
      const lossLimitX = numberOr(value);
      settings = { ...settings, ...(lossLimitX === undefined ? {} : { lossLimitX }) };
      if (lossLimitX === undefined) delete (settings as { lossLimitX?: number }).lossLimitX;
    },
  );

  heading(strings.settingsSessionHeading);

  select(
    strings.settingsSessionTime,
    offOr(
      minutesChoices.map((minutes) => ({
        value: String(minutes),
        label: strings.settingsMinutes(minutes),
      })),
    ),
    settings.maxSessionMinutes === undefined ? '' : String(settings.maxSessionMinutes),
    (value) => {
      const maxSessionMinutes = numberOr(value);
      settings = {
        ...settings,
        ...(maxSessionMinutes === undefined ? {} : { maxSessionMinutes }),
      };
      if (maxSessionMinutes === undefined) {
        delete (settings as { maxSessionMinutes?: number }).maxSessionMinutes;
      }
    },
  );

  select(
    strings.settingsSessionLoss,
    offOr(lossChoices.map((choice) => ({ value: String(choice.minor), label: choice.label }))),
    settings.maxLossMinor === undefined ? '' : String(settings.maxLossMinor),
    (value) => {
      const maxLossMinor = numberOr(value);
      settings = { ...settings, ...(maxLossMinor === undefined ? {} : { maxLossMinor }) };
      if (maxLossMinor === undefined) delete (settings as { maxLossMinor?: number }).maxLossMinor;
    },
  );

  host.appendChild(root);

  return {
    element: root,
    destroy() {
      root.remove();
    },
  };
}
