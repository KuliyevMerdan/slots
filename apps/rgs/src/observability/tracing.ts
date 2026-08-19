import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Attributes, Tracer } from '@opentelemetry/api';
import { SlotError, classOf } from '@slot/protocol';
import type { WalletProvider } from '../wallet/provider.js';

/**
 * The tracing seam (R6) — `@opentelemetry/api` and nothing heavier, because the API package *is*
 * the port: a facade with a no-op default that a composition may or may not put an SDK behind.
 * Modules here take a `Tracer` as an argument (the ADR-0003 shape); `main.ts` registers a real
 * provider only when `OTEL_EXPORTER_OTLP_ENDPOINT` says there is somewhere to send spans, and the
 * tests hand in an in-memory provider and read the spans back (ADR-0008).
 *
 * Every span carries `rgs.round_id` when the operation has one — that attribute is the R6 gate's
 * join key: one `roundId` retrieves the round's story across logs, traces and metrics.
 */

/** The tracer a composition gets when nobody wired one: the API's own no-op. */
export const defaultTracer = (): Tracer => trace.getTracer('@slot/rgs');

const finish = <T>(
  tracer: Tracer,
  name: string,
  kind: SpanKind,
  attributes: Attributes,
  work: () => Promise<T>,
): Promise<T> =>
  tracer.startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      return await work();
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      if (error instanceof SlotError) {
        span.setAttribute('rgs.error_code', error.code);
        span.setAttribute('rgs.error_class', classOf(error.code));
      }
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });

/** One game call, as a SERVER span — the HTTP layer wraps every dispatch in this. */
export const inCallSpan = <T>(
  tracer: Tracer,
  call: string,
  attributes: Attributes,
  work: () => Promise<T>,
): Promise<T> => finish(tracer, `rgs.${call}`, SpanKind.SERVER, attributes, work);

/**
 * The wallet, traced — a decorator, exactly as `withRetry` decorates the client's transport: the
 * seam already existed, so observing it is wrapping it, not editing it. Wallet spans are CLIENT
 * kind (this server is the caller) and nest under whichever call span is active, which is what
 * makes "spin → wallet" one picture instead of two.
 */
export const tracedWallet = (wallet: WalletProvider, tracer: Tracer): WalletProvider => ({
  getBalance: (playerId) =>
    finish(tracer, 'wallet.getBalance', SpanKind.CLIENT, { 'rgs.player_id': playerId }, () =>
      wallet.getBalance(playerId),
    ),
  debit: (playerId, amount, ref) =>
    finish(
      tracer,
      'wallet.debit',
      SpanKind.CLIENT,
      { 'rgs.player_id': playerId, 'rgs.amount': amount, 'rgs.ref': ref, 'rgs.round_id': ref },
      () => wallet.debit(playerId, amount, ref),
    ),
  credit: (playerId, amount, ref) =>
    finish(
      tracer,
      'wallet.credit',
      SpanKind.CLIENT,
      {
        'rgs.player_id': playerId,
        'rgs.amount': amount,
        'rgs.ref': ref,
        // The settle ref is `<roundId>:settle` — strip the suffix so the join key stays exact.
        'rgs.round_id': ref.replace(/:settle$/, ''),
      },
      () => wallet.credit(playerId, amount, ref),
    ),
  rollback: (ref) =>
    finish(
      tracer,
      'wallet.rollback',
      SpanKind.CLIENT,
      { 'rgs.ref': ref, 'rgs.round_id': ref },
      () => wallet.rollback(ref),
    ),
});
