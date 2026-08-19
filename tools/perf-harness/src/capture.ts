import { chromium } from 'playwright-core';
import type { Browser, CDPSession, Page } from 'playwright-core';

/**
 * The scripted session: boot the built client, throttle the CPU, spin, and measure.
 *
 * Three instruments, all attached before the page loads so the game cannot tell it is being
 * watched by anything it can feel:
 *
 * - **Frames** — a `requestAnimationFrame` loop records the gap between frames. rAF is the same
 *   clock Pixi's ticker runs on, so these gaps are exactly the frames a player would see.
 * - **Draw calls** — the WebGL draw entry points are wrapped with a counter, read and reset per
 *   frame. This is the number the atlas-batching rule is about: the symbol layer shares one
 *   texture so the whole grid should batch, and this instrument is what turns that claim into a
 *   figure.
 * - **Heap** — CDP `Performance.getMetrics`, sampled between spins. A slot that allocates in its
 *   ticker shows up here as a heap that climbs with every spin instead of sawtoothing flat.
 *
 * The spins are driven through the DOM control layer (`.kbd-controls`), which is the production
 * page's own keyboard surface — the harness presses the same button a player can, and needs no
 * dev hook, so it runs against the exact bundle that ships.
 */

export interface CaptureOptions {
  url: string;
  spins: number;
  /** CDP CPU throttle factor — 4 approximates a mid-range phone on a desktop core. */
  throttle: number;
  headed: boolean;
  /** Where to write the Chrome trace, if anywhere. */
  tracePath?: string;
}

export interface CaptureResult {
  /** Frame-to-frame gaps, ms, measurement window only. */
  frames: number[];
  /** Draw calls per frame, same window. */
  draws: number[];
  /** JS heap samples (bytes): one at start, one after every spin. */
  heap: number[];
  spinsPlayed: number;
}

/** Injected before any game script runs. Kept as source text: it executes in the page, not here. */
const INSTRUMENTS = `(() => {
  const perf = { frames: [], draws: [], pending: 0 };
  window.__perfCapture = perf;

  const wrap = (proto) => {
    if (!proto) return;
    for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const original = proto[name];
      if (typeof original !== 'function') continue;
      proto[name] = function (...args) {
        perf.pending += 1;
        return original.apply(this, args);
      };
    }
  };
  wrap(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  wrap(window.WebGLRenderingContext && WebGLRenderingContext.prototype);

  let last;
  const loop = (now) => {
    if (last !== undefined) {
      perf.frames.push(now - last);
      perf.draws.push(perf.pending);
    }
    perf.pending = 0;
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();`;

/** The spin button is the second control in the keyboard panel: bet−, spin, bet+, turbo, auto. */
const SPIN_READY = `(() => {
  const buttons = document.querySelectorAll('.kbd-controls button');
  return buttons.length > 1 && buttons[1].disabled === false;
})()`;

const heapOf = async (cdp: CDPSession): Promise<number> => {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0;
};

export async function capture(options: CaptureOptions): Promise<CaptureResult> {
  const browser: Browser = await chromium.launch({
    channel: 'chrome',
    headless: !options.headed,
  });

  try {
    const page: Page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.addInitScript(INSTRUMENTS);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    if (options.throttle > 1) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.throttle });
    }

    if (options.tracePath !== undefined) {
      await browser.startTracing(page, { path: options.tracePath, screenshots: false });
    }

    await page.goto(options.url);
    await page.waitForFunction(SPIN_READY, undefined, { timeout: 30_000 });

    // Boot, atlas generation and the first layout are start-up cost, not gameplay: reset the
    // instruments so the report describes the session, and let the numbers start honest.
    await page.evaluate(`(() => {
      window.__perfCapture.frames.length = 0;
      window.__perfCapture.draws.length = 0;
    })()`);

    const heap: number[] = [await heapOf(cdp)];
    let spinsPlayed = 0;

    for (let spin = 0; spin < options.spins; spin++) {
      await page.evaluate(`document.querySelectorAll('.kbd-controls button')[1].click()`);
      // The round is over when the button is pressable again — IDLE, past the pacing window. A
      // feature round takes as long as it takes; the timeout is per round, not per session.
      await page.waitForFunction(SPIN_READY, undefined, { timeout: 120_000 });
      heap.push(await heapOf(cdp));
      spinsPlayed += 1;
    }

    const measured = await page.evaluate<{ frames: number[]; draws: number[] }>(
      `({ frames: window.__perfCapture.frames, draws: window.__perfCapture.draws })`,
    );

    if (options.tracePath !== undefined) {
      await browser.stopTracing();
    }

    return { frames: measured.frames, draws: measured.draws, heap, spinsPlayed };
  } finally {
    await browser.close();
  }
}
