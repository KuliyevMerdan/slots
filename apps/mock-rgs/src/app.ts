import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import type { CallName } from '@slot/protocol';
import { CALL_NAMES, CORRELATION_HEADER, SlotError, routeFor, tokenOfBearer } from '@slot/protocol';
import type { SimServer } from '@slot/rgs-sim';
import { z } from 'zod';
import { classifyFrameworkError, errorBody, statusOf } from './errors.js';
import { registerDevRoutes } from './dev.js';
import { SessionPool } from './sessions.js';
import type { Session, VisitorPolicy } from './sessions.js';

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

const tokenInBody = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const { token } = body as { token?: unknown };
  return typeof token === 'string' ? token : undefined;
};

const wait = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export interface MockRgsOptions {
  /**
   * The resident simulator — the session a call without a credential reaches, and the only one
   * there is unless `visitors` says otherwise. Injected — the app owns no game state.
   */
  sim: SimServer;
  /**
   * When set, the demo lobby begins a separate simulator for each visitor (`sessions.ts`), and
   * every call reaches the one its token names. Absent, the server is the single-session
   * development server it always was: the lobby renews the resident. `main.ts` always sets it;
   * the suites that test a protocol rather than a deployment leave it off.
   */
  visitors?: VisitorPolicy;
  logger?: FastifyServerOptions['logger'];
  /**
   * Whether `/dev/*` (fault injection, reset, state) is mounted. On by default because this is a
   * development server; `apps/rgs` will never have these routes at all.
   */
  devRoutes?: boolean;
  /** Injected so a test can assert an enacted latency without waiting it out. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * When set, the built client is served from this directory at `/` — the same origin the game
   * API lives on, which is the whole deploy shape (ADR-0010): one process, one origin, zero CORS
   * headers. Off by default; in development Vite serves the client and proxies `/rgs` here.
   */
  staticDir?: string;
  /**
   * Per-IP budget over every route except the healthchecks. Absent by default because the test
   * suites hammer on purpose — the same arrangement `apps/rgs` made in R5 — and `main.ts` always
   * passes the env-configured one.
   */
  rateLimit?: { max: number; timeWindowMs: number };
  /**
   * Whether `X-Forwarded-For` decides `request.ip`. False by default; a deploy behind a
   * platform's proxy must say true, or every player shares the proxy's one rate-limit bucket.
   */
  trustProxy?: boolean;
}

/**
 * What the lobby may be asked: nothing, or to renew the session a token names. Lenient on purpose
 * about *absence* (a bare `POST` is how every client before this one asked) and strict about
 * shape, like the rest of the control plane.
 */
const LobbyRequestSchema = z.object({ token: z.string().min(1).optional() }).strict();

export function buildApp({
  sim,
  visitors,
  logger = false,
  devRoutes = true,
  sleep = wait,
  staticDir,
  rateLimit,
  trustProxy = false,
}: MockRgsOptions): FastifyInstance {
  const app = Fastify({
    logger,
    trustProxy,
    // The client mints the id and we adopt it; a request that arrives without one gets a uuid. Either
    // way `request.id` is what the log lines, the echoed header and the error bodies all carry.
    requestIdHeader: CORRELATION_HEADER,
    genReqId: () => randomUUID(),
    // The whole protocol fits in hundreds of bytes, so anything approaching this limit is not a
    // client of this game. Fastify's default is 1 MiB, which on a public socket is an invitation.
    bodyLimit: 16 * 1024,
    // How long a client may take to *send* a request (Node's server.requestTimeout). It ends the
    // half-open connection that never finishes its body; it does not touch a hijacked reply, whose
    // request arrived in full — the DROP fault still hangs for as long as the test wants it to.
    requestTimeout: 5_000,
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

  const sessions = new SessionPool(sim, visitors);

  /**
   * Which simulator a request is for. `authenticate` names its session in the body; every other
   * call names it in the bearer header `HttpTransport` carries (§2.7) — and so does the debug
   * panel, so a visitor's fault injection reaches that visitor alone. A request with no credential
   * reaches the resident: the development server's single session, which is what the tests and a
   * developer's `curl` have always talked to. A credential this server does not hold is
   * `SESSION_EXPIRED` — the one answer a client already knows how to recover from.
   */
  const sessionOf = (request: FastifyRequest, call?: CallName): Session | SlotError => {
    const token =
      call === 'authenticate'
        ? tokenInBody(request.body)
        : tokenOfBearer(request.headers.authorization);
    if (token === undefined) return sessions.resident;
    return (
      sessions.find(token) ??
      new SlotError('SESSION_EXPIRED', 'this server holds no session for that token')
    );
  };

  if (rateLimit !== undefined) {
    void app.register(fastifyRateLimit, {
      max: rateLimit.max,
      timeWindow: rateLimit.timeWindowMs,
      // Healthchecks are the one legitimate high-frequency caller: a platform that polls /ready
      // into a 429 marks a healthy server down and restarts it for answering honestly.
      allowList: (request) => request.url === '/health' || request.url === '/ready',
      // The refusal is the taxonomy's, not the plugin's: RATE_LIMITED is RECOVERABLE, and the
      // body carries retryAfterMs because the server's arithmetic beats the client's backoff
      // guess (§6). The plugin *throws* what this returns, so it returns the `SlotError` itself
      // and the error handler below sends it the way the simulator's own refusals go out; the
      // plugin has already set the Retry-After header for everything that is not the client.
      errorResponseBuilder: (_request, context) =>
        new SlotError('RATE_LIMITED', 'too many requests — slow down', {
          retryAfterMs: context.ttl,
        }),
    });
  }

  if (staticDir !== undefined) {
    // The C8 deploy shape (ADR-0010): the built client and the game API share one origin, so the
    // CORS question never opens. The game routes are registered explicitly and win over the
    // wildcard; a missing file falls through to the not-found handler like any unknown route.
    void app.register(fastifyStatic, { root: resolve(staticDir) });
  }

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
    // A SlotError thrown inside the framework — the rate limiter's refusal — is not a framework
    // failure to classify but a refusal this server meant, and it goes to the wire exactly as the
    // simulator's own rejections do: status from the taxonomy, the payload's shape unchanged.
    if (error instanceof SlotError) {
      request.log.warn({ code: error.code }, error.message);
      void reply.code(statusOf(error.code)).send(errorBody(error, request.id));
      return;
    }
    const failure = classifyFrameworkError(error);
    // The status is for operators (ADR-0004), so the framework's own — a 413, a 415 — survives when
    // it is more specific than the taxonomy's generic mapping. The client never reads it; it
    // branches on the class in the body.
    const { statusCode } = error as { statusCode?: number };
    const status =
      statusCode !== undefined && statusCode >= 400 ? statusCode : statusOf(failure.code);
    request.log.warn(
      { err: error, code: failure.code },
      'request failed before the simulator saw it',
    );
    void reply.code(status).send(errorBody(failure, request.id));
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
    const session = sessionOf(request, call);
    if (session instanceof SlotError) {
      request.log.warn({ call, code: session.code }, session.message);
      await reply.code(statusOf(session.code)).send(errorBody(session, request.id));
      return;
    }
    const delivery = session.sim.deliver(call, request.body);

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

  // The routes live in a child plugin so that avvio loads them *after* the rate limiter above —
  // a Fastify hook applies only to routes registered after it exists, and a route added
  // synchronously here would be added before the queued plugin boots. The child inherits the
  // root's error handler, not-found handler and hooks; the encapsulation changes nothing else.
  void app.register(async (routes) => {
    for (const call of CALL_NAMES) {
      // The body is `unknown` on purpose: `SimServer` validates it with the same `@slot/protocol`
      // schema the client validated against, and a second validation here would be a second place
      // for the contract to live.
      routes.post(routeFor(call), (request, reply) => handle(call, request, reply));
    }

    /** Liveness: the process is up and answering. Deliberately says nothing about the game. */
    routes.get('/health', () => ({ status: 'ok' }));

    /**
     * Readiness: what game this server is serving.
     *
     * `mathVersion` is here because it is the one field a deploy can get wrong in a way nothing
     * else notices — a client drawing reels the server is not playing.
     */
    routes.get('/ready', () => ({
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
     * Not behind `devRoutes`: without it there is no way to obtain a token at all, and a server
     * you cannot authenticate against is not a server. A request naming a session it holds
     * **renews** it — the token re-attaches to the same balance and `pendingRound`, which is what
     * makes a reload and the §5 mid-round expiry recovery work over HTTP. Anything else begins a
     * visitor's own session when the pool may create them, and renews the resident when it may
     * not. `apps/rgs` has no lobby at all: its tokens come from `/operator/sessions` (R5).
     */
    routes.post('/demo/session', (request, reply) => {
      const parsed = LobbyRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        const failure = new SlotError('SCHEMA_MISMATCH', 'the lobby takes at most a token');
        return reply.code(400).send(errorBody(failure, request.id));
      }
      return sessions.issue(parsed.data.token);
    });

    if (devRoutes) registerDevRoutes(routes, (request) => sessionOf(request));
  });

  return app;
}
