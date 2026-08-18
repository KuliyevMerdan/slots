import type {
  AuthenticateReq,
  AuthenticateRes,
  CallName,
  CallResponse,
  ErrorCode,
  FeatureSpinReq,
  FeatureSpinRes,
  HistoryReq,
  HistoryRes,
  ProtocolErrorPayload,
  SettleReq,
  SettleRes,
  SpinReq,
  SpinRes,
} from '@slot/protocol';
import {
  CALLS,
  CORRELATION_HEADER,
  ProtocolErrorSchema,
  SlotError,
  routeFor,
} from '@slot/protocol';
import type { CallOptions, RgsTransport } from './transport.js';

/**
 * `HttpTransport` — the same four calls, over the wire.
 *
 * It is the other half of the claim the architecture makes: `apps/mock-rgs` today, the real RGS
 * later, **distinguished by one base URL**. Nothing above this class knows which it is talking to,
 * because everything above it sees `RgsTransport` and a classified `SlotError`.
 *
 * Three things it does and one it deliberately does not:
 *
 * - **It validates the response** against the same `@slot/protocol` schema the server validated the
 *   request with. A server that returns a shape the client cannot read is a `FATAL`
 *   `SCHEMA_MISMATCH`, caught at the boundary rather than three animations later.
 * - **It classifies every failure.** A protocol error body becomes the `SlotError` the server meant;
 *   anything else — a dead connection, an HTML error page from a proxy, a 500 with no body — is
 *   mapped by status onto the taxonomy, so the engine still branches on a class.
 * - **It carries a correlation id** on every request, echoed by the server and attached to errors,
 *   which is what makes one round traceable across two processes.
 * - **It never retries.** Timeout, backoff and "the same `roundId` goes back out" belong to
 *   `withRetry`, which both transports share. Two copies of a retry rule is how a client ends up
 *   spinning twice for one press.
 */

/**
 * The slice of `fetch` this package depends on — three members, declared rather than imported.
 *
 * Same move as the simulator's `WebStorageLike` (ADR-0003): a package that must run in a browser, in
 * Node and in a test does not get to depend on whose global it is. It also means a test fakes a
 * response object with four properties instead of constructing a real one.
 */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface HttpRequestLike {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: HttpRequestLike) => Promise<HttpResponseLike>;

export interface HttpTransportOptions {
  /** `http://localhost:8787` — the one line that decides which server this is. */
  baseUrl: string;
  /** Injected for tests and for hosts that put `fetch` somewhere other than the global. */
  fetch?: FetchLike;
  /**
   * Extra headers per request. A function, because the session token an operator's RGS wants in an
   * `Authorization` header is not knowable at construction time.
   */
  headers?: () => Record<string, string>;
  /** One id per request. Defaults to a `crypto.randomUUID()` if the host has one. */
  correlationId?: () => string;
}

const resolveFetch = (): FetchLike => {
  const host = (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (host === undefined) {
    throw new TypeError('HttpTransport needs a fetch implementation: pass one as options.fetch');
  }
  // Bound, and this is not defensive coding: a browser's `fetch` refuses to run with any receiver
  // but `window`, so storing it on an instance and calling `this.#fetch(...)` throws "Illegal
  // invocation". A plain function injected by a test has no such requirement, which is exactly why
  // this cannot be caught anywhere but in a browser.
  return host.bind(globalThis) as FetchLike;
};

/**
 * A correlation id, from the host's crypto if it has one.
 *
 * The fallback is a counter rather than `Math.random()`: this package is not one of the pure four,
 * but an id that changes between two runs of the same seeded test is a diff nobody wants to read.
 */
const resolveCorrelationIds = (): (() => string) => {
  const host = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  const randomUUID = host?.randomUUID?.bind(host);
  if (randomUUID !== undefined) return randomUUID;

  let seq = 0;
  return () => `client-${(seq += 1).toString(10).padStart(6, '0')}`;
};

/**
 * What an HTTP status means when the body did not tell us.
 *
 * A well-behaved server always sends a `ProtocolError`; this is for everything between the client
 * and that server — a proxy timing out, a load balancer with no upstream, a gateway serving HTML.
 * `SCHEMA_MISMATCH` is the honest default for the rest: a 4xx we cannot read means this client and
 * that endpoint disagree about what the wire is, and retrying will not resolve it.
 */
const codeForStatus = (status: number): ErrorCode => {
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_UNAVAILABLE';
  return 'SCHEMA_MISMATCH';
};

/** `Retry-After` in seconds (the header's usual form) — advisory, and the server knows best. */
const retryAfterFrom = (response: HttpResponseLike): number | undefined => {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number.parseFloat(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
};

export class HttpTransport implements RgsTransport {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #headers: () => Record<string, string>;
  readonly #correlationId: () => string;

  constructor({ baseUrl, fetch, headers, correlationId }: HttpTransportOptions) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#fetch = fetch ?? resolveFetch();
    this.#headers = headers ?? (() => ({}));
    this.#correlationId = correlationId ?? resolveCorrelationIds();
  }

  authenticate(request: AuthenticateReq, options?: CallOptions): Promise<AuthenticateRes> {
    return this.#call('authenticate', request, options);
  }

  spin(request: SpinReq, options?: CallOptions): Promise<SpinRes> {
    return this.#call('spin', request, options);
  }

  featureSpin(request: FeatureSpinReq, options?: CallOptions): Promise<FeatureSpinRes> {
    return this.#call('featureSpin', request, options);
  }

  settle(request: SettleReq, options?: CallOptions): Promise<SettleRes> {
    return this.#call('settle', request, options);
  }

  history(request: HistoryReq, options?: CallOptions): Promise<HistoryRes> {
    return this.#call('history', request, options);
  }

  async #call<N extends CallName>(
    call: N,
    request: unknown,
    options: CallOptions | undefined,
  ): Promise<CallResponse<N>> {
    const correlationId = this.#correlationId();
    const signal = options?.signal;

    let response: HttpResponseLike;
    try {
      response = await this.#fetch(`${this.#baseUrl}${routeFor(call)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CORRELATION_HEADER]: correlationId,
          ...this.#headers(),
        },
        body: JSON.stringify(request),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      // Everything that never reached an HTTP status: DNS, a refused connection, a dropped link —
      // and the abort `withRetry` fires when an attempt runs out of clock. `RECOVERABLE` on
      // purpose: we do not know whether the server saw the request, and asking again with the same
      // `roundId` is exactly how the client finds out.
      throw new SlotError(
        'UPSTREAM_UNAVAILABLE',
        `${call} did not reach the server: ${cause instanceof Error ? cause.message : String(cause)}`,
        { correlationId, cause },
      );
    }

    const body = await response.text();
    const served = response.headers.get(CORRELATION_HEADER) ?? correlationId;

    if (!response.ok) throw this.#error(call, response, body, served);

    const payload: unknown = parseJson(body);
    const parsed = CALLS[call].res.safeParse(payload);
    if (!parsed.success) {
      throw new SlotError(
        'SCHEMA_MISMATCH',
        `${call} answered with a body this client cannot read: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
        { correlationId: served },
      );
    }

    return parsed.data as CallResponse<N>;
  }

  /**
   * Turn a non-2xx into the error the server meant.
   *
   * The body is trusted for the `code` and `message` only — `SlotError` derives the class from the
   * code, so a server that mislabels a `PLAYER` error as `RECOVERABLE` cannot talk this client into
   * retrying a spin the player has no funds for.
   */
  #error(
    call: CallName,
    response: HttpResponseLike,
    body: string,
    correlationId: string,
  ): SlotError {
    const parsed = ProtocolErrorSchema.safeParse(parseJson(body));
    if (parsed.success) return SlotError.fromPayload(parsed.data as ProtocolErrorPayload);

    const retryAfterMs = retryAfterFrom(response);
    return new SlotError(
      codeForStatus(response.status),
      `${call} failed with HTTP ${response.status.toString(10)} and no protocol error body`,
      {
        correlationId,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    );
  }
}

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};
