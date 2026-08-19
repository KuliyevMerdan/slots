import type { ForceOutcome, Minor } from '@slot/protocol';

/**
 * Key-order-independent serialisation, for comparing a duplicate request against the original.
 *
 * `JSON.stringify` would do until the day two clients serialise the same object with their keys in
 * a different order and an honest retry is answered with `ROUND_CONFLICT` — a `FATAL` error, over
 * nothing. The same function, for the same reason, as the simulator's — deliberately not shared:
 * a fingerprint only ever meets fingerprints minted by the same server, so the two copies cannot
 * drift *from each other*, and keeping it local leaves each server free to fingerprint what it
 * actually stores.
 */
export const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
};

/**
 * What makes two `spin` requests "the same spin". Exported because the contract harness's
 * `strand()` has to leave a round whose fingerprint the later, honest retry will match.
 */
export const spinFingerprint = (
  stake: Minor,
  clientSeed: string | undefined,
  forceOutcome: ForceOutcome | undefined,
): string => canonical([stake, clientSeed ?? null, forceOutcome ?? null]);

export const featureSpinFingerprint = (forceOutcome: ForceOutcome | undefined): string =>
  canonical([forceOutcome ?? null]);

/** A settle carries nothing but the key, so every honest settle of a round is "the same". */
export const settleFingerprint = (): string => canonical([]);
