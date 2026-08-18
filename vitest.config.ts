import { defineConfig } from 'vitest/config';

// Root-level suites only. Package tests run through their own package (`turbo run test`).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000, // the boundary suite shells out to dependency-cruiser
    // `tests/mash.test.ts` drives the real renderer, and Pixi reads a couple of browser globals when
    // it is imported. Nothing in these suites draws — see config/pixi-headless.ts.
    setupFiles: ['./config/pixi-headless.ts'],
  },
});
