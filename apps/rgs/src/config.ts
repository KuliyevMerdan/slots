import { z } from 'zod';
import type { GameConfig, JurisdictionId, JurisdictionRules, Minor } from '@slot/protocol';
import { JURISDICTION_PRESETS } from '@slot/protocol';
import { BET_LEVELS, MATH_CONFIG } from '@slot/game-math';

/**
 * The environment, validated like anything else that crosses a boundary — the same discipline as
 * `apps/mock-rgs`. There is deliberately no seed variable: since R4 the fairness chain runs on
 * the CSPRNG (`main.ts` injects `node:crypto`), so there is nothing to configure and nothing to
 * leak. Postgres arrives through `RGS_DATABASE_URL` (R1) — set, it selects the Postgres store;
 * absent, the in-memory store, which is what the dev loop and the contract suite run on.
 */

/**
 * An optional variable that treats the empty string as absence — because a compose file's
 * `${VAR:-}` and a CI matrix's unset-but-exported both deliver `""`, and a server that reads an
 * empty string as "there is a wallet at (empty URL)" fails somewhere far less legible than here.
 */
const optional = () =>
  z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional());

const EnvSchema = z.object({
  /**
   * Which contract the boot holds the environment to (R7, ADR-0009). Development fills every gap
   * with a placeholder so `pnpm dev:rgs` just works; production refuses to start unless the
   * placeholders are gone — see `hardenEnv`, which names every violation at once.
   */
  RGS_ENV: z.enum(['development', 'production']).default('development'),
  RGS_PORT: z.coerce.number().int().min(0).max(65_535).default(8788),
  RGS_HOST: z.string().min(1).default('127.0.0.1'),
  RGS_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  /**
   * The demo session this server issues to itself at boot (§7: tokens are issued out of band, and
   * in development the environment *is* the out-of-band channel). Since R5 it goes through the
   * same session service the operator surface uses — one issuing path, two channels. Optional
   * since R7: development falls back to the well-known placeholder, production refuses the
   * placeholder and treats absence as "no demo session — tokens come from `/operator/sessions`".
   */
  RGS_DEMO_TOKEN: optional(),
  RGS_SESSION_HOURS: z.coerce.number().min(0.1).default(12),
  /**
   * The shared key `/operator/sessions` requires in `x-operator-key` (§7, R5). The default is a
   * dev placeholder by design; `hardenEnv` is where production stops accepting it (R7).
   */
  RGS_OPERATOR_KEY: z.string().min(8).default('rgs-operator-dev-key'),
  /**
   * A second listener for `GET /metrics` (R7). Set, the game listener stops serving the scrape —
   * an operator's perimeter guards infrastructure ports differently from player ports. Absent,
   * `/metrics` stays on the game listener, which is right for dev and scrape-inside-the-perimeter.
   */
  RGS_METRICS_PORT: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().min(1).max(65_535).optional(),
  ),
  /** Rate limits on the game routes (R5), sustained calls/second. 0 disables an axis. */
  RGS_RATE_LIMIT_PER_TOKEN: z.coerce.number().min(0).default(20),
  RGS_RATE_LIMIT_PER_IP: z.coerce.number().min(0).default(50),
  /** Bucket depth — calls that may arrive at once before the sustained rate applies. */
  RGS_RATE_LIMIT_BURST: z.coerce.number().min(1).default(60),
  /** Demo wallet balance, minor units — the MockWallet's until R2 integrates a real provider. */
  RGS_BALANCE: z.coerce.number().int().min(0).default(1_000_000),
  /** postgres://… — selects the Postgres store. Absent means in-memory. */
  RGS_DATABASE_URL: optional(),
  /**
   * Base URL of an operator wallet speaking docs/wallet-api.md — selects `RemoteWallet` with its
   * timeouts and bounded retries. Absent means the in-process `MockWallet` (dev and demo).
   */
  RGS_WALLET_URL: optional(),
  /** How often the ledger is trued against the wallet (R3). 0 disables the job. */
  RGS_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  /**
   * Where OTel spans go (R6) — the standard OTLP/HTTP variable, spelled the way every collector
   * documents it. Set, `main.ts` registers a real tracer provider and exports; absent, the OTel
   * API stays a no-op and the server pays nothing for the seam (ADR-0008).
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: optional(),
});

export type RgsEnv = z.infer<typeof EnvSchema>;

export const readEnv = (env: NodeJS.ProcessEnv = process.env): RgsEnv => {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid environment for @slot/rgs — ${detail}`);
  }
  return parsed.data;
};

/* ── the boot contract (R7, ADR-0009) ─────────────────────────────────────────────────────────
 * The schema above says what each variable *is*; this says what a composition may *run with*.
 * Development fills the gaps so the dev loop needs zero configuration. Production refuses them —
 * every violation named in one error, because an ops engineer fixing a deploy at 2am should not
 * discover the failures one restart at a time.
 */

/** The placeholders development runs on. Public by definition — which is why production refuses them. */
export const DEV_DEMO_TOKEN = 'rgs-demo-token';
export const DEV_OPERATOR_KEY = 'rgs-operator-dev-key';

export interface BootEnv extends RgsEnv {
  /** The demo session to issue at boot — absent means none, the production default (§7). */
  readonly demoToken?: string;
}

export const hardenEnv = (env: RgsEnv): BootEnv => {
  if (env.RGS_ENV !== 'production') {
    // Development: the environment is the out-of-band channel (§7), and the placeholder is the
    // channel's default message.
    return { ...env, demoToken: env.RGS_DEMO_TOKEN ?? DEV_DEMO_TOKEN };
  }

  const violations: string[] = [];
  if (env.RGS_DATABASE_URL === undefined) {
    violations.push(
      'RGS_DATABASE_URL must be set — the in-memory store forgets every round and its money on restart',
    );
  }
  if (env.RGS_WALLET_URL === undefined) {
    violations.push(
      'RGS_WALLET_URL must be set — the in-process mock wallet is play money living inside the game process',
    );
  }
  if (env.RGS_OPERATOR_KEY === DEV_OPERATOR_KEY) {
    violations.push('RGS_OPERATOR_KEY is the public dev placeholder — mint a real key');
  } else if (env.RGS_OPERATOR_KEY.length < 24) {
    violations.push('RGS_OPERATOR_KEY must be at least 24 characters in production');
  }
  if (env.RGS_DEMO_TOKEN === DEV_DEMO_TOKEN) {
    violations.push(
      'RGS_DEMO_TOKEN is the public dev placeholder — unset it (tokens then come only from /operator/sessions) or mint a real one',
    );
  }
  if (violations.length > 0) {
    throw new Error(
      `refusing to start: production accepts no dev defaults (R7)\n  - ${violations.join('\n  - ')}`,
    );
  }

  return { ...env, ...(env.RGS_DEMO_TOKEN === undefined ? {} : { demoToken: env.RGS_DEMO_TOKEN }) };
};

/* ── the served GameConfig ────────────────────────────────────────────────────────────────────
 * `@slot/game-math` owns the math half — strips, paylines, paytable, `mathVersion` — and this
 * file adds the commercial half, exactly the seam the simulator has (`createSimConfig`). The two
 * servers deliberately publish the same defaults today; they are two *configurations*, not two
 * copies of the math, and an operator config diverging them is the intended future.
 */

export const RGS_GAME_ID = 'aurora-reels';

const firstBetLevel = BET_LEVELS[0];
const lastBetLevel = BET_LEVELS[BET_LEVELS.length - 1];

if (firstBetLevel === undefined || lastBetLevel === undefined) {
  throw new RangeError('@slot/game-math exported an empty BET_LEVELS');
}

/** The payout ceiling, as a multiple of the stake played — see the sim's twin for the argument. */
export const RGS_MAX_WIN_MULTIPLIER = 5_000;

export interface GameConfigOptions {
  gameId?: string;
  jurisdiction?: JurisdictionId;
  jurisdictionRules?: JurisdictionRules;
  minStake?: Minor;
  maxStake?: Minor;
  maxWinMultiplier?: number;
}

/**
 * Note what is *not* an option: `devMode`. This server never honours `forceOutcome` — there is no
 * flag to set, so there is no flag to mis-set (docs/protocol.md §8).
 */
export const createGameConfig = ({
  gameId = RGS_GAME_ID,
  jurisdiction = 'DEFAULT',
  jurisdictionRules = JURISDICTION_PRESETS[jurisdiction],
  minStake = firstBetLevel,
  maxStake = lastBetLevel,
  maxWinMultiplier = RGS_MAX_WIN_MULTIPLIER,
}: GameConfigOptions = {}): GameConfig => ({
  gameId,
  ...MATH_CONFIG,
  strips: MATH_CONFIG.strips.map((strip) => [...strip]),
  paytable: MATH_CONFIG.paytable.map((entry) => ({ ...entry, pays: [...entry.pays] })),
  paylines: MATH_CONFIG.paylines.map((line) => [...line]),
  betLevels: [...BET_LEVELS],
  limits: { minStake, maxStake, maxWinMultiplier },
  jurisdiction,
  jurisdictionRules: { ...jurisdictionRules },
  devMode: false,
});
