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
  /** `mock` — the simulator in this tab — or `http`, which talks to a server over the wire. */
  readonly VITE_RGS_TRANSPORT?: 'mock' | 'http';
  readonly VITE_RGS_BASE_URL?: string;
  /**
   * An out-of-band session token for the `http` transport (§7: tokens are issued outside the
   * game wire, and in development the environment is the out-of-band channel). Set, the client
   * uses it instead of asking `POST /demo/session` — which is how it plays against `apps/rgs`,
   * a server that deliberately has no demo lobby (R7).
   */
  readonly VITE_RGS_TOKEN?: string;
}
