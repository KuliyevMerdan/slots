import { defineConfig } from 'vitest/config';

/**
 * The contract suite, on its own — `pnpm test:contract`.
 *
 * Separate from `vitest.config.ts` because the two answer different questions. The root suites ask
 * whether this workspace is wired together correctly; this one asks whether a *server* honours
 * docs/protocol.md, and it is the gate a real RGS has to pass before anything is switched over. It
 * stands up an HTTP server and plays hundreds of rounds, so it is also the slower of the two.
 *
 * `fileParallelism` is off: every target here binds a socket and holds a session, and a suite that
 * fights itself for ports teaches you nothing about the server it is testing.
 */
export default defineConfig({
  test: {
    include: ['tests/contract/**/*.test.ts'],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
