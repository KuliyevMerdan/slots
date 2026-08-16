import { defineConfig } from 'vitest/config';

/**
 * The preset every package runs its tests with (`vitest run --config ../../config/vitest.package.ts`).
 *
 * Tests live beside the code they test; the root `vitest.config.ts` covers only the workspace-level
 * suites in `tests/`, and without this preset it would swallow the package runs whole.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
