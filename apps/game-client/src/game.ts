import { Application, Container } from 'pixi.js';
import type { ForceOutcome, GameConfig, JurisdictionRules, Minor, Win } from '@slot/protocol';
import {
  acknowledgeRealityCheck,
  canSpin,
  minutesPlayed,
  realityCheckDue,
  spinDelay,
  startRealityCheck,
} from '@slot/compliance';
import { SlotAudio, detectCapabilities, readSafeAreaInsets, watchVisibility } from '@slot/platform';

/** The named scenarios `@slot/rgs-sim` knows how to produce, for the console's convenience. */
type ForceScenario = Extract<ForceOutcome, { scenario: string }>['scenario'];
import { SlotEngine, sessionOf } from '@slot/engine';
import type { EngineEvent, EngineState } from '@slot/engine';
import { SCATTER, evaluate, viewMatchesStops } from '@slot/game-math';
import { GameStage, PALETTE, createSymbolAtlas, tierFor } from '@slot/renderer';
import { ControlPanel } from '@slot/ui';
import type { PanelView } from '@slot/ui';
import { connect } from './transport.js';
import { newRoundId } from './round-id.js';
import { AutoplayController } from './autoplay.js';
import type { AutoplayView } from './autoplay.js';
import { loadClientState, saveClientState, stakeFor } from './persistence.js';
import { consoleTelemetry, guarded } from './telemetry.js';
import type { Telemetry } from './telemetry.js';
import { createAnnouncer } from './announce.js';
import { STRINGS, resolveLocale } from './i18n.js';
import type { Strings } from './i18n.js';
import { createDomControls } from './dom-controls.js';

/**
 * The wiring site — the one place that knows every piece exists.
 *
 * Everything below it was built to be composable without knowing about the others: the engine takes
 * a port, the renderer takes an atlas and subscribes to events, the control panel takes a view
 * model, the simulator takes a store. This file is where those arguments are supplied, and it is
 * deliberately the only file in the project that imports all of them.
 *
 * It contains **no game rules**. It maps engine phases onto a button label, forwards a press, and
 * asks Pixi to draw a frame.
 */

const MARGIN = 28;

/**
 * The demo's autoplay plan. A player-facing picker is C7 (the debug panel's frame); the stop
 * conditions are the point here, and stop-on-feature is the one every regulator asks about first.
 */
const AUTOPLAY_PLAN = { spins: 25, stopOnFeature: true } as const;

export interface Game {
  destroy(): void;
}

export interface GameOptions {
  /**
   * Where failures are reported. Injected so a deployment can swap the console for a real collector
   * without this file learning which one it got — see telemetry.ts.
   */
  telemetry?: Telemetry;
}

export async function startGame(root: HTMLElement, options: GameOptions = {}): Promise<Game> {
  // Guarded at the boundary, once: every report site below sits on an error path, and a reporter
  // that throws while reporting would turn a frozen reel set into a blank page.
  const telemetry = guarded(options.telemetry ?? consoleTelemetry());
  const connection = connect();

  // The locale is session configuration, like the token: the lobby's launch URL decides (§7), the
  // browser is the fallback. Everything a player reads below comes out of this one catalogue.
  const strings: Strings = STRINGS[resolveLocale(window.location.search, navigator.language)];
  document.documentElement.lang = strings.locale;
  const noticeElement = document.querySelector('.notice');
  if (noticeElement !== null) noticeElement.textContent = strings.notice;

  /**
   * The next spin's forced outcome, if a developer asked for one.
   *
   * One shot: read once and cleared, so `__slot.force('MAX_WIN')` forces exactly the next round.
   * Behind `__DEV_TOOLS__`, which means a production bundle has no provider at all — and the server
   * refuses the field anyway unless it is in dev mode. Two gates, neither of them trusting the other.
   */
  let pendingForce: ForceOutcome | undefined;
  const takeForce = (): ForceOutcome | undefined => {
    const outcome = pendingForce;
    pendingForce = undefined;
    return outcome;
  };

  const engine = new SlotEngine({
    port: connection.transport,
    newRoundId: () => newRoundId(),
    // The same lobby the boot token comes from: with it, a session that expires under an open round
    // renews transparently and resumes from `pendingRound` instead of abandoning the money.
    renewSession: () => connection.token(),
    ...(__DEV_TOOLS__ ? { forceOutcome: takeForce } : {}),
  });

  // Subscribed before the session starts, because `SESSION_READY` carries the currency and it is
  // emitted during `start`. The client formats money with the server's currency or not at all.
  let currency = 'EUR';
  const capture = engine.on((event: EngineEvent) => {
    if (event.type === 'SESSION_READY') currency = event.session.currency;
  });

  // `start` authenticates *and* resumes: if a round was left open, the engine walks straight back
  // into the phase that continues it. There is no separate recovery path to keep in step.
  const token = await connection.token();
  await engine.start(token);
  capture();

  const state = engine.state;
  // `REAUTHENTICATING` is unreachable straight after `start()` — the boot has no open round to
  // renew for — but the machine's union says it exists, and treating it as a failed boot is the
  // honest answer if that ever changes.
  if (state.phase === 'BOOTING' || state.phase === 'ERROR' || state.phase === 'REAUTHENTICATING') {
    const failure =
      state.phase === 'ERROR' ? state.error.message : 'the session never became ready';

    // The one failure nobody else can report: it happens before the event subscription below, and
    // it is the shape a math-version mismatch or a dead RGS takes.
    telemetry.report({
      name: 'boot_failed',
      level: 'ERROR',
      message: failure,
      ...(state.phase === 'ERROR'
        ? {
            ...(state.error.correlationId === undefined
              ? {}
              : { correlationId: state.error.correlationId }),
            detail: { code: state.error.code, class: state.error.errorClass },
          }
        : {}),
    });

    throw new Error(failure);
  }

  const app = new Application();
  await app.init({
    background: PALETTE.backdrop,
    antialias: true,
    resizeTo: root,
    // The browser's own device pixel ratio, so the canvas is sharp on a phone rather than upscaled.
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  root.appendChild(app.canvas);

  const config: GameConfig = state.config;

  /**
   * Preferences survive a reload; the round does not.
   *
   * The stake is only adopted when the client came back to an idle table — if `authenticate` handed
   * back a round in flight, that round has its own stake and the player is mid-way through it.
   */
  const remembered = loadClientState(localStorage);
  const rules: JurisdictionRules = config.jurisdictionRules;
  // The jurisdiction wins over the remembered preference: a UK session boots with turbo off no
  // matter what the last DEFAULT session saved, and the toggle stays disabled below.
  const rememberedTurbo = (remembered?.turbo ?? false) && rules.turboAllowed;
  if (state.phase === 'IDLE') {
    engine.send({ type: 'SET_STAKE', stake: stakeFor(remembered, config.betLevels) });
  }

  /**
   * The audio layer — synthesized at boot, played on engine and renderer events, and absent
   * entirely on a platform without WebAudio rather than half-present and throwing. The context
   * starts suspended on iOS and under autoplay policies; `attachUnlock` resumes it on the first
   * gesture, which is also the gesture that starts the first spin.
   */
  const capabilities = detectCapabilities(window);
  const audio =
    capabilities.webAudio && 'AudioContext' in window
      ? new SlotAudio({ context: new AudioContext() })
      : null;
  const detachUnlock = audio?.attachUnlock(window);
  const stopWatchingVisibility =
    audio === null
      ? undefined
      : watchVisibility(document, (visible) => {
          audio.setHidden(!visible);
        });
  audio?.setMuted(remembered?.muted ?? false);

  const remember = (): void => {
    const current = engine.state;
    if (!('stake' in current)) return;
    saveClientState(
      localStorage,
      {
        stake: current.stake,
        turbo: stage.turbo,
        ...(audio === null ? {} : { muted: audio.muted }),
      },
      Date.now(),
    );
  };

  const atlas = createSymbolAtlas(app.renderer, symbolsOf(config));

  const stage = new GameStage({
    engine,
    config,
    atlas,
    currency,
    locale: strings.locale,
    labels: { feature: strings.feature, win: strings.win },
    anticipationSymbol: SCATTER,
    // The rolling counter drives the HUD, so there is exactly one count-up in the game and the
    // number under BALANCE and the number in the banner cannot disagree.
    onWinAmount: (amount: Minor) => {
      win = amount;
      render();
    },
    // One tick per reel, in stagger order — the sound the animation already makes visually.
    ...(audio === null ? {} : { onReelLanded: () => audio.play('REEL_STOP') }),
    // The dev-build assertion. Stripped from production, where `__ASSERT_MATH__` is `false` and the
    // bundler removes the branch — and loud in development, because a client drawing something
    // other than the committed outcome is the one bug this architecture exists to prevent.
    ...(__ASSERT_MATH__
      ? {
          onGridMismatch: (
            expected: readonly (readonly string[])[],
            drawn: readonly string[][],
          ) => {
            console.error('[__ASSERT_MATH__] the reels drew a grid the server did not send', {
              expected,
              drawn,
            });
          },
        }
      : {}),
  });

  const panel = new ControlPanel({
    config,
    currency,
    locale: strings.locale,
    labels: strings.panel,
    width: stage.width,
    onPress: () => {
      press(engine);
    },
    onStakeChange: (stake: Minor) => {
      engine.send({ type: 'SET_STAKE', stake });
      remember();
    },
    onToggleTurbo: (on: boolean) => {
      stage.setTurbo(on && rules.turboAllowed);
      remember();
      render();
    },
    onToggleAutoplay: (on: boolean) => {
      if (on) autoplay.start(AUTOPLAY_PLAN);
      else autoplay.stop();
      render();
    },
  });

  // The session was established before this stage existed, so any round it resumed into was
  // announced to nobody. Catch up before the first frame — see `GameStage.attach`.
  stage.attach(engine.state);

  const world = new Container();
  stage.view.position.set(0, 0);
  panel.view.position.set(0, stage.height + MARGIN);
  world.addChild(stage.view, panel.view);
  app.stage.addChild(world);

  const design = {
    width: Math.max(stage.width, panel.width),
    height: stage.height + MARGIN + panel.height,
  };

  const layout = (): void => {
    // Re-read per layout call: a rotated phone moves its notch, and rotation arrives as a resize.
    // Portrait and landscape both come out of the same letterbox — the composition is a vertical
    // stack, so portrait narrows it and landscape widens the margins; nothing re-flows.
    const insets = readSafeAreaInsets(document);
    const usableWidth = app.renderer.width - insets.left - insets.right - MARGIN * 2;
    const usableHeight = app.renderer.height - insets.top - insets.bottom - MARGIN * 2;
    const scale = Math.min(usableWidth / design.width, usableHeight / design.height);
    world.scale.set(scale);
    world.position.set(
      insets.left + (usableWidth - design.width * scale) / 2 + MARGIN,
      insets.top + (usableHeight - design.height * scale) / 2 + MARGIN,
    );
  };

  stage.setTurbo(rememberedTurbo);
  layout();
  app.renderer.on('resize', layout);

  /* ── the view model ─────────────────────────────────────────────────────────────────────────
   * Every number here arrived from the server through the engine. The panel formats them; nothing
   * in this file adds or subtracts money.
   */
  let win: Minor | undefined;
  let status = '';
  /** The grid the server sent for the round being presented — kept for the dev-build assertion. */
  let shownView: readonly (readonly string[])[] | null = null;

  /**
   * The pacing anchor — when the last spin started, on this client's clock. The compliance gate
   * holds the button for the remainder of `minSpinIntervalMs`, and the timer wakes the render
   * exactly when the window opens; the server enforces the same rule with `LIMIT_REACHED`, so a
   * client that got this wrong would be told so loudly.
   */
  let lastSpinStartedAt: number | undefined;
  let unlockTimer: ReturnType<typeof setTimeout> | undefined;

  const autoplay: AutoplayController = new AutoplayController({
    engine,
    rules,
    onChange: () => {
      render();
    },
  });

  /**
   * The live region in the HTML shell, kept in step with the panel.
   *
   * Rendered from the same view model rather than from the engine, so the sentence a screen reader
   * hears and the numbers a sighted player sees cannot describe different states.
   */
  const announcer = createAnnouncer({
    currency,
    locale: strings.locale,
    region: document.getElementById('a11y-status'),
    strings,
  });

  /* ── the reality check ──────────────────────────────────────────────────────────────────────
   * The jurisdiction's pause (`realityCheckIntervalMs`), scheduled by `@slot/compliance` and
   * enacted by the DOM overlay in the shell — never mid-round: the machine is only interrupted on
   * its way into IDLE. Time only, deliberately (ADR-0001: no client-summed money in front of a
   * player). Autoplay is stopped before the overlay opens, because a modal with autoplay still
   * firing behind it is the bug regulators write bulletins about.
   */
  let reality = startRealityCheck(Date.now());
  const realityRoot = document.getElementById('reality-check');
  const realityMessage = document.getElementById('reality-message');
  const realityContinue = document.getElementById('reality-continue');
  const realityOpen = (): boolean => realityRoot !== null && !realityRoot.hidden;

  const realityTitle = document.getElementById('reality-title');
  if (realityTitle !== null) realityTitle.textContent = strings.realityTitle;
  if (realityContinue !== null) realityContinue.textContent = strings.realityContinue;

  const showRealityCheck = (): void => {
    if (realityRoot === null) return;
    if (realityMessage !== null) {
      realityMessage.textContent = strings.realityMessage(minutesPlayed(reality, Date.now()));
    }
    realityRoot.hidden = false;
    if (realityContinue instanceof HTMLButtonElement) realityContinue.focus();
    render();
  };

  realityContinue?.addEventListener('click', () => {
    reality = acknowledgeRealityCheck(reality, Date.now());
    if (realityRoot !== null) realityRoot.hidden = true;
    render();
  });

  /* ── the sound toggle ─────────────────────────────────────────────────────────────────────── */
  const soundToggle = document.getElementById('sound-toggle');
  if (audio !== null && soundToggle instanceof HTMLButtonElement) {
    const applyMute = (muted: boolean): void => {
      audio.setMuted(muted);
      soundToggle.setAttribute('aria-pressed', String(!muted));
      soundToggle.textContent = muted ? strings.soundOff : strings.soundOn;
    };
    applyMute(remembered?.muted ?? false);
    soundToggle.hidden = false;
    soundToggle.addEventListener('click', () => {
      applyMute(!audio.muted);
      remember();
    });
  }

  /**
   * The keyboard's shadow of the Pixi panel: the same view model, rendered a second time as real
   * buttons. The handlers do exactly what the panel's do — a keyboard press must be
   * indistinguishable from a pointer press by the time it reaches the engine.
   */
  const domControls = createDomControls({
    doc: document,
    host: root,
    strings,
    handlers: {
      onPress: () => {
        press(engine);
      },
      onBetDown: () => {
        stepStake(-1);
      },
      onBetUp: () => {
        stepStake(1);
      },
      onToggleTurbo: () => {
        stage.setTurbo(!stage.turbo && rules.turboAllowed);
        remember();
        render();
      },
      onToggleAutoplay: () => {
        if (autoplay.view.active) autoplay.stop();
        else autoplay.start(AUTOPLAY_PLAN);
        render();
      },
    },
  });

  /** One step along the server's bet ladder — the same ladder the Pixi selector walks. */
  const stepStake = (direction: 1 | -1): void => {
    const current = engine.state;
    if (current.phase !== 'IDLE') return;
    const index = config.betLevels.indexOf(current.stake);
    const next = config.betLevels[index + direction];
    if (next === undefined) return;
    engine.send({ type: 'SET_STAKE', stake: next });
    remember();
  };

  const render = (): void => {
    const view = modelFor(engine.state, {
      win,
      status,
      turbo: stage.turbo,
      rules,
      // Two gates on one flag: the pacing window, and the reality check the player has not yet
      // answered. Either one holds the button; the overlay also physically covers it.
      canSpinNow: canSpin(rules, lastSpinStartedAt, Date.now()) && !realityOpen(),
      autoplay: autoplay.view,
      strings,
    });
    panel.render(view);
    domControls.render(view);
    announcer.announce(view);
  };

  const unsubscribe = engine.on((event: EngineEvent) => {
    switch (event.type) {
      case 'SPIN_STARTED':
        win = undefined;
        status = '';
        audio?.play('PRESS');
        lastSpinStartedAt = Date.now();
        // Wake the render when the pacing window opens, so the button un-greys by itself.
        if (unlockTimer !== undefined) clearTimeout(unlockTimer);
        {
          const delay = spinDelay(rules, lastSpinStartedAt, Date.now());
          if (delay > 0) unlockTimer = setTimeout(render, delay + 1);
        }
        break;
      case 'REELS_TARGETED':
        shownView = event.view;
        if (__ASSERT_MATH__ && !viewMatchesStops(config.strips, event.stops, event.view)) {
          telemetry.report({
            name: 'assert_view_disagrees_with_stops',
            level: 'ERROR',
            message: 'the server’s view disagrees with its own stops',
            detail: { stops: event.stops, view: event.view },
          });
        }
        break;
      case 'WINS_PRESENTED':
        win = event.totalWin;
        if (audio !== null && event.totalWin > 0) {
          // The same thresholds the banner uses (`tiers.ts`), so the fanfare and the plate cannot
          // disagree about how big a win was.
          const stake = sessionOf(engine.state)?.stake;
          const tier = stake === undefined ? null : tierFor(event.totalWin, stake);
          audio.play(
            tier?.id === 'MEGA' ? 'WIN_MEGA' : tier?.id === 'BIG' ? 'WIN_BIG' : 'WIN_NICE',
          );
        }
        if (__ASSERT_MATH__)
          assertWins(config, shownView, engine.state, event.wins, event.totalWin, telemetry);
        break;
      case 'FEATURE_AWARDED':
        audio?.play('FEATURE');
        break;
      case 'PHASE_CHANGED':
        // The reality check interrupts on the way into IDLE — between rounds, never inside one.
        if (event.to === 'IDLE' && realityCheckDue(rules, reality, Date.now())) {
          autoplay.stop();
          showRealityCheck();
        }
        break;
      // The feature's own counter lives on the stage, above the reels, where a player looks for it —
      // so the status line stays out of its way and keeps to what the stage does not say.
      case 'FEATURE_ENDED':
        status = '';
        break;
      case 'ROUND_SETTLED':
        win = event.totalWin;
        status = event.capped ? strings.maxWinReached : status;
        break;
      case 'SESSION_RENEWING':
        // Transparent to the player bar the pause — but telemetry counts it, because sessions that
        // keep expiring mid-round are an operator problem worth seeing in aggregate.
        telemetry.report({
          name: 'session_renewing',
          level: 'WARN',
          message: event.error.message,
          ...(event.error.correlationId === undefined
            ? {}
            : { correlationId: event.error.correlationId }),
          detail: { code: event.error.code },
        });
        break;
      case 'ERROR_RAISED':
        status = event.error.message;
        // Every raised error, not only the fatal ones: a `RECOVERABLE` that retries forever and a
        // `PLAYER` error nobody can act on are both worth seeing in aggregate, and the class is
        // right there to filter on.
        telemetry.report({
          name: 'error_raised',
          level: event.error.errorClass === 'RECOVERABLE' ? 'WARN' : 'ERROR',
          message: event.error.message,
          ...(event.error.roundId === undefined ? {} : { roundId: event.error.roundId }),
          ...(event.error.correlationId === undefined
            ? {}
            : { correlationId: event.error.correlationId }),
          detail: {
            code: event.error.code,
            class: event.error.errorClass,
            recovery: event.recovery,
          },
        });
        break;
      case 'ERROR_CLEARED':
        status = '';
        break;
      default:
        break;
    }
    render();
  });

  /**
   * `prefers-reduced-motion`, read from the platform rather than offered as a setting.
   *
   * Watched rather than sampled once: the preference is a system toggle, and a player who turns it
   * on mid-session did so because the animation is a problem *now*. `addEventListener` on a media
   * query list is the modern spelling; the optional call keeps this working in a test environment
   * that fakes `matchMedia` with the older one.
   */
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const applyMotionPreference = (): void => {
    stage.setReducedMotion(motionQuery.matches);
  };
  applyMotionPreference();
  motionQuery.addEventListener?.('change', applyMotionPreference);

  // One ticker for the whole game, delta-time driven. Nothing here allocates per frame.
  const tick = (): void => {
    stage.update(app.ticker.deltaMS);
  };
  app.ticker.add(tick);

  render();

  if (__DEV_TOOLS__) {
    // The debug panel is C7; this is the handle it will hang off, and what makes a browser console
    // a usable inspector in the meantime. `force('MAX_WIN')` is how C4 and C5 are developed at all:
    // a max win, a near miss or a feature on demand, instead of waiting for one.
    (window as unknown as { __slot?: unknown }).__slot = {
      app,
      engine,
      stage,
      panel,
      connection,
      // `force('MAX_WIN')` for a named scenario, `force({ stops: [...] })` for a specific grid.
      force: (outcome: ForceOutcome | ForceScenario) => {
        pendingForce = typeof outcome === 'string' ? { scenario: outcome } : outcome;
      },
    };
  }

  return {
    destroy: () => {
      autoplay.destroy();
      domControls.destroy();
      if (unlockTimer !== undefined) clearTimeout(unlockTimer);
      detachUnlock?.();
      stopWatchingVisibility?.();
      unsubscribe();
      motionQuery.removeEventListener?.('change', applyMotionPreference);
      app.ticker.remove(tick);
      app.renderer.off('resize', layout);
      stage.destroy();
      atlas.destroy();
      app.destroy(true, { children: true });
    },
  };
}

/**
 * One press, and the phase decides what it means.
 *
 * Except in `ERROR`, where the taxonomy decides instead: a `RECOVERABLE` failure offers a retry that
 * re-sends the same `roundId`, a `PLAYER` one is dismissed back to `IDLE`, and a `FATAL` one has no
 * input at all — the reels stay frozen and the player is offered a reload.
 */
function press(engine: SlotEngine): void {
  const state = engine.state;
  if (state.phase !== 'ERROR') {
    engine.send({ type: 'PRESS' });
    return;
  }

  if (state.recovery === 'RETRY') engine.send({ type: 'RETRY' });
  else if (state.recovery === 'DISMISS') engine.send({ type: 'DISMISS_ERROR' });
}

/**
 * The dev build's second assertion: **re-evaluate the server's grid with the local paytable.**
 *
 * The first (`viewMatchesStops`) catches a server whose view disagrees with its own stops. This one
 * catches the subtler and more expensive case — the paytable the client ships has drifted from the
 * one the server is paying on, so the reels would highlight a win the player was not paid, or pay a
 * win the reels do not show. It is presentation logic checking itself against authority, never
 * deciding anything (ADR-0001).
 */
function assertWins(
  config: GameConfig,
  view: readonly (readonly string[])[] | null,
  state: EngineState,
  wins: readonly Win[],
  totalWin: Minor,
  telemetry: Telemetry,
): void {
  if (view === null || !('stake' in state)) return;

  const local = evaluate({
    view,
    paylines: config.paylines,
    paytable: config.paytable,
    stake: state.stake,
  });

  const shape = (list: readonly Win[]): string =>
    JSON.stringify(
      [...list]
        .map((entry) => ({
          kind: entry.kind,
          line: entry.line ?? null,
          symbol: entry.symbol,
          count: entry.count,
          amount: entry.amount,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );

  if (local.totalWin === totalWin && shape(local.wins) === shape(wins)) return;

  telemetry.report({
    name: 'assert_paytable_drift',
    level: 'ERROR',
    message: 'the local paytable disagrees with the server about this spin',
    ...('roundId' in state ? { roundId: state.roundId } : {}),
    detail: { server: { wins, totalWin }, local },
  });
}

/** Everything the view model needs beyond the phase itself. */
interface ViewContext {
  win: Minor | undefined;
  status: string;
  turbo: boolean;
  rules: JurisdictionRules;
  /** The pacing gate: whether a spin may start *now*. Only ever gates the press from IDLE. */
  canSpinNow: boolean;
  autoplay: AutoplayView;
  strings: Strings;
}

/** The engine's phase, as the facts a control panel needs. */
function modelFor(state: EngineState, context: ViewContext): PanelView {
  const { win, status, turbo, rules, canSpinNow, autoplay, strings } = context;
  const noAuto = { autoplay: false, canToggleAutoplay: false, autoplayRemaining: undefined };

  if (state.phase === 'BOOTING') {
    return {
      action: strings.actionSpin,
      canPress: false,
      canChangeStake: false,
      balance: 0 as Minor,
      stake: 0 as Minor,
      win: undefined,
      status: strings.connecting,
      turbo,
      canToggleTurbo: false,
      ...noAuto,
    };
  }

  // The transparent mid-round re-authenticate: the round is alive and the machine is getting a
  // fresh session for it. Nothing is asked of the player, so nothing is pressable — the button
  // freezing with a status line is the pause this phase is.
  if (state.phase === 'REAUTHENTICATING') {
    const known = sessionOf(state);
    return {
      action: strings.actionSpin,
      canPress: false,
      canChangeStake: false,
      balance: known?.balance ?? (0 as Minor),
      stake: known?.stake ?? (0 as Minor),
      win: undefined,
      status: strings.reconnecting,
      turbo,
      canToggleTurbo: false,
      ...noAuto,
    };
  }

  if (state.phase === 'ERROR') {
    // `sessionOf` walks resume chains — an error raised while re-authenticating still knows the
    // round's numbers, two hops down.
    const known = sessionOf(state);
    return {
      action:
        state.recovery === 'RETRY'
          ? strings.actionRetry
          : state.recovery === 'DISMISS'
            ? strings.actionOk
            : strings.actionFrozen,
      canPress: state.recovery !== 'FROZEN',
      canChangeStake: false,
      balance: known?.balance ?? (0 as Minor),
      stake: known?.stake ?? (0 as Minor),
      win: undefined,
      status: status || state.error.message,
      turbo,
      canToggleTurbo: false,
      ...noAuto,
    };
  }

  const spinning = state.phase === 'SPINNING' || state.phase === 'FEATURE_SPINNING';
  const presenting =
    state.phase === 'WIN_PRESENTATION' ||
    state.phase === 'FEATURE_INTRO' ||
    state.phase === 'FEATURE_OUTRO';

  return {
    action: spinning ? strings.actionStop : presenting ? strings.actionSkip : strings.actionSpin,
    // The pacing gate holds only the spin that would start a new game cycle; a slam or a skip is
    // an interruption of the cycle already bought and paid for.
    canPress: state.phase === 'IDLE' ? canSpinNow : spinning || presenting,
    canChangeStake: state.phase === 'IDLE',
    balance: state.balance,
    stake: state.stake,
    win,
    status:
      status ||
      (state.phase === 'SETTLING' ? strings.paying : state.phase === 'STOPPING' ? '' : status),
    turbo,
    // The jurisdiction's word, applied: where turbo is forbidden the toggle is dead, not hidden —
    // a control that vanishes reads as a bug, one that is visibly off reads as a rule.
    canToggleTurbo: rules.turboAllowed,
    autoplay: autoplay.active,
    // Starting a run needs an idle table; stopping one must always be possible.
    canToggleAutoplay: rules.autoplayAllowed && (autoplay.active || state.phase === 'IDLE'),
    autoplayRemaining: autoplay.remaining,
  };
}

const symbolsOf = (config: GameConfig): string[] => [...new Set(config.strips.flat())];
