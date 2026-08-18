/// <reference types="vite/client" />

/**
 * The two compile-time gates, declared so TypeScript sees them as the booleans Vite substitutes.
 *
 * Written as `declare const` rather than a global interface on purpose: reading one is legal,
 * assigning one is a type error, and a production bundle contains neither the flag nor the code
 * behind it.
 */
declare const __DEV_TOOLS__: boolean;
declare const __ASSERT_MATH__: boolean;

interface ImportMetaEnv {
  /** `mock` — the simulator in this tab — or `http`, which talks to apps/mock-rgs. */
  readonly VITE_RGS_TRANSPORT?: 'mock' | 'http';
  readonly VITE_RGS_BASE_URL?: string;
}
