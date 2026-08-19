import type { Minor } from '@slot/protocol';
import { WalletError } from './provider.js';
import type { WalletProvider } from './provider.js';
import { WALLET_ROUTES, WalletBalanceResSchema, WalletErrorResSchema } from './wire.js';
import type { WalletCall } from './wire.js';

/**
 * The wallet over HTTP — the real half of the R0 seam (docs/wallet-api.md).
 *
 * The whole client is a resilience policy around four POSTs, and the policy is the point:
 *
 * - **Every attempt has a deadline.** A per-attempt `AbortSignal` ends the request that would
 *   otherwise hold a socket while the round waits — the same argument the game transport made.
 * - **Retries are bounded and only for unavailability** — network noise, a 5xx, a timeout, an
 *   unreadable body. Safe *because* every mutation is idempotent on its ref (§3): a debit whose
 *   response was lost is healed by asking again, not doubled.
 * - **A refusal is never retried.** A 4xx with a wallet code means the wallet understood and said
 *   no; it surfaces as `WalletError` and the domain phrases it for the game wire
 *   (`INSUFFICIENT_FUNDS` stays a `PLAYER` error, everything else `WALLET_UNAVAILABLE`).
 *
 * `fetch` and `sleep` arrive as structural arguments (the ADR-0003 shape), which is why the unit
 * tests can drive every failure mode without a socket and without waiting out a backoff.
 */

interface HttpResponseLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<HttpResponseLike>;

export interface RemoteWalletOptions {
  baseUrl: string;
  fetch?: FetchLike;
  /** Per-attempt deadline. The wallet sits between the player and their reels — keep it short. */
  timeoutMs?: number;
  /** Total attempts per call, first one included. */
  attempts?: number;
  /** Base backoff between attempts; attempt n waits `backoffMs × n`. */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

const resolveFetch = (): FetchLike => {
  const global = globalThis as { fetch?: (...args: never[]) => Promise<HttpResponseLike> };
  if (typeof global.fetch !== 'function') {
    throw new Error('RemoteWallet needs a fetch implementation — inject one or run on Node 18+');
  }
  return global.fetch.bind(globalThis) as FetchLike;
};

/** An unavailability, as opposed to a refusal — retried while attempts remain, then surfaced. */
class WalletUnreachable extends Error {}

export class RemoteWallet implements WalletProvider {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #attempts: number;
  readonly #backoffMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor({
    baseUrl,
    fetch,
    timeoutMs = 2_000,
    attempts = 3,
    backoffMs = 50,
    sleep = defaultSleep,
  }: RemoteWalletOptions) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#fetch = fetch ?? resolveFetch();
    this.#timeoutMs = timeoutMs;
    this.#attempts = attempts;
    this.#backoffMs = backoffMs;
    this.#sleep = sleep;
  }

  getBalance(playerId: string): Promise<Minor> {
    return this.#call('balance', { playerId });
  }

  debit(playerId: string, amount: Minor, ref: string): Promise<Minor> {
    return this.#call('debit', { playerId, amount, ref });
  }

  credit(playerId: string, amount: Minor, ref: string): Promise<Minor> {
    return this.#call('credit', { playerId, amount, ref });
  }

  rollback(ref: string): Promise<Minor> {
    return this.#call('rollback', { ref });
  }

  async #call(call: WalletCall, body: unknown): Promise<Minor> {
    let lastFailure: unknown;

    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      if (attempt > 1) await this.#sleep(this.#backoffMs * (attempt - 1));
      try {
        return await this.#attempt(call, body);
      } catch (error) {
        // A refusal is final — the wallet understood and said no. Everything else is the network
        // or the wallet's own trouble, and the idempotent ref makes asking again safe.
        if (error instanceof WalletError) throw error;
        lastFailure = error;
      }
    }

    throw new Error(
      `wallet ${call} failed after ${this.#attempts} attempts: ${
        lastFailure instanceof Error ? lastFailure.message : String(lastFailure)
      }`,
      { cause: lastFailure },
    );
  }

  async #attempt(call: WalletCall, body: unknown): Promise<Minor> {
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    let response: HttpResponseLike;
    try {
      response = await this.#fetch(`${this.#baseUrl}${WALLET_ROUTES[call]}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new WalletUnreachable(
        controller.signal.aborted
          ? `no answer within ${this.#timeoutMs}ms`
          : `request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      clearTimeout(deadline);
    }

    if (response.ok) {
      const payload = WalletBalanceResSchema.safeParse(await this.#json(response));
      if (!payload.success) {
        throw new WalletUnreachable('the wallet answered a shape this client cannot read');
      }
      return payload.data.balance as Minor;
    }

    // A 4xx that carries a wallet code is a refusal; everything else is unavailability.
    if (response.status >= 400 && response.status < 500) {
      const refusal = WalletErrorResSchema.safeParse(await this.#json(response));
      if (refusal.success) {
        throw new WalletError(refusal.data.code, refusal.data.message);
      }
    }
    throw new WalletUnreachable(`the wallet answered ${response.status}`);
  }

  async #json(response: HttpResponseLike): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
}
