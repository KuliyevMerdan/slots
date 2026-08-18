import type { RoundId } from '@slot/protocol';

/**
 * A UUIDv7, generated in the client — which is the whole idempotency story in one function.
 *
 * The round id is the key every mutating call carries, so a retry after a timeout is *provably* the
 * same round: the server replays its stored response instead of spinning again. That only works if
 * the client mints the id before the first attempt, which is why this is here and not on the server.
 *
 * v7 rather than v4 because the first 48 bits are the timestamp: round ids sort chronologically,
 * which makes a log, a database index and a support conversation all easier. The engine takes this
 * as an injected factory (`newRoundId`) because a pure package may not reach for `crypto` any more
 * than it may reach for a clock.
 */
const HEX = '0123456789abcdef';

const randomHex = (length: number): string => {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) {
    out += (HEX[byte >> 4] ?? '0') + (HEX[byte & 0x0f] ?? '0');
  }
  return out.slice(0, length);
};

export const newRoundId = (now: () => number = Date.now): RoundId => {
  const timestamp = now().toString(16).padStart(12, '0').slice(-12);
  // Layout: 48 bits of time · version 7 · 12 random · variant 0b10 · 62 random.
  const variant = HEX[8 + Math.floor(Math.random() * 4)] ?? '8';
  return [
    timestamp.slice(0, 8),
    timestamp.slice(8, 12),
    `7${randomHex(3)}`,
    `${variant}${randomHex(3)}`,
    randomHex(12),
  ].join('-') as RoundId;
};
