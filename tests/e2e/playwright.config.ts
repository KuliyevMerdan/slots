import { defineConfig } from '@playwright/test';

/**
 * The E2E suite (C8): the deployed artifact's exact shape, driven like a player.
 *
 * The web server is the composition ADR-0010 ships — `apps/mock-rgs` serving the client's demo
 * build from its own origin — so what these tests exercise is byte-for-byte what a stranger at
 * the live URL gets: same bundle, same server, same one origin. Determinism comes from *forced
 * outcomes*, not from the seed alone: the client mints a fresh time-based `roundId` per spin and
 * the spin seed is derived from it (docs/protocol.md §9), so no fixed server seed can replay an
 * unforced outcome across runs.
 */

const PORT = 8797;

export default defineConfig({
  testDir: '.',
  // A full feature at presentation speed is tens of seconds; the budget says a stuck one fails
  // in minutes, not in CI's job timeout.
  timeout: 180_000,
  // Deterministic by design (forced outcomes, DEFAULT jurisdiction, one worker): a flake here is
  // a bug to fix, never to retry past.
  retries: 0,
  // One worker because every test drives the same single-session server; `/dev/reset` between
  // tests is the isolation, and parallel workers would share a balance.
  workers: 1,
  forbidOnly: !!process.env['CI'],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // A failed run keeps its trace — in CI the trace is the difference between a fix and a shrug.
    trace: 'retain-on-failure',
  },
  webServer: {
    // Build the demo bundle, then serve it from the game API's origin — the ADR-0010 shape. The
    // seed is pinned for tidiness (log lines, correlation ids), not for outcomes; see above.
    command: [
      'VITE_RGS_TRANSPORT=http pnpm --filter @slot/game-client run build:demo',
      `MOCK_RGS_STATIC_DIR=apps/game-client/dist-demo MOCK_RGS_PORT=${String(PORT)} MOCK_RGS_SEED=e2e-seed node apps/mock-rgs/dist/main.js`,
    ].join(' && '),
    cwd: '../..',
    url: `http://127.0.0.1:${String(PORT)}/ready`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
