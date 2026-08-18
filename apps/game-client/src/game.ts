import { Application, Container } from 'pixi.js';
import type { ForceOutcome, GameConfig, Minor, Win } from '@slot/protocol';

/** The named scenarios `@slot/rgs-sim` knows how to produce, for the console's convenience. */
type ForceScenario = Extract<ForceOutcome, { scenario: string }>['scenario'];
import { SlotEngine } from '@slot/engine';
import type { EngineEvent, EngineState } from '@slot/engine';
import { SCATTER, evaluate, viewMatchesStops } from '@slot/game-math';
import { GameStage, PALETTE, createSymbolAtlas } from '@slot/renderer';
import { ControlPanel } from '@slot/ui';
import type { PanelView } from '@slot/ui';
import { connect } from './transport.js';
import { newRoundId } from './round-id.js';
import { loadClientState, saveClientState, stakeFor } from './persistence.js';
import { consoleTelemetry, guarded } from './telemetry.js';
import type { Telemetry } from './telemetry.js';
import { createAnnouncer } from './announce.js';

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
  if (state.phase === 'BOOTING' || state.phase === 'ERROR') {
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
  const rememberedTurbo = remembered?.turbo ?? false;
  if (state.phase === 'IDLE') {
    engine.send({ type: 'SET_STAKE', stake: stakeFor(remembered, config.betLevels) });
  }

  const remember = (): void => {
    const current = engine.state;
    if (!('stake' in current)) return;
    saveClientState(localStorage, { stake: current.stake, turbo: stage.turbo }, Date.now());
  };
  const atlas = createSymbolAtlas(app.renderer, symbolsOf(config));

  const stage = new GameStage({
    engine,
    config,
    atlas,
    currency,
    anticipationSymbol: SCATTER,
    // The rolling counter drives the HUD, so there is exactly one count-up in the game and the
    // number under BALANCE and the number in the banner cannot disagree.
    onWinAmount: (amount: Minor) => {
      win = amount;
      render();
    },
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
    width: stage.width,
    onPress: () => {
      press(engine);
    },
    onStakeChange: (stake: Minor) => {
      engine.send({ type: 'SET_STAKE', stake });
      remember();
    },
    onToggleTurbo: (on: boolean) => {
      stage.setTurbo(on);
      remember();
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
    const scale = Math.min(
      (app.renderer.width - MARGIN * 2) / design.width,
      (app.renderer.height - MARGIN * 2) / design.height,
    );
    world.scale.set(scale);
    world.position.set(
      (app.renderer.width - design.width * scale) / 2,
      (app.renderer.height - design.height * scale) / 2,
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
   * The live region in the HTML shell, kept in step with the panel.
   *
   * Rendered from the same view model rather than from the engine, so the sentence a screen reader
   * hears and the numbers a sighted player sees cannot describe different states.
   */
  const announcer = createAnnouncer({
    currency,
    region: document.getElementById('a11y-status'),
  });

  const render = (): void => {
    const view = modelFor(engine.state, win, status, stage.turbo);
    panel.render(view);
    announcer.announce(view);
  };

  const unsubscribe = engine.on((event: EngineEvent) => {
    switch (event.type) {
      case 'SPIN_STARTED':
        win = undefined;
        status = '';
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
        if (__ASSERT_MATH__)
          assertWins(config, shownView, engine.state, event.wins, event.totalWin, telemetry);
        break;
      // The feature's own counter lives on the stage, above the reels, where a player looks for it —
      // so the status line stays out of its way and keeps to what the stage does not say.
      case 'FEATURE_ENDED':
        status = '';
        break;
      case 'ROUND_SETTLED':
        win = event.totalWin;
        status = event.capped ? 'MAXIMUM WIN REACHED' : status;
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

/** The engine's phase, as the facts a control panel needs. */
function modelFor(
  state: EngineState,
  win: Minor | undefined,
  status: string,
  turbo: boolean,
): PanelView {
  if (state.phase === 'BOOTING') {
    return {
      action: 'SPIN',
      canPress: false,
      canChangeStake: false,
      balance: 0 as Minor,
      stake: 0 as Minor,
      win: undefined,
      status: 'CONNECTING',
      turbo,
      canToggleTurbo: false,
    };
  }

  if (state.phase === 'ERROR') {
    const resume = state.resume;
    const known = resume.phase === 'BOOTING' || resume.phase === 'ERROR' ? undefined : resume;
    return {
      action: state.recovery === 'RETRY' ? 'RETRY' : state.recovery === 'DISMISS' ? 'OK' : 'FROZEN',
      canPress: state.recovery !== 'FROZEN',
      canChangeStake: false,
      balance: known?.balance ?? (0 as Minor),
      stake: known?.stake ?? (0 as Minor),
      win: undefined,
      status: status || state.error.message,
      turbo,
      canToggleTurbo: false,
    };
  }

  const spinning = state.phase === 'SPINNING' || state.phase === 'FEATURE_SPINNING';
  const presenting =
    state.phase === 'WIN_PRESENTATION' ||
    state.phase === 'FEATURE_INTRO' ||
    state.phase === 'FEATURE_OUTRO';

  return {
    action: spinning ? 'STOP' : presenting ? 'SKIP' : 'SPIN',
    canPress: state.phase === 'IDLE' || spinning || presenting,
    canChangeStake: state.phase === 'IDLE',
    balance: state.balance,
    stake: state.stake,
    win,
    status:
      status || (state.phase === 'SETTLING' ? 'PAYING' : state.phase === 'STOPPING' ? '' : status),
    turbo,
    // A jurisdiction may take turbo away (C6); nothing does yet, so it is available between rounds
    // and while one is running.
    canToggleTurbo: true,
  };
}

const symbolsOf = (config: GameConfig): string[] => [...new Set(config.strips.flat())];
