import { z } from 'zod';
import { TimestampSchema } from './primitives.js';

/**
 * Bumped whenever the shape of anything persisted locally changes — the client's round state, the
 * simulator's `localStorage` store.
 *
 * The rule is **discard and re-authenticate on mismatch, never best-effort parse**. That is safe
 * rather than merely convenient: `authenticate` returns `pendingRound`, so the server's view of the
 * round survives a discarded local payload. The cheap behaviour and the correct one are the same.
 */
export const PERSISTENCE_SCHEMA_VERSION = 1;

export const persistedEnvelopeSchema = <T extends z.ZodType>(data: T) =>
  z.object({
    v: z.literal(PERSISTENCE_SCHEMA_VERSION),
    savedAt: TimestampSchema,
    data,
  });

export interface PersistedEnvelope<T> {
  v: number;
  savedAt: number;
  data: T;
}

/** Wrap a value for storage. `savedAt` comes from the caller's clock — never read ambiently. */
export const persist = <T>(data: T, savedAt: number): PersistedEnvelope<T> => ({
  v: PERSISTENCE_SCHEMA_VERSION,
  savedAt,
  data,
});

/**
 * Read a persisted payload, applying the discard rule.
 *
 * Returns `null` for anything that is not exactly a current, valid envelope — wrong version,
 * corrupt JSON, missing key, shape drift. The caller re-authenticates; it never repairs.
 */
export function readPersisted<T extends z.ZodType>(
  raw: string | null | undefined,
  data: T,
): z.infer<T> | null {
  if (raw === null || raw === undefined || raw === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const envelope = persistedEnvelopeSchema(data).safeParse(parsed);
  if (!envelope.success) return null;

  // The envelope is built from `data` right above, so its payload is `z.infer<T>` by construction —
  // zod cannot carry that through a generic factory, hence the assertion.
  return (envelope.data as PersistedEnvelope<z.infer<T>>).data;
}
