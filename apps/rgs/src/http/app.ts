import Fastify, { LogController } from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyServerOptions } from 'fastify';
import type { Tracer } from '@opentelemetry/api';
import type { CallName } from '@slot/protocol';
import {
  CALLS,
  CALL_NAMES,
  SlotError,
  classOf,
  routeFor,
  statusOf,
  tokenOfBearer,
} from '@slot/protocol';
import { MATH_VERSION } from '@slot/game-math';
import { correlationOptions, echoCorrelation } from '../observability/correlation.js';
import { createRgsMetrics } from '../observability/metrics.js';
import type { RgsMetrics } from '../observability/metrics.js';
import { defaultTracer, inCallSpan } from '../observability/tracing.js';
import type { Caller, RoundService } from '../domain/rounds.js';
import { RGS_GAME_ID } from '../config.js';
import { classifyError, errorBody } from './errors.js';
import { registerOperatorRoutes } from './operator.js';
import type { OperatorOptions } from './operator.js';
import { TokenBucketLimiter } from './rate-limit.js';

/**
 * `apps/rgs` — the real RGS's HTTP binding.
 *
 * Every route is registered from the same `CALLS` table `HttpTransport` and `apps/mock-rgs` read,
 * and validated against the same `@slot/protocol` schemas the client validates with. The domain
 * behind the routes is injected: R0 wired these routes to `notImplementedRounds` and the contract
 * suite held the answers to `NOT_IMPLEMENTED` (§6, D10); R1 replaced the injection with the real
 * `createRoundService` — and this file did not change, which was the point of building it first.
 *
 * The ordering inside `handle` is still the binding's one claim of its own, and still tested:
 * **validation runs before the domain is reached.** A malformed request is `SCHEMA_MISMATCH`
 * whatever the domain has to say — "not understood" and "refused" stay distinguishable.
 *
 * What is deliberately absent, and stays absent: `/dev/*` (a production server is not driveable),
 * `/demo/session` (tokens come from the operator's lobby — §7; since R5 the lobby's face here is
 * `/operator/sessions`, key-guarded and outside the game contract), and any import of
 * `@slot/rgs-sim` or `@slot/transport` — the first would make the skeleton lean on the thing it
 * exists to replace, the second would put the client's seam inside the server. Both are
 * dependency-cruiser errors, tested by fixture.
 *
 * Since R5 the binding also *identifies*: every game route reads the `Authorization` bearer
 * header (§2.7, D12) and hands the domain a `Caller`, and the game routes sit behind a token
 * bucket per session token and per IP — refused as `RATE_LIMITED` with `retryAfterMs`, which is
 * the code the client's retry policy already honours.
 *
 * Since R6 the binding also *narrates* (ADR-0008): every answered game call is one structured
 * line with the call name and the `roundId` on it, one SERVER span keyed `rgs.round_id`, and one
 * histogram observation — the same request id the correlation header echoes appears in all
 * three, so one `roundId` retrieves the round's story across logs, traces and metrics. `/metrics`
 * renders the instruments; `/ready` asks the composition's named probes (the store, the wallet)
 * and answers 503 naming the check that failed.
 */

export interface RateLimitOptions {
  /** Sustained calls per second, per session token. 0 disables this axis. */
  perTokenPerSecond?: number;
  /** Sustained calls per second, per client IP. 0 disables this axis. */
  perIpPerSecond?: number;
  /** Bucket depth — calls that may arrive at once before pacing applies. Default 2× the rate. */
  burst?: number;
}

/** One readiness probe: a named dependency and the question that proves it answers. */
export interface ReadinessCheck {
  readonly name: string;
  readonly check: () => Promise<unknown>;
}

export interface ObservabilityOptions {
  /** The span source. Absent, the OTel API's no-op — zero overhead, nothing to configure. */
  tracer?: Tracer;
  /** The instruments `/metrics` renders. Absent, a fresh bundle with no round-state gauge. */
  metrics?: RgsMetrics;
  /** What `/ready` pings — the composition names its dependencies (store, wallet). */
  readiness?: readonly ReadinessCheck[];
  /** How long one probe may take before it counts as failed. */
  readinessTimeoutMs?: number;
}

export interface RgsAppOptions {
  logger?: FastifyServerOptions['logger'];
  /**
   * A ready-made pino instance, when the composition needs the same logger in two places — the
   * observer speaks through it and Fastify logs through it, so one round's lines interleave in
   * one stream. Wins over `logger` when both are given.
   */
  loggerInstance?: FastifyServerOptions['loggerInstance'];
  /**
   * The domain, injected (the ADR-0003 shape). Required since R1: the real service exists, so a
   * silent all-stubs default would be a server that answers 501 because somebody forgot an
   * argument. A composition that genuinely has no domain passes `notImplementedRounds()` and says
   * so.
   */
  rounds: RoundService;
  /**
   * What `/ready` reports. `true` belongs to a composition whose domain can actually play a round;
   * the stub composition passes `false`. A load balancer reads this, so it is an argument rather
   * than a guess.
   */
  ready?: boolean;
  /**
   * The operator surface (§7, R5). Absent, the routes are not mounted — a composition with no
   * out-of-band channel has no lobby to serve, and an unguardable endpoint beats a misguarded one.
   */
  operator?: OperatorOptions;
  /**
   * Rate limiting on the game routes (R5). Absent, none — tests and the contract suite hammer by
   * design; `main.ts` always passes the env-configured budgets, so a deployment is always limited.
   */
  rateLimit?: RateLimitOptions;
  /**
   * The R6 surface: spans, `/metrics` instruments, `/ready` probes. Every part defaults to
   * something honest — a no-op tracer, a fresh registry, no probes — so a test composition pays
   * nothing for what it does not read.
   */
  observability?: ObservabilityOptions;
  /** Epoch ms, for the limiter's clock. Injected by tests; the composition passes the wall clock. */
  now?: () => number;
}

/** The body's `roundId`, read before validation — the join key an error line deserves too. */
const roundIdOf = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const { roundId } = body as { roundId?: unknown };
  return typeof roundId === 'string' ? roundId : undefined;
};

/** Race a probe against its budget; the loser is a named failure, not a hung `/ready`. */
const within = async (ms: number, work: Promise<unknown>): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no answer within ${ms}ms`));
        }, ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export function buildApp({
  logger = false,
  loggerInstance,
  rounds,
  ready = true,
  operator,
  rateLimit,
  observability,
  now = () => Date.now(),
}: RgsAppOptions): FastifyInstance {
  const {
    tracer = defaultTracer(),
    metrics = createRgsMetrics(),
    readiness = [],
    readinessTimeoutMs = 2_000,
  } = observability ?? {};

  const app = Fastify({
    ...(loggerInstance === undefined ? { logger } : { loggerInstance }),
    // Fastify's own two lines per request say nothing this binding's access line does not say
    // better — ours carries the call name and the roundId, which is R6's whole point.
    logController: new LogController({ disableRequestLogging: true }),
    ...correlationOptions,
    // The same two operational limits `apps/mock-rgs` carries, for the same reasons: the whole
    // protocol fits in hundreds of bytes, and a client that never finishes sending is not a client.
    bodyLimit: 16 * 1024,
    requestTimeout: 5_000,
  });

  echoCorrelation(app);

  /** Route path → call name, for the hooks that see a URL and owe a label. */
  const callOfRoute = new Map<string, CallName>(CALL_NAMES.map((call) => [routeFor(call), call]));

  app.setErrorHandler((error, request, reply) => {
    const failure = classifyError(error);
    const call = callOfRoute.get(request.routeOptions.url ?? '');
    const roundId = failure.roundId ?? roundIdOf(request.body);
    metrics.errorsTotal.inc({
      call: call ?? 'other',
      code: failure.code,
      class: classOf(failure.code),
    });
    // The framework's own status (a 413, a 415) survives when it is more specific than the
    // taxonomy's mapping — the status is for operators; the client reads the class in the body.
    // Neither `NotImplementedError` nor a `SlotError` carries one, so both take `statusOf`.
    const { statusCode } = error as { statusCode?: number };
    const status =
      statusCode !== undefined && statusCode >= 400 ? statusCode : statusOf(failure.code);
    if (failure.retryAfterMs !== undefined) {
      // The header form of the body's `retryAfterMs` (§2.7: `429` honours `Retry-After`) — for
      // the proxies and generic clients that never read a protocol body.
      void reply.header('retry-after', Math.ceil(failure.retryAfterMs / 1_000).toString(10));
    }
    request.log.warn(
      {
        err: error,
        ...(call === undefined ? {} : { call }),
        ...(roundId === undefined ? {} : { roundId }),
        code: failure.code,
        class: classOf(failure.code),
      },
      failure.message,
    );
    void reply.code(status).send(errorBody(failure, request.id));
  });

  /*
   * One line and two instruments per answered game call. The success line lives here rather than
   * in the handler because only the response knows its own duration; a refused call already got
   * its richer line from the error handler, so it takes the instruments alone.
   */
  app.addHook('onResponse', (request, reply, done) => {
    const call = callOfRoute.get(request.routeOptions.url ?? '');
    if (call === undefined) {
      done();
      return;
    }
    const durationMs = reply.elapsedTime;
    metrics.callDuration.observe({ call }, durationMs / 1_000);
    const failed = reply.statusCode >= 400;
    metrics.callsTotal.inc({ call, outcome: failed ? 'error' : 'ok' });
    if (!failed) {
      const roundId = roundIdOf(request.body);
      request.log.info(
        {
          call,
          ...(roundId === undefined ? {} : { roundId }),
          statusCode: reply.statusCode,
          durationMs,
        },
        `${call}: ok`,
      );
    }
    done();
  });

  app.setNotFoundHandler((request, reply) => {
    // A client asking for a route this server does not have is a client built against a different
    // contract — `SCHEMA_MISMATCH`, not `NOT_IMPLEMENTED`: the latter is reserved for routes the
    // contract *does* have, so the two states stay distinguishable on the wire.
    const failure = new SlotError(
      'SCHEMA_MISMATCH',
      `no route for ${request.method} ${request.url}`,
    );
    void reply.code(404).send(errorBody(failure, request.id));
  });

  /* ── rate limiting (R5) ─────────────────────────────────────────────────────────────────
   * Checked before validation, deliberately: the budget is what protects the validator too. The
   * IP axis admits first — a caller flooding with someone else's token still spends its own IP
   * budget — then the token axis, when the request carries a binding.
   */
  const axis = (rate: number | undefined, burst: number | undefined) =>
    rate === undefined || rate <= 0
      ? undefined
      : new TokenBucketLimiter({
          capacity: Math.max(1, burst ?? rate * 2),
          refillPerSecond: rate,
          now,
        });
  const perIp = axis(rateLimit?.perIpPerSecond, rateLimit?.burst);
  const perToken = axis(rateLimit?.perTokenPerSecond, rateLimit?.burst);

  const admit = (request: FastifyRequest, token: string | undefined): void => {
    for (const [limiter, key] of [
      [perIp, request.ip],
      [perToken, token],
    ] as const) {
      if (limiter === undefined || key === undefined) continue;
      const verdict = limiter.take(key);
      if (!verdict.allowed) {
        throw new SlotError('RATE_LIMITED', 'too many requests — slow down', {
          retryAfterMs: verdict.retryAfterMs,
        });
      }
    }
  };

  const handle = async <N extends CallName>(
    call: N,
    body: unknown,
    caller: Caller,
  ): Promise<unknown> => {
    const parsed = CALLS[call].req.safeParse(body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new SlotError('SCHEMA_MISMATCH', `${call}: ${detail}`);
    }
    // Understood, validated — and only now allowed to discover the domain is not built (R0's
    // ordering claim). The cast is the usual seam of a keyed dispatch: `parsed.data` is exactly
    // `CallRequest<N>`, but TypeScript cannot carry `N` through the `CALLS[call]` indexing.
    return rounds[call](parsed.data as never, caller);
  };

  for (const call of CALL_NAMES) {
    app.post(routeFor(call), (request) => {
      // The session binding, read once per request (§2.7, D12): the same token keys the limiter
      // and names the caller's session in the domain.
      const token = tokenOfBearer(request.headers.authorization);
      const roundId = roundIdOf(request.body);
      // The call span (R6): `rgs.round_id` is the join key across logs, traces and metrics, and
      // the correlation id ties the span to the very line the error handler writes. Wallet child
      // spans nest under this one through the active context.
      return inCallSpan(
        tracer,
        call,
        {
          'rgs.call': call,
          'rgs.correlation_id': request.id,
          ...(roundId === undefined ? {} : { 'rgs.round_id': roundId }),
        },
        () => {
          admit(request, token);
          return handle(call, request.body, {
            ...(token === undefined ? {} : { token }),
            correlationId: request.id,
          });
        },
      );
    });
  }

  if (operator !== undefined) registerOperatorRoutes(app, operator);

  /** Liveness: the process is up and answering. Deliberately says nothing about the game. */
  app.get('/health', () => ({ status: 'ok' }));

  /** The instruments, in the exposition format every scraper reads (R6). */
  app.get('/metrics', async (_request, reply) => {
    const text = await metrics.registry.render();
    return reply.type('text/plain; version=0.0.4').send(text);
  });

  /**
   * Readiness — honest either way, and since R6 honest about the *dependencies*: each probe the
   * composition named is asked (the store, the wallet), and one failing turns the answer 503 with
   * the failing check named, because a load balancer routing spins at a server whose wallet is
   * down is manufacturing `WALLET_UNAVAILABLE` at scale. `mathVersion` is here because it is the
   * one field a deploy can get wrong in a way nothing else notices: a client drawing reels the
   * server is not playing.
   */
  app.get('/ready', async (_request, reply) => {
    if (!ready) {
      return reply
        .code(503)
        .send({ ready: false, mathVersion: MATH_VERSION, reason: 'NOT_IMPLEMENTED (R1+)' });
    }
    const results = await Promise.all(
      readiness.map(async ({ name, check }) => {
        try {
          await within(readinessTimeoutMs, check());
          return { name, status: 'ok' };
        } catch (error) {
          return {
            name,
            status: `failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
    );
    const allOk = results.every(({ status }) => status === 'ok');
    return reply.code(allOk ? 200 : 503).send({
      ready: allOk,
      gameId: RGS_GAME_ID,
      mathVersion: MATH_VERSION,
      ...(results.length === 0
        ? {}
        : { checks: Object.fromEntries(results.map(({ name, status }) => [name, status])) }),
    });
  });

  return app;
}
