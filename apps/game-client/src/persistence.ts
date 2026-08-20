import { z } from 'zod';
import type { Minor } from '@slot/protocol';
import { persist, readPersisted } from '@slot/protocol';

/**
 * What the client remembers between page loads — and, more importantly, what it does **not**.
 *
 * It remembers *preferences*: the stake the player chose and whether turbo is on. It does not
 * remember the round, the balance or the feature, because none of those are the client's to
 * remember. `authenticate` returns `pendingRound` and the authoritative balance, so a reload
 * mid-feature resumes from the server's view of the world rather than from a local guess that might
 * disagree with it. **A local copy that can disagree with the server is a bug waiting for a support
 * ticket.**
 *
 * The envelope, the version and the discard rule all come from `@slot/protocol`, which is the same
 * policy the simulator's own store obeys — one rule for persisted state, not two similar ones. On
 * any mismatch (old version, corrupt JSON, drifted shape) the payload is discarded and the defaults
 * apply; the session is re-established by `authenticate` either way, which is why the safe behaviour
 * is also the cheap one.
 */

export const CLIENT_STATE_KEY = 'slot.client.state';

/**
 * The player-protection settings (C8) — what the drawer's picker edits and the wiring enforces.
 *
 * The autoplay stops that scale with the bet are stored as *stake multiples* and resolved into
 * money when a run starts, because a limit worth `10×` at every bet level is one setting, while a
 * fixed amount is a different rule at every stake (the `maxWinMultiplier` argument, applied to
 * protection). The session-loss limit is stored resolved, in minor units, because a session
 * crosses stake changes and its limit is an amount of money, not a relationship to the bet.
 */
const ProtectionSchema = z.object({
  autoplaySpins: z.int().min(1),
  stopOnFeature: z.boolean(),
  /** Stop the run when one round pays more than this many stakes. Absent = no stop. */
  winLimitX: z.int().min(1).optional(),
  /** Stop the run when its own net loss exceeds this many stakes. Absent = no stop. */
  lossLimitX: z.int().min(1).optional(),
  /** End play after this much session time. Absent = no limit. */
  maxSessionMinutes: z.int().min(1).optional(),
  /** End play when the session's net loss exceeds this, in minor units. Absent = no limit. */
  maxLossMinor: z.int().min(1).optional(),
});

export type ProtectionSettings = z.infer<typeof ProtectionSchema>;

/** The plan the demo always had, now as the picker's starting point rather than a constant. */
export const DEFAULT_PROTECTION: ProtectionSettings = {
  autoplaySpins: 25,
  stopOnFeature: true,
};

const ClientStateSchema = z.object({
  /** Minor units. Validated against `GameConfig.betLevels` before it is used — the server's ladder. */
  stake: z.int().min(1),
  turbo: z.boolean(),
  /** Optional because payloads written before C6 lack it — and absent means "sound on". */
  muted: z.boolean().optional(),
  /** Optional because payloads written before C8 lack it — and absent means the defaults. */
  protection: ProtectionSchema.optional(),
});

export type ClientState = z.infer<typeof ClientStateSchema>;

/** The same three methods the simulator's port takes, for the same reason (ADR-0003). */
export interface ClientStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Read the remembered preferences, or `null`.
 *
 * `null` covers absent, corrupt and out-of-date indistinguishably, because the response to all three
 * is identical: use the defaults and let the server tell you the rest.
 */
export function loadClientState(
  storage: ClientStorage,
  key = CLIENT_STATE_KEY,
): ClientState | null {
  try {
    return readPersisted(storage.getItem(key), ClientStateSchema);
  } catch {
    // A storage that throws on read — Safari's private mode does — is a storage that remembers
    // nothing. That is a degraded session, not a broken one.
    return null;
  }
}

export function saveClientState(
  storage: ClientStorage,
  state: ClientState,
  now: number,
  key = CLIENT_STATE_KEY,
): void {
  try {
    storage.setItem(key, JSON.stringify(persist(state, now)));
  } catch {
    // Quota exceeded, or a storage that refuses to write. The game does not depend on this having
    // worked, so the correct failure is "forgets the preference", not "crashes on spin 5,000".
  }
}

/**
 * The stake to start with: the remembered one if the server still offers it, otherwise the smallest.
 *
 * The check matters. Bet ladders change — a jurisdiction switch, a re-tune in S4 — and a remembered
 * stake that is no longer on the ladder would be refused by the server as `STAKE_NOT_ALLOWED` on the
 * first spin of the session.
 */
export const stakeFor = (remembered: ClientState | null, levels: readonly Minor[]): Minor => {
  const fallback = levels[0] ?? (0 as Minor);
  if (remembered === null) return fallback;
  return levels.includes(remembered.stake as Minor) ? (remembered.stake as Minor) : fallback;
};
