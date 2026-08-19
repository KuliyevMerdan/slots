import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from './capture.js';
import { serveDist } from './serve.js';
import { drawStats, frameStats, heapStats } from './stats.js';

/**
 * `pnpm perf` — fps, draw calls and heap for a scripted session, on a throttled profile.
 *
 * Numbers, not adjectives (CLAUDE.md): the performance rules promise one draw-call batch for the
 * symbol layer, zero allocation in the ticker and 60 fps on a mid-range phone, and this is the
 * tool that turns each promise into a figure. The profile is approximated with a CPU throttle
 * (default 4×) — a desktop core slowed four-fold lands near a mid-range Android's single-core
 * budget, which is the honest thing a laptop can claim about a phone.
 *
 *   pnpm perf                     # 30 spins, 4× throttle, against apps/game-client/dist
 *   pnpm perf --spins 100         # longer session
 *   pnpm perf --throttle 1        # unthrottled
 *   pnpm perf --url http://...    # against a running server instead of dist
 *   pnpm perf --headed            # watch it happen
 */

const flag = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? fallback;
};

const has = (name: string): boolean => process.argv.includes(`--${name}`);

const spins = Number.parseInt(flag('spins', '30'), 10);
const throttle = Number.parseFloat(flag('throttle', '4'));
const explicitUrl = flag('url', '');

if (!Number.isFinite(spins) || spins < 1) {
  console.error(`--spins must be a positive integer, got "${flag('spins', '')}"`);
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const dist = join(repoRoot, 'apps', 'game-client', 'dist');
const tracePath = join(here, '..', 'traces', 'perf-trace.json');
mkdirSync(dirname(tracePath), { recursive: true });

const run = async (): Promise<void> => {
  let server: Awaited<ReturnType<typeof serveDist>> | undefined;
  let url = explicitUrl;

  if (url === '') {
    if (!existsSync(join(dist, 'index.html'))) {
      console.error(`no build at ${dist} — run \`pnpm build\` first, or pass --url`);
      process.exit(2);
    }
    server = await serveDist(dist);
    url = server.url;
  }

  process.stderr.write(
    `perf-harness — ${String(spins)} spins at ${String(throttle)}× CPU throttle, ${url}\n`,
  );

  try {
    const result = await capture({
      url,
      spins,
      throttle,
      headed: has('headed'),
      tracePath,
    });

    const frames = frameStats(result.frames);
    const draws = drawStats(result.draws);
    const heap = heapStats(result.heap);
    const ms = (value: number): string => value.toFixed(1);

    console.log(
      `\nperf-harness — ${String(result.spinsPlayed)} spins, ${String(throttle)}× CPU throttle, ${has('headed') ? 'headed' : 'headless'} Chrome`,
    );
    console.log(
      `  frames      ${String(frames.frames)} over ${(frames.totalMs / 1000).toFixed(1)} s`,
    );
    console.log(`  fps         avg ${frames.avgFps.toFixed(1)}`);
    console.log(
      `  frame ms    p50 ${ms(frames.p50Ms)} · p95 ${ms(frames.p95Ms)} · p99 ${ms(frames.p99Ms)} · worst ${ms(frames.worstMs)}`,
    );
    console.log(
      `  dropped     ${String(frames.dropped)} frames over 25 ms (${(frames.droppedShare * 100).toFixed(1)}%)`,
    );
    console.log(`  draw calls  avg ${draws.avg.toFixed(1)} per frame · max ${String(draws.max)}`);
    console.log(
      `  js heap     start ${heap.startMb.toFixed(1)} MB · peak ${heap.peakMb.toFixed(1)} MB · end ${heap.endMb.toFixed(1)} MB`,
    );
    console.log(`  trace       ${tracePath}`);
    console.log(
      '\n  Headless Chrome renders through SwiftShader (software GL), so fps here reads *below*\n  a real device with a GPU — treat the numbers as a floor and the trend as the signal.',
    );
  } finally {
    await server?.close();
  }
};

run().catch((cause: unknown) => {
  console.error('perf-harness failed:', cause);
  process.exit(1);
});
