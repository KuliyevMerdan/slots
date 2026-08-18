import { defineConfig, loadEnv } from 'vite';

/**
 * Two things this file decides, and both of them are architecture rather than configuration.
 *
 * **The dev affordances are compile-time.** `__DEV_TOOLS__` and `__ASSERT_MATH__` are `define`d to
 * literal booleans, so a production build does not ship the debug panel or the grid assertion — the
 * bundler deletes the branches. That is gate one; the server refusing `forceOutcome` outside dev
 * mode is gate two, and both exist because one is a typo away from failing.
 *
 * **The browser reaches the RGS through a same-origin proxy.** `apps/mock-rgs` sends no CORS
 * headers, deliberately: a dev server that hands out `Access-Control-Allow-Origin: *` teaches a
 * habit that has no place near a real one. Vite forwards `/rgs` and `/demo` instead, so the client
 * makes same-origin requests in development and points at a real base URL in production — which is
 * the same one-line switch the transport seam promises.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_RGS_BASE_URL ?? 'http://localhost:8787';
  const production = mode === 'production';

  return {
    define: {
      __DEV_TOOLS__: JSON.stringify(!production),
      __ASSERT_MATH__: JSON.stringify(!production),
    },
    server: {
      port: 5173,
      proxy: {
        '/rgs': { target, changeOrigin: true },
        '/demo': { target, changeOrigin: true },
        '/dev': { target, changeOrigin: true },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
    },
  };
});
