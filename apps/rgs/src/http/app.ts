import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { CallName } from '@slot/protocol';
import { CALLS, CALL_NAMES, SlotError, routeFor, statusOf } from '@slot/protocol';
import { MATH_VERSION } from '@slot/game-math';
import { correlationOptions, echoCorrelation } from '../observability/correlation.js';
import type { RoundService } from '../domain/rounds.js';
import { RGS_GAME_ID } from '../config.js';
import { classifyError, errorBody } from './errors.js';

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
 * `/demo/session` (tokens come from the operator's lobby — §7; R5 builds the validation half),
 * and any import of `@slot/rgs-sim` or `@slot/transport` — the first would make the skeleton lean
 * on the thing it exists to replace, the second would put the client's seam inside the server.
 * Both are dependency-cruiser errors, tested by fixture.
 */

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
}

export function buildApp({ logger = false, rounds, ready = true }: RgsAppOptions): FastifyInstance {
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

  const handle = async <N extends CallName>(call: N, body: unknown): Promise<unknown> => {
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
    return rounds[call](parsed.data as never);
  };

  for (const call of CALL_NAMES) {
    app.post(routeFor(call), (request) => handle(call, request.body));
  }

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
