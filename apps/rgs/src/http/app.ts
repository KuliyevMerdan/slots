import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyServerOptions } from 'fastify';
import type { CallName } from '@slot/protocol';
import { CALLS, CALL_NAMES, SlotError, routeFor, statusOf, tokenOfBearer } from '@slot/protocol';
import { MATH_VERSION } from '@slot/game-math';
import { correlationOptions, echoCorrelation } from '../observability/correlation.js';
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
 */

export interface RateLimitOptions {
  /** Sustained calls per second, per session token. 0 disables this axis. */
  perTokenPerSecond?: number;
  /** Sustained calls per second, per client IP. 0 disables this axis. */
  perIpPerSecond?: number;
  /** Bucket depth — calls that may arrive at once before pacing applies. Default 2× the rate. */
  burst?: number;
}

export interface RgsAppOptions {
  logger?: FastifyServerOptions['logger'];
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
  /** Epoch ms, for the limiter's clock. Injected by tests; the composition passes the wall clock. */
  now?: () => number;
}

export function buildApp({
  logger = false,
  rounds,
  ready = true,
  operator,
  rateLimit,
  now = () => Date.now(),
}: RgsAppOptions): FastifyInstance {
  const app = Fastify({
    logger,
    ...correlationOptions,
    // The same two operational limits `apps/mock-rgs` carries, for the same reasons: the whole
    // protocol fits in hundreds of bytes, and a client that never finishes sending is not a client.
    bodyLimit: 16 * 1024,
    requestTimeout: 5_000,
  });

  echoCorrelation(app);

  app.setErrorHandler((error, request, reply) => {
    const failure = classifyError(error);
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
    request.log.warn({ err: error, code: failure.code }, failure.message);
    void reply.code(status).send(errorBody(failure, request.id));
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
      admit(request, token);
      return handle(call, request.body, token === undefined ? {} : { token });
    });
  }

  if (operator !== undefined) registerOperatorRoutes(app, operator);

  /** Liveness: the process is up and answering. Deliberately says nothing about the game. */
  app.get('/health', () => ({ status: 'ok' }));

  /**
   * Readiness — honest either way. `mathVersion` is here because it is the one field a deploy can
   * get wrong in a way nothing else notices: a client drawing reels the server is not playing.
   */
  app.get('/ready', (_request, reply) =>
    ready
      ? reply.code(200).send({ ready: true, gameId: RGS_GAME_ID, mathVersion: MATH_VERSION })
      : reply
          .code(503)
          .send({ ready: false, mathVersion: MATH_VERSION, reason: 'NOT_IMPLEMENTED (R1+)' }),
  );

  return app;
}
