import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { CallName } from '@slot/protocol';
import { CALLS, CALL_NAMES, SlotError, routeFor, statusOf } from '@slot/protocol';
import { MATH_VERSION } from '@slot/game-math';
import { correlationOptions, echoCorrelation } from '../observability/correlation.js';
import { notImplementedRounds } from '../domain/rounds.js';
import type { RoundService } from '../domain/rounds.js';
import { classifyError, errorBody } from './errors.js';

/**
 * `apps/rgs` — the real RGS, laid out before it is built.
 *
 * Every route this server will ever have exists now: registered from the same `CALLS` table
 * `HttpTransport` and `apps/mock-rgs` read, validated against the same `@slot/protocol` schemas
 * the client validates with, and answering `NOT_IMPLEMENTED` (§6, D10) from a domain that is not
 * there yet. The R-blocks replace `notImplementedRounds` with the real lifecycle — behind this
 * file's back, which is the point: the HTTP binding is finished before the first endpoint works,
 * and the contract suite watches the expected-red target go green endpoint by endpoint.
 *
 * The ordering inside `handle` is R0's one behavioural claim, and it is tested: **validation runs
 * before the stub throws.** A malformed request is `SCHEMA_MISMATCH` exactly as it will be
 * forever; only a request the contract accepts learns that the implementation is missing. The
 * refusal provably means "not built", never "not understood".
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
   * The domain, injected (the ADR-0003 shape). Defaults to the all-stubs service; R1 constructs
   * the real one from repositories, the wallet and the seed provider.
   */
  rounds?: RoundService;
}

export function buildApp({
  logger = false,
  rounds = notImplementedRounds(),
}: RgsAppOptions = {}): FastifyInstance {
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
   * Readiness — honest: this server cannot play a round yet, and a load balancer should know.
   * `mathVersion` is already the shipped math package's, because the day the domain lands it is
   * the one field a deploy can get wrong in a way nothing else notices.
   */
  app.get('/ready', (_request, reply) =>
    reply
      .code(503)
      .send({ ready: false, mathVersion: MATH_VERSION, reason: 'NOT_IMPLEMENTED (R1+)' }),
  );

  return app;
}
