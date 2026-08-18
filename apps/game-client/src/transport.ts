import type { RgsTransport } from '@slot/transport';
import { HttpTransport, MockTransport, withRetry } from '@slot/transport';
import {
  SimServer,
  WebStorageStore,
  createSimConfig,
  createSimState,
  mintDemoToken,
} from '@slot/rgs-sim';
import type { Minor } from '@slot/protocol';

/**
 * Which server this client talks to — **the one decision that is a config change rather than a
 * refactor.**
 *
 * Everything above this file sees `RgsTransport`. Below it there are two objects: the simulator
 * running in this tab, and an HTTP client pointed at `apps/mock-rgs` (and, later, at a real RGS).
 * Nothing else in the client changes between them, which is the claim the architecture makes and
 * `tests/http.test.ts` proves.
 *
 * Both are wrapped in `withRetry`, so the timeout, the backoff and the rule that a retry re-sends
 * the *same* `roundId` are one implementation rather than two.
 */

/** Play money. There is no real balance anywhere in this project, by design. */
const DEMO_BALANCE = 1_000_000 as Minor;
const SESSION_HOURS = 12;
const SEED = 'aurora-reels-demo';

export interface Connection {
  transport: RgsTransport;
  /** How the client gets a token: from the in-process sim, or from the demo lobby endpoint (§7). */
  token(): Promise<string>;
  /** For the debug panel (C7) and the dev overlay: which target this is. */
  readonly kind: 'mock' | 'http';
}

/**
 * The in-process simulator, persisted to `localStorage`.
 *
 * Persistence is not decoration here: it is what makes `pendingRound` recovery real in the dev loop.
 * Reload the tab mid-round and `authenticate` hands the round back, exactly as a real RGS would.
 * The store arrives as a constructor argument because the simulator is a pure package and
 * `localStorage` is a lint error inside it (ADR-0003).
 */
function inProcess(): Connection {
  const sim = new SimServer({
    initialState: createSimState({
      serverSeed: SEED,
      balance: DEMO_BALANCE,
      expiresAt: Date.now() + SESSION_HOURS * 3_600_000,
    }),
    config: createSimConfig({ devMode: __DEV_TOOLS__ }),
    store: new WebStorageStore(localStorage),
    now: () => Date.now(),
  });

  return {
    kind: 'mock',
    transport: withRetry(new MockTransport({ backend: sim })),
    token: () => Promise.resolve(mintDemoToken(SEED)),
  };
}

/**
 * The HTTP path.
 *
 * The base URL is empty in development because Vite proxies `/rgs` and `/demo` to `apps/mock-rgs`,
 * so the browser makes same-origin requests and nobody has to widen CORS to make a dev loop work.
 */
function overHttp(baseUrl: string): Connection {
  return {
    kind: 'http',
    transport: withRetry(new HttpTransport({ baseUrl })),
    token: async () => {
      const response = await fetch(`${baseUrl}/demo/session`, { method: 'POST' });
      if (!response.ok) {
        throw new Error(`the demo lobby refused to issue a token: HTTP ${response.status}`);
      }
      const body = (await response.json()) as { token?: string };
      if (typeof body.token !== 'string') throw new Error('the demo lobby sent no token');
      return body.token;
    },
  };
}

export const connect = (): Connection =>
  import.meta.env.VITE_RGS_TRANSPORT === 'http' ? overHttp('') : inProcess();
