import { z } from 'zod';

/**
 * The wallet wire — docs/wallet-api.md, as schemas.
 *
 * Deliberately *not* `@slot/protocol`: that package is the player-client↔RGS contract, handable
 * to an operator's game team (ADR-0002). This is the RGS↔wallet contract, spoken to the
 * operator's platform team, and a different operator means a different adapter behind the same
 * `WalletProvider` — so the schemas live with the adapter that speaks them. Both sides here
 * validate: `RemoteWallet` validates responses, the sim server validates requests.
 */

const PlayerIdSchema = z.string().min(1);
/** Integer minor units (ADR-0002). Non-negative: a negative movement is the other call. */
const AmountSchema = z.int().min(0);
const RefSchema = z.string().min(1).max(128);

export const WALLET_ROUTES = {
  balance: '/wallet/balance',
  debit: '/wallet/debit',
  credit: '/wallet/credit',
  rollback: '/wallet/rollback',
} as const;

export type WalletCall = keyof typeof WALLET_ROUTES;

export const WalletRequestSchemas = {
  balance: z.object({ playerId: PlayerIdSchema }),
  debit: z.object({ playerId: PlayerIdSchema, amount: AmountSchema, ref: RefSchema }),
  credit: z.object({ playerId: PlayerIdSchema, amount: AmountSchema, ref: RefSchema }),
  rollback: z.object({ ref: RefSchema }),
} as const;

export const WalletBalanceResSchema = z.object({ balance: z.int().min(0) });

export const WALLET_ERROR_CODES = [
  'INSUFFICIENT_FUNDS',
  'UNKNOWN_PLAYER',
  'UNKNOWN_REF',
  'REF_CONFLICT',
] as const;

export const WalletErrorResSchema = z.object({
  code: z.enum(WALLET_ERROR_CODES),
  message: z.string(),
});

/** The statuses of docs/wallet-api.md §2 — a refusal's status, never branched on by the client. */
export const WALLET_STATUS_OF_CODE = {
  INSUFFICIENT_FUNDS: 422,
  UNKNOWN_PLAYER: 404,
  UNKNOWN_REF: 404,
  REF_CONFLICT: 409,
} as const satisfies Record<(typeof WALLET_ERROR_CODES)[number], number>;
