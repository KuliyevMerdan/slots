import type { PanelLabels } from '@slot/ui';
import type { FeatureLabels, WinLabels, WinTierId } from '@slot/renderer';

/**
 * The string catalogue — every sentence a player can read or hear, in one place per language.
 *
 * The locale arrives the way everything else about a session does in iGaming: **in the launch URL**
 * (`?lang=ru`), because the operator's lobby knows the player's language and the game is embedded
 * (docs/protocol.md §7). `navigator.language` is the fallback for the demo opened directly.
 *
 * Money is deliberately *not* here: `@slot/money` formats amounts through `Intl` with the server's
 * currency, which is what "currency-aware formatting" means — a catalogue that interpolated
 * pre-formatted numbers into translated templates is how you get "1 000,00 € WIN" in one locale and
 * "WIN €1,000.00" in another to mean different things.
 *
 * Every string is a value on this object rather than a call to a library, because two languages and
 * a public repository do not need an i18n framework — they need a table a test can walk, which is
 * exactly what the Cyrillic coverage test does (i18n.test.ts).
 */

export type Locale = 'en' | 'ru';

export const LOCALES: readonly Locale[] = ['en', 'ru'];

export interface Strings {
  /** `<html lang>` and the formatting locale for `@slot/money`. */
  locale: Locale;

  /* The button, by phase. */
  actionSpin: string;
  actionStop: string;
  actionSkip: string;
  actionRetry: string;
  actionOk: string;
  actionFrozen: string;

  /* Status lines. */
  connecting: string;
  reconnecting: string;
  paying: string;
  maxWinReached: string;

  /* The announcer's words — the screen-reader sentence is built from these. */
  balanceWord: string;
  stakeWord: string;
  winWord: string;
  readyToSpin: string;
  spinning: string;
  showingWin: string;
  retryHint: string;
  continueHint: string;
  frozenHint: string;

  /* The DOM shell. */
  soundOn: string;
  soundOff: string;
  realityTitle: string;
  realityMessage(minutes: number): string;
  realityContinue: string;
  notice: string;

  /* The Pixi surfaces, injected at construction. */
  panel: PanelLabels;
  feature: FeatureLabels;
  win: WinLabels;
}

const EN: Strings = {
  locale: 'en',

  actionSpin: 'SPIN',
  actionStop: 'STOP',
  actionSkip: 'SKIP',
  actionRetry: 'RETRY',
  actionOk: 'OK',
  actionFrozen: 'FROZEN',

  connecting: 'CONNECTING',
  reconnecting: 'RECONNECTING',
  paying: 'PAYING',
  maxWinReached: 'MAXIMUM WIN REACHED',

  balanceWord: 'balance',
  stakeWord: 'stake',
  winWord: 'win',
  readyToSpin: 'ready to spin',
  spinning: 'spinning',
  showingWin: 'showing the win',
  retryHint: 'connection problem, press to retry',
  continueHint: 'press to continue',
  frozenHint: 'the game has stopped and needs a reload',

  soundOn: 'SOUND ON',
  soundOff: 'SOUND OFF',
  realityTitle: 'REALITY CHECK',
  realityMessage: (minutes) =>
    `You have been playing for ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}. Do you want to continue?`,
  realityContinue: 'CONTINUE',
  notice: '18+ · Demo · Play money only — no real money and no payments',

  panel: { bet: 'BET', balance: 'BALANCE', win: 'WIN', turbo: 'TURBO', auto: 'AUTO' },
  feature: {
    counter: (next, total) => `FREE SPIN ${String(next)} / ${String(total)}`,
    retrigger: (added) => `+${String(added)} FREE SPINS`,
    introTitle: 'FREE SPINS',
    introDetail: (total) => `${String(total)} SPINS`,
    outroTitle: 'FEATURE COMPLETE',
  },
  win: { tier: (id) => `${id} WIN` },
};

/** Russian pluralisation: 1 спин, 2 спина, 5 спинов — three forms, chosen by the last digits. */
const ruPlural = (count: number, one: string, few: string, many: string): string => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

const RU_TIERS: Record<WinTierId, string> = {
  NICE: 'ХОРОШИЙ ВЫИГРЫШ',
  BIG: 'КРУПНЫЙ ВЫИГРЫШ',
  MEGA: 'МЕГА-ВЫИГРЫШ',
};

const RU: Strings = {
  locale: 'ru',

  actionSpin: 'СПИН',
  actionStop: 'СТОП',
  actionSkip: 'ДАЛЕЕ',
  actionRetry: 'ПОВТОР',
  actionOk: 'ОК',
  actionFrozen: 'СТОП-ИГРА',

  connecting: 'ПОДКЛЮЧЕНИЕ',
  reconnecting: 'ПЕРЕПОДКЛЮЧЕНИЕ',
  paying: 'ВЫПЛАТА',
  maxWinReached: 'ДОСТИГНУТ МАКСИМАЛЬНЫЙ ВЫИГРЫШ',

  balanceWord: 'баланс',
  stakeWord: 'ставка',
  winWord: 'выигрыш',
  readyToSpin: 'можно вращать',
  spinning: 'барабаны вращаются',
  showingWin: 'показ выигрыша',
  retryHint: 'проблема со связью, нажмите для повтора',
  continueHint: 'нажмите, чтобы продолжить',
  frozenHint: 'игра остановлена, требуется перезагрузка',

  soundOn: 'ЗВУК ВКЛ',
  soundOff: 'ЗВУК ВЫКЛ',
  realityTitle: 'ПРОВЕРКА ВРЕМЕНИ',
  realityMessage: (minutes) =>
    `Вы играете уже ${String(minutes)} ${ruPlural(minutes, 'минуту', 'минуты', 'минут')}. Продолжить?`,
  realityContinue: 'ПРОДОЛЖИТЬ',
  notice: '18+ · Демо · Только игровые деньги — без реальных денег и платежей',

  panel: { bet: 'СТАВКА', balance: 'БАЛАНС', win: 'ВЫИГРЫШ', turbo: 'ТУРБО', auto: 'АВТО' },
  feature: {
    counter: (next, total) => `ФРИСПИН ${String(next)} / ${String(total)}`,
    retrigger: (added) =>
      `+${String(added)} ${ruPlural(added, 'ФРИСПИН', 'ФРИСПИНА', 'ФРИСПИНОВ')}`,
    introTitle: 'ФРИСПИНЫ',
    introDetail: (total) => `${String(total)} ${ruPlural(total, 'СПИН', 'СПИНА', 'СПИНОВ')}`,
    outroTitle: 'ФРИСПИНЫ ЗАВЕРШЕНЫ',
  },
  win: { tier: (id) => RU_TIERS[id] },
};

export const STRINGS: Record<Locale, Strings> = { en: EN, ru: RU };

/**
 * Resolve the session's locale: the launch URL first (the operator's word, §7), the browser second,
 * English otherwise. Unknown values fall through rather than throw — a bad `?lang=` is not a reason
 * to refuse to play.
 */
export function resolveLocale(search: string, navigatorLanguage: string | undefined): Locale {
  const requested = new URLSearchParams(search).get('lang')?.toLowerCase();
  if (requested !== undefined && (LOCALES as readonly string[]).includes(requested)) {
    return requested as Locale;
  }
  if (navigatorLanguage?.toLowerCase().startsWith('ru') === true) return 'ru';
  return 'en';
}

/**
 * Every sentence a locale can produce, flattened — the raw material for the glyph-coverage test.
 * Functions are sampled across the plural forms, so a plural variant cannot hide a character the
 * face lacks.
 */
export function allStrings(strings: Strings): string[] {
  const samples = [0, 1, 2, 5, 11, 21, 104];
  return [
    strings.actionSpin,
    strings.actionStop,
    strings.actionSkip,
    strings.actionRetry,
    strings.actionOk,
    strings.actionFrozen,
    strings.connecting,
    strings.reconnecting,
    strings.paying,
    strings.maxWinReached,
    strings.balanceWord,
    strings.stakeWord,
    strings.winWord,
    strings.readyToSpin,
    strings.spinning,
    strings.showingWin,
    strings.retryHint,
    strings.continueHint,
    strings.frozenHint,
    strings.soundOn,
    strings.soundOff,
    strings.realityTitle,
    ...samples.map((count) => strings.realityMessage(count)),
    strings.realityContinue,
    strings.notice,
    ...Object.values(strings.panel),
    strings.feature.introTitle,
    strings.feature.outroTitle,
    ...samples.map((count) => strings.feature.counter(count, count)),
    ...samples.map((count) => strings.feature.retrigger(count)),
    ...samples.map((count) => strings.feature.introDetail(count)),
    ...(['NICE', 'BIG', 'MEGA'] as const).map((tier) => strings.win.tier(tier)),
  ];
}
