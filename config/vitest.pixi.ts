import { defineConfig } from 'vitest/config';

/**
 * The preset for the two Pixi packages. Same as `vitest.package.ts`, plus the handful of browser
 * globals Pixi touches when it is imported — see `pixi-headless.ts`.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    setupFiles: ['../../config/pixi-headless.ts'],
  },
});
