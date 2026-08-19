import type { RgsTransport } from '@slot/transport';
import { HttpTransport, MockTransport, withRetry } from '@slot/transport';
import { SimServer, WebStorageStore, createSimConfig, createSimState } from '@slot/rgs-sim';
import type { FaultConfig } from '@slot/rgs-sim';
import { JURISDICTIONS } from '@slot/protocol';
import type { JurisdictionId, Minor } from '@slot/protocol';
import type { FaultView } from '@slot/dev-tools';

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
  /** For the debug panel and the dev overlay: which target this is. */
  readonly kind: 'mock' | 'http';
  /** The developer's control plane — the seams the debug panel drives. Dev builds only. */
  readonly dev?: DevPlane;
}

/**
 * What the debug panel can do to the server, as ports.
 *
 * The same controls exist for both targets — in-process they are `SimServer`'s own methods, over
 * HTTP they are `apps/mock-rgs`'s `/dev/*` routes — except the jurisdiction switch, which is
 * absent over HTTP: a remote server's regime is that server's configuration, and pretending a
 * client-side toggle changes it would be the panel lying.
 */
export interface DevPlane {
  faults: {
    get(): Promise<FaultView>;
    set(view: FaultView): Promise<void>;
  };
  session: {
    expire(): void;
  };
  serverState(): Promise<unknown>;
  jurisdiction?: {
    current: JurisdictionId;
    options: readonly JurisdictionId[];
    set(id: JurisdictionId): void;
  };
}

/**
 * The dev-build jurisdiction override, remembered across the reload a regime change requires.
 *
 * A dev affordance, not a preference: it lives beside `PersistedEnvelope`, not inside it, because
 * the envelope is player state and this is a developer impersonating a different lobby. The wire
 * stays honest — the sim is *constructed* with the regime, and the rules still arrive in
 * `GameConfig.jurisdictionRules` like they would from any server (D8).
 */
const DEV_JURISDICTION_KEY = 'slot.dev.jurisdiction';

const rememberedJurisdiction = (storage: Storage): JurisdictionId | undefined => {
  const stored = storage.getItem(DEV_JURISDICTION_KEY);
  return stored !== null && (JURISDICTIONS as readonly string[]).includes(stored)
    ? (stored as JurisdictionId)
    : undefined;
};

/**
 * The in-process simulator, persisted to `localStorage`.
 *
 * Persistence is not decoration here: it is what makes `pendingRound` recovery real in the dev loop.
 * Reload the tab mid-round and `authenticate` hands the round back, exactly as a real RGS would.
 * The store arrives as a constructor argument because the simulator is a pure package and
 * `localStorage` is a lint error inside it (ADR-0003).
 */
function inProcess(): Connection {
  const jurisdiction = __DEV_TOOLS__ ? rememberedJurisdiction(localStorage) : undefined;
  const sim = new SimServer({
    initialState: createSimState({
      serverSeed: SEED,
      balance: DEMO_BALANCE,
      expiresAt: Date.now() + SESSION_HOURS * 3_600_000,
    }),
    config: createSimConfig({
      devMode: __DEV_TOOLS__,
      ...(jurisdiction === undefined ? {} : { jurisdiction }),
    }),
    store: new WebStorageStore(localStorage),
    now: () => Date.now(),
  });

  return {
    kind: 'mock',
    // `issueSession` renews: asking for a token extends the running session, so the engine's
    // transparent mid-round re-authenticate (docs/protocol.md §5) works in-process exactly as it
    // does against the demo lobby endpoint over HTTP.
    transport: withRetry(new MockTransport({ backend: sim })),
    token: () => Promise.resolve(sim.issueSession().token),
    ...(__DEV_TOOLS__ ? { dev: mockDevPlane(sim) } : {}),
  };
}

/** The in-process control plane: `SimServer`'s own methods, behind the same ports HTTP gets. */
function mockDevPlane(sim: SimServer): DevPlane {
  return {
    faults: {
      get: () => Promise.resolve({ ...sim.faults }),
      set: (view) => {
        sim.setFaults(view as FaultConfig);
        return Promise.resolve();
      },
    },
    session: {
      expire: () => {
        sim.expireSession();
      },
    },
    // The same summary `/dev/state` serves over HTTP, and for the same reason it is a summary:
    // the rounds carry their full stored responses, and the inspector wants four fields.
    serverState: () =>
      Promise.resolve({
        serverSeed: sim.state.serverSeed,
        token: sim.state.token,
        balance: sim.state.balance,
        seq: sim.state.seq,
        session: sim.state.session,
        rounds: sim.state.rounds.map((round) => ({
          roundId: round.roundId,
          state: round.state,
          stake: round.stake,
          cumulativeWin: round.cumulativeWin,
          steps: round.steps.length,
        })),
      }),
    jurisdiction: {
      current: sim.config.jurisdiction,
      options: JURISDICTIONS,
      set: (id) => {
        // A regime is not hot-swapped: the choice is remembered and the client restarts, so the
        // new rules arrive the only honest way — on the wire, from `authenticate`.
        localStorage.setItem(DEV_JURISDICTION_KEY, id);
        window.location.reload();
      },
    },
  };
}

/**
 * The HTTP path.
 *
 * The base URL is empty in development because Vite proxies `/rgs` and `/demo` to the server,
 * so the browser makes same-origin requests and nobody has to widen CORS to make a dev loop work.
 *
 * Where the token comes from is the lobby seam, and it has two honest shapes (§7). Against
 * `apps/mock-rgs`, `POST /demo/session` issues-and-renews — the demo lobby. Against `apps/rgs`
 * there is deliberately no demo lobby, so the token arrives out of band in `VITE_RGS_TOKEN` —
 * the environment standing in for the operator that would normally mint it through
 * `/operator/sessions`. Renewal under a static token answers the same token: the session either
 * still stands (and re-authenticating re-attaches, §5) or the operator must issue a new one,
 * which no client-side code can do for it.
 */
function overHttp(baseUrl: string, staticToken: string | undefined): Connection {
  return {
    kind: 'http',
    transport: withRetry(new HttpTransport({ baseUrl })),
    token:
      staticToken !== undefined
        ? () => Promise.resolve(staticToken)
        : async () => {
            const response = await fetch(`${baseUrl}/demo/session`, { method: 'POST' });
            if (!response.ok) {
              throw new Error(`the demo lobby refused to issue a token: HTTP ${response.status}`);
            }
            const body = (await response.json()) as { token?: string };
            if (typeof body.token !== 'string') throw new Error('the demo lobby sent no token');
            return body.token;
          },
    ...(__DEV_TOOLS__ ? { dev: httpDevPlane(baseUrl) } : {}),
  };
}

/** The HTTP control plane: `apps/mock-rgs`'s `/dev/*` routes, reached through the Vite proxy. */
function httpDevPlane(baseUrl: string): DevPlane {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`the dev route refused: HTTP ${String(response.status)}`);
    }
    return (await response.json()) as T;
  };

  return {
    faults: {
      get: () => call<FaultView>('/dev/faults'),
      set: async (view) => {
        await call('/dev/faults', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(view),
        });
      },
    },
    session: {
      // Fire and forget, like the in-process port: the proof it worked is the next call failing
      // SESSION_EXPIRED, which is the entire point of pressing the button.
      expire: () => {
        void call('/dev/expire', { method: 'POST' });
      },
    },
    serverState: () => call('/dev/state'),
    // No jurisdiction switch over HTTP: a remote server's regime is that server's configuration.
  };
}

export const connect = (): Connection =>
  import.meta.env.VITE_RGS_TRANSPORT === 'http'
    ? overHttp('', import.meta.env.VITE_RGS_TOKEN)
    : inProcess();
