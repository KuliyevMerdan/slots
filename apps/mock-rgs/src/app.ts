import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import type { CallName } from '@slot/protocol';
import { CALL_NAMES, CORRELATION_HEADER, SlotError, routeFor } from '@slot/protocol';
import type { SimServer } from '@slot/rgs-sim';
import { classifyFrameworkError, errorBody, statusOf } from './errors.js';
import { registerDevRoutes } from './dev.js';

/**
 * `apps/mock-rgs` — the simulator, over a real socket.
 *
 * It exists to prove one sentence: **the client runs identically against `MockTransport` and
 * `HttpTransport`, same behaviour, different latency.** Everything that decides anything — the
 * outcome, the round machine, idempotency, the fault verdict — is `@slot/rgs-sim` and is not
 * reimplemented here. This app parses a request, hands it to `SimServer.deliver`, and *enacts* what
 * comes back, which is the same job `MockTransport` does in-process.
 *
 * That split is the reason the HTTP path is worth having. If the network target had its own copy of
 * the rules, "swap the transport URL" would be a claim about two implementations agreeing; with one
 * core behind both, it is a claim about one implementation reached two ways.
 *
 * Routes come from `@slot/protocol`'s `CALLS` table rather than a hand-written list, so a fifth call
 * would be routed, validated and typed the moment it is added to the contract.
 */

const wait = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export interface MockRgsOptions {
  /** The simulator this server is a socket in front of. Injected — the app owns no game state. */
  sim: SimServer;
  logger?: FastifyServerOptions['logger'];
  /**
   * Whether `/dev/*` (fault injection, reset, state) is mounted. On by default because this is a
   * development server; `apps/rgs` will never have these routes at all.
   */
  devRoutes?: boolean;
  /** Injected so a test can assert an enacted latency without waiting it out. */
  sleep?: (ms: number) => Promise<void>;
}

export function buildApp({
  sim,
  logger = false,
  devRoutes = true,
  sleep = wait,
}: MockRgsOptions): FastifyInstance {
  const app = Fastify({
    logger,
    // The client mints the id and we adopt it; a request that arrives without one gets a uuid. Either
    // way `request.id` is what the log lines, the echoed header and the error bodies all carry.
    requestIdHeader: CORRELATION_HEADER,
    genReqId: () => randomUUID(),
  });

  /**
   * Sockets belonging to deliberately dropped responses.
   *
   * A dropped response is not an error the server sends — it is an answer that never arrives, which
   * over HTTP means holding the connection open and saying nothing. `reply.hijack()` is how you tell
   * Fastify to stop managing a reply it will never send. The sockets are tracked so shutdown can
   * destroy them; otherwise `close()` waits for connections that are, by construction, waiting
   * forever. See docs/adr/ADR-0004-http-binding.md.
   *
   * **Which hook does the destroying is load-bearing, and it was wrong until the HTTP soak found
   * it.** `onClose` runs *after* Fastify has stopped the server and begun waiting for open
   * connections to end — by which point destroying the sockets is too late and `close()` never
   * returns. `preClose` runs before that wait starts. The tracking was there and correct; the moment
   * it fired was not, and nothing noticed until a test tried to shut a server down with a hundred
   * abandoned responses in flight.
   */
  const hung = new Set<{ destroy?: () => void }>();

  app.addHook('onSend', (request, reply, _payload, done) => {
    reply.header(CORRELATION_HEADER, request.id);
    done();
  });

  app.addHook('preClose', (done) => {
    // `destroy` is optional because `app.inject()` runs the same route stack over a fake socket that
    // has no connection to end — the test double for a hung request is simply a reply nobody sends.
    for (const socket of hung) socket.destroy?.();
    hung.clear();
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    const failure = classifyFrameworkError(error);
    request.log.warn(
      { err: error, code: failure.code },
      'request failed before the simulator saw it',
    );
    void reply.code(statusOf(failure.code)).send(errorBody(failure, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    // `SCHEMA_MISMATCH` — FATAL — because a client asking for a route this server does not have is a
    // client built against a different contract, and retrying cannot make the route appear.
    const failure = new SlotError(
      'SCHEMA_MISMATCH',
      `no route for ${request.method} ${request.url}`,
    );
    void reply.code(404).send(errorBody(failure, request.id));
  });

  const handle = async (
    call: CallName,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const delivery = sim.deliver(call, request.body);

    if (delivery.kind === 'DROP') {
      request.log.warn(
        { call, fault: 'DROP' },
        'injected fault: the call was executed and its response will never arrive',
      );
      const socket: { destroy?: () => void; once?: (event: string, listener: () => void) => void } =
        request.raw.socket;
      hung.add(socket);
      socket.once?.('close', () => hung.delete(socket));
      reply.hijack();
      return;
    }

    // The simulator decided how long this takes; a pure package cannot sleep, so we do it here —
    // the same delay `MockTransport` awaits in-process.
    await sleep(delivery.delayMs);

    if (delivery.kind === 'REJECT') {
      const { error } = delivery;
      request.log.warn(
        { call, code: error.code, simCorrelationId: error.correlationId, roundId: error.roundId },
        error.message,
      );
      await reply.code(statusOf(error.code)).send(errorBody(error, request.id));
      return;
    }

    await reply.code(200).send(delivery.response);
  };

  for (const call of CALL_NAMES) {
    // The body is `unknown` on purpose: `SimServer` validates it with the same `@slot/protocol`
    // schema the client validated against, and a second validation here would be a second place for
    // the contract to live.
    app.post(routeFor(call), (request, reply) => handle(call, request, reply));
  }

  /** Liveness: the process is up and answering. Deliberately says nothing about the game. */
  app.get('/health', () => ({ status: 'ok' }));

  /**
   * Readiness: what game this server is serving.
   *
   * `mathVersion` is here because it is the one field a deploy can get wrong in a way nothing else
   * notices — a client drawing reels the server is not playing.
   */
  app.get('/ready', () => ({
    ready: true,
    gameId: sim.config.gameId,
    mathVersion: sim.config.mathVersion,
    jurisdiction: sim.config.jurisdiction,
    devMode: sim.config.devMode,
    currency: sim.state.session.currency,
  }));

  /**
   * The operator's lobby, faked (docs/protocol.md §7).
   *
   * Not behind `devRoutes`: without it there is no way to obtain a token at all, and a server you
   * cannot authenticate against is not a server. `apps/rgs` replaces this with real session
   * validation in R5.
   */
  app.post('/demo/session', () => ({ token: sim.state.token }));

  if (devRoutes) registerDevRoutes(app, sim);

  return app;
}
