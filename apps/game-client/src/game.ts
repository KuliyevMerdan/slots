import { Application, Container } from 'pixi.js';
import type { GameConfig, Minor } from '@slot/protocol';
import { SlotEngine } from '@slot/engine';
import type { EngineEvent, EngineState } from '@slot/engine';
import { SCATTER, viewMatchesStops } from '@slot/game-math';
import { GameStage, PALETTE, createSymbolAtlas } from '@slot/renderer';
import { ControlPanel } from '@slot/ui';
import type { PanelView } from '@slot/ui';
import { connect } from './transport.js';
import { newRoundId } from './round-id.js';

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

export async function startGame(root: HTMLElement): Promise<Game> {
  const connection = connect();
  const engine = new SlotEngine({ port: connection.transport, newRoundId: () => newRoundId() });

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
    throw new Error(
      state.phase === 'ERROR' ? state.error.message : 'the session never became ready',
    );
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
  const atlas = createSymbolAtlas(app.renderer, symbolsOf(config));

  const stage = new GameStage({
    engine,
    config,
    atlas,
    anticipationSymbol: SCATTER,
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
    },
  });

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

  layout();
  app.renderer.on('resize', layout);

  /* ── the view model ─────────────────────────────────────────────────────────────────────────
   * Every number here arrived from the server through the engine. The panel formats them; nothing
   * in this file adds or subtracts money.
   */
  let win: Minor | undefined;
  let status = '';

  const render = (): void => {
    panel.render(modelFor(engine.state, win, status));
  };

  const unsubscribe = engine.on((event: EngineEvent) => {
    switch (event.type) {
      case 'SPIN_STARTED':
        win = undefined;
        status = '';
        break;
      case 'REELS_TARGETED':
        if (__ASSERT_MATH__ && !viewMatchesStops(config.strips, event.stops, event.view)) {
          console.error('[__ASSERT_MATH__] the server’s view disagrees with its own stops', {
            stops: event.stops,
            view: event.view,
          });
        }
        break;
      case 'WINS_PRESENTED':
        win = event.totalWin;
        break;
      case 'FEATURE_PROGRESS':
        status = `FREE SPINS ${String(event.feature.step)} / ${String(event.feature.total)}`;
        break;
      case 'FEATURE_ENDED':
        status = 'FEATURE COMPLETE';
        break;
      case 'ROUND_SETTLED':
        win = event.totalWin;
        status = event.capped ? 'MAXIMUM WIN REACHED' : status;
        break;
      case 'ERROR_RAISED':
        status = event.error.message;
        break;
      case 'ERROR_CLEARED':
        status = '';
        break;
      default:
        break;
    }
    render();
  });

  // One ticker for the whole game, delta-time driven. Nothing here allocates per frame.
  const tick = (): void => {
    stage.update(app.ticker.deltaMS);
  };
  app.ticker.add(tick);

  render();

  if (__DEV_TOOLS__) {
    // The debug panel is C7; this is the handle it will hang off, and what makes a browser console
    // a usable inspector in the meantime. Compile-stripped from production along with everything
    // else behind this flag.
    (window as unknown as { __slot?: unknown }).__slot = { app, engine, stage, panel, connection };
  }

  return {
    destroy: () => {
      unsubscribe();
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

/** The engine's phase, as the three facts a control panel needs. */
function modelFor(state: EngineState, win: Minor | undefined, status: string): PanelView {
  if (state.phase === 'BOOTING') {
    return {
      action: 'SPIN',
      canPress: false,
      canChangeStake: false,
      balance: 0 as Minor,
      stake: 0 as Minor,
      win: undefined,
      status: 'CONNECTING',
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
  };
}

const symbolsOf = (config: GameConfig): string[] => [...new Set(config.strips.flat())];
