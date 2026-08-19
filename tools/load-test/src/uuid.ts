/**
 * UUIDv7 from injected parts — the client-side `roundId` discipline (docs/protocol.md §2),
 * reproduced by the load tool because it *is* a client. Injected clock and randomness so the test
 * can pin the layout bits; `main.ts` hands in `Date.now` and `crypto.randomBytes`.
 */
export const uuidV7 = (now: () => number, randomBytes: (count: number) => Uint8Array): string => {
  const timestamp = now();
  const bytes = new Uint8Array(16);
  // 48 bits of milliseconds, big-endian.
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Math.floor(timestamp / 2 ** ((5 - index) * 8)) % 256;
  }
  bytes.set(randomBytes(10), 6);
  bytes[6] = (0x70 | ((bytes[6] as number) & 0x0f)) as number; // version 7
  bytes[8] = (0x80 | ((bytes[8] as number) & 0x3f)) as number; // RFC 4122 variant
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
