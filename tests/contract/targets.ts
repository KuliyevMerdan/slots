import type { ErrorCode, Minor, RoundState } from '@slot/protocol';
import { SimServer, createSimConfig, createSimState } from '@slot/rgs-sim';
import type { FaultConfig } from '@slot/rgs-sim';
import { buildApp } from '@slot/mock-rgs';
import { commitmentOf } from '@slot/game-math';
import {
  MemoryLedger,
  MemoryRoundStore,
  RemoteWallet,
  SingleSessionHost,
  WalletSim,
  buildApp as buildRgsApp,
  buildWalletSimApp,
  committingSeedProvider,
  createGameConfig,
  createRoundService,
  seededBytes,
  spinFingerprint,
} from '@slot/rgs';
import { HttpTransport, MockTransport } from '@slot/transport';
import type { RgsTransport } from '@slot/transport';

/**
 * What a contract target is.
 *
 * The suite in `suite.ts` knows nothing about simulators, Fastify or Postgres — it holds an
 * `RgsTransport` and asks a control plane for the two things the wire deliberately does not carry:
 * a known starting point, and the server's own view of what happened. Everything else it asserts is
 * the contract in `docs/protocol.md`, which is the point: a target passes by *behaving*, not by
 * being built a particular way.
 *
 * Three targets are registered below. Two are the simulator, reached in-process and over a socket;
 * the third is `apps/rgs` — a named skip before R0, expected-red through it, and running the full
 * contract since R1. It is also the one target that declares `unresolvedRounds`: only a server
 * whose wallet lives outside its database can strand a debit (§5), so the case the simulators
 * skip by name finally runs here.
 */

/** The subset of fault injection the contract cares about. A real RGS supports none of it. */
export interface ContractFaults {
  latencyMs?: number;
  dropRate?: number;
  errorRates?: Partial<Record<ErrorCode, number>>;
}

export interface RoundSnapshot {
  roundId: string;
  state: RoundState;
  stake: Minor;
  cumulativeWin: Minor;
  steps: number;
}

/**
 * The server's own account of the session.
 *
 * The suite needs it to assert things the wire cannot say — that one press produced *one* round,
 * that a round is `SETTLED` and not merely reported as such. A target that cannot produce this
 * cannot be held to the contract, which is why it is part of the target rather than optional.
 */
export interface TargetSnapshot {
  balance: Minor;
  rounds: RoundSnapshot[];
}

export interface TargetHandle {
  /** The only thing a client ever holds. Every assertion in the suite goes through this. */
  readonly transport: RgsTransport;
  /** A fresh session with a known balance. Returns the token that now authenticates. */
  reset(options?: { balance?: Minor }): Promise<{ token: string; balance: Minor }>;
  faults(config: ContractFaults): Promise<void>;
  state(): Promise<TargetSnapshot>;
  /**
   * Leave a round debited but unresolved, and return its id — docs/protocol.md §5.
   *
   * Required of any target that declares `unresolvedRounds`, and impossible for the ones that do
   * not: a synchronous handler has no window between the debit and the outcome for a process to die
   * in. Only a real RGS can produce this state, which is why it is optional here rather than absent.
   */
  strand?(stake: Minor): Promise<string>;
  close(): Promise<void>;
}

export interface TargetCapabilities {
  /** `forceOutcome` is honoured — the only affordable way to reach a feature round. */
  forceOutcome: boolean;
  /** Faults can be demanded, which is the only way to *require* a `RECOVERABLE` error. */
  faultInjection: boolean;
  /**
   * The target can produce a round that was debited but never resolved — docs/protocol.md §5.
   *
   * Both simulator targets cannot: a handler is synchronous, so the debit and the resolve land in
   * the same call and there is no window for the process to die between them. Only a real RGS
   * (R1) can, so the case is declared here and skipped by name rather than quietly untested.
   */
  unresolvedRounds: boolean;
  /**
   * The target commits to its outcomes and reveals at the close (docs/protocol.md §9, R4).
   *
   * Mutually exclusive with `forceOutcome` by construction, not by accident: a server that will
   * play whatever it is told cannot publish a hash of an outcome it has not been told yet. The
   * simulators exist to be driven, so they are honest about the fairness they do not have.
   */
  provableFairness: boolean;
}

export interface StartOptions {
  /** Whether this instance honours `forceOutcome`. The dev gate is tested with `false`. */
  devMode: boolean;
  balance: Minor;
}

export interface ContractTarget {
  readonly name: string;
  readonly supports: TargetCapabilities;
  /** Set when the target cannot run yet. The suite reports the reason instead of passing quietly. */
  readonly unavailable?: string;
  /**
   * Set when the target runs but is not expected to pass the contract yet — `apps/rgs` between R0
   * and the R-blocks that fill it. The suite then runs the *red gate* instead: every call must be
   * refused with `NOT_IMPLEMENTED` and nothing else (ROADMAP Part III), which turns "the skeleton
   * is wired and honestly empty" into a green assertion rather than a red run CI has to ignore.
   */
  readonly expectedRed?: string;
  start(options: StartOptions): Promise<TargetHandle>;
}

/* ── the simulator, both ways ─────────────────────────────────────────────────────────────── */

/** Fixes the whole session's outcome sequence: the same round id always lands on the same stops. */
const SEED = 'contract-suite-seed';
/** 2100-01-01. Far enough away that no test is a clock away from being flaky. */
const EXPIRES_AT = 4_102_444_800_000;
const NOW = 1_700_000_000_000;

const simulatorFor = ({ devMode, balance }: StartOptions): SimServer =>
  new SimServer({
    initialState: createSimState({ serverSeed: SEED, balance, expiresAt: EXPIRES_AT }),
    config: createSimConfig({ devMode }),
    now: () => NOW,
  });

const freshState = (balance: Minor) =>
  createSimState({ serverSeed: SEED, balance, expiresAt: EXPIRES_AT });

const snapshotOf = (sim: SimServer): TargetSnapshot => ({
  balance: sim.state.balance,
  rounds: sim.state.rounds.map((round) => ({
    roundId: round.roundId,
    state: round.state,
    stake: round.stake,
    cumulativeWin: round.cumulativeWin,
    steps: round.steps.length,
  })),
});

const SIM_CAPABILITIES: TargetCapabilities = {
  forceOutcome: true,
  faultInjection: true,
  unresolvedRounds: false,
  provableFairness: false,
};

/**
 * `rgs-sim` in-process, through `MockTransport` — the dev default, and the fastest way to run the
 * whole contract.
 */
export const inProcessTarget: ContractTarget = {
  name: 'rgs-sim (in process)',
  supports: SIM_CAPABILITIES,
  start(options) {
    const sim = simulatorFor(options);
    const transport = new MockTransport({ backend: sim });

    return Promise.resolve({
      transport,
      reset: ({ balance = options.balance } = {}) => {
        sim.reset(freshState(balance));
        return Promise.resolve({ token: sim.state.token, balance: sim.state.balance });
      },
      faults: (config) => {
        sim.setFaults(config as FaultConfig);
        return Promise.resolve();
      },
      state: () => Promise.resolve(snapshotOf(sim)),
      close: () => Promise.resolve(),
    });
  },
};

/**
 * The same simulator over a real socket, through `HttpTransport`.
 *
 * The control plane is `apps/mock-rgs`'s `/dev/*` routes rather than a reference to the `SimServer`
 * object — deliberately, because a target the suite can only control by reaching inside it is a
 * target the suite cannot run against a separate process later.
 */
export const httpTarget: ContractTarget = {
  name: 'rgs-sim (over HTTP)',
  supports: SIM_CAPABILITIES,
  async start(options) {
    const sim = simulatorFor(options);
    const app = buildApp({ sim });
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

    const dev = async <T>(path: string, method: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as T;
    };

    return {
      transport: new HttpTransport({ baseUrl }),
      reset: ({ balance = options.balance } = {}) =>
        dev<{ token: string; balance: Minor }>('/dev/reset', 'POST', { balance }),
      faults: async (config) => {
        await dev('/dev/faults', 'PUT', config);
      },
      state: () => dev<TargetSnapshot>('/dev/state', 'GET'),
      close: () => app.close(),
    };
  },
};

/**
 * The real RGS — running the full contract since R1, in its full production shape since R2.
 *
 * Registered before it existed (a named skip), expected-red through R0 (`NOT_IMPLEMENTED` only,
 * asserted), a full target since R1, and since R2 the whole chain is real: the suite's client
 * speaks HTTP to `apps/rgs`, which speaks HTTP to a wallet — `RemoteWallet` with its timeouts and
 * bounded retries against the wallet sim (docs/wallet-api.md), exactly the composition a
 * deployment runs. The store stays in-memory: the gate is about the wire, and the shared
 * store-contract suite in `apps/rgs` holds Postgres to the memory semantics.
 *
 * The control plane is the composition itself, reached in-process: this server has no `/dev/*` by
 * design. Two things only this target can claim honestly: `strand()` — a debit whose round never
 * resolved (§5), possible because the wallet genuinely lives outside the store's transaction —
 * and, since R2, `faultInjection`: a `RECOVERABLE` failure is demanded by actually refusing the
 * wallet, not by simulating a refusal. `forceOutcome` stays false forever.
 */
export const realRgsTarget: ContractTarget = {
  name: 'apps/rgs',
  supports: {
    forceOutcome: false,
    faultInjection: true,
    unresolvedRounds: true,
    provableFairness: true,
  },
  async start(options) {
    const playerId = 'demo-player';
    const store = new MemoryRoundStore();
    const ledger = new MemoryLedger();
    const walletSim = new WalletSim({ [playerId]: options.balance });
    const walletApp = buildWalletSimApp(walletSim);
    const walletUrl = await walletApp.listen({ port: 0, host: '127.0.0.1' });
    const wallet = new RemoteWallet({ baseUrl: walletUrl, timeoutMs: 500, backoffMs: 1 });
    const sessions = new SingleSessionHost();
    // `devMode` is deliberately unread: this server has no such flag to set (§8), which is
    // exactly what the suite's dev-gate case asserts from the outside.
    const rounds = createRoundService({
      store,
      wallet,
      ledger,
      sessions,
      seeds: committingSeedProvider(seededBytes(SEED)),
      config: createGameConfig(),
      now: () => NOW,
    });
    const app = buildRgsApp({ rounds });
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

    let issued = 0;
    let stranded = 0;

    return {
      transport: new HttpTransport({ baseUrl }),
      reset: ({ balance = options.balance } = {}) => {
        store.clear();
        ledger.clear();
        walletSim.reset({ [playerId]: balance });
        const token = `contract-rgs-${(issued += 1)}`;
        sessions.issue(token, { playerId, currency: 'EUR', expiresAt: EXPIRES_AT });
        return Promise.resolve({ token, balance });
      },
      /**
       * Fault injection, the only way a production-shaped server can honestly offer it: break the
       * upstream. `WALLET_UNAVAILABLE` is enacted by refusing the real wallet; everything else the
       * sim targets can fake has no producer here and is refused loudly rather than ignored.
       */
      faults: (config) => {
        const { errorRates = {}, ...rest } = config;
        const codes = Object.keys(errorRates);
        const onlyWallet = codes.every((code) => code === 'WALLET_UNAVAILABLE');
        if (Object.keys(rest).length > 0 || !onlyWallet) {
          return Promise.reject(
            new Error('apps/rgs can only enact WALLET_UNAVAILABLE — by breaking its real wallet'),
          );
        }
        walletSim.setFaults({ refuse: (errorRates.WALLET_UNAVAILABLE ?? 0) > 0 });
        return Promise.resolve();
      },
      // Read directly from the sim, not over the wire: the account must stay readable while the
      // wallet is deliberately refusing.
      state: async () => ({
        balance: await walletSim.wallet.getBalance(playerId),
        rounds: store.snapshot().map((round) => ({
          roundId: round.roundId,
          state: round.state,
          stake: round.stake,
          cumulativeWin: round.cumulativeWin,
          steps: round.steps,
        })),
      }),
      /**
       * What a crash between the wallet debit and the store commit leaves behind — produced by
       * doing exactly those two things and stopping. The fingerprint must be the one the honest
       * retry will present, which is why the domain exports it.
       */
      strand: async (stake) => {
        const roundId = `018f0000-0000-7000-8000-${(stranded += 1).toString(16).padStart(12, '0')}`;
        // The stranded round crashed *after* its open, so it died holding a bound fairness pair —
        // a real one, because `authenticate` reports the commitment on the wire (§9).
        const serverSeed = `strand-server-seed-${stranded}`;
        await walletSim.wallet.debit(playerId, stake, roundId);
        await store.open({
          roundId,
          playerId,
          state: 'OPEN',
          stake,
          serverSeed,
          commitment: commitmentOf(serverSeed),
          fingerprint: spinFingerprint(stake, undefined, undefined),
          cumulativeWin: 0 as Minor,
          capped: false,
          steps: 0,
          openedAt: NOW,
        });
        return roundId;
      },
      close: async () => {
        await app.close();
        await walletApp.close();
      },
    };
  },
};

export const CONTRACT_TARGETS: readonly ContractTarget[] = [
  inProcessTarget,
  httpTarget,
  realRgsTarget,
];
