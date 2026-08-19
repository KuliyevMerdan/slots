import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Minor } from '@slot/protocol';
import { MockWallet } from './mock.js';
import { WalletError } from './provider.js';
import { WALLET_ROUTES, WALLET_STATUS_OF_CODE, WalletRequestSchemas } from './wire.js';
import type { WalletCall } from './wire.js';

/**
 * The operator's wallet, faked at the wire — docs/wallet-api.md served over a socket.
 *
 * `MockWallet` decides everything; this app parses, validates and enacts — the same split as
 * `apps/mock-rgs` over `rgs-sim`, for the same reason: the semantics under test must have exactly
 * one implementation. What the sim adds is the failure model of §4, as two injectable faults that
 * mirror the game simulator's FAIL/DROP distinction:
 *
 * - **`refuse`** — answer 503 *without executing*: the outage. Nothing moves; a retry that
 *   outlives it starts fresh.
 * - **`loseResponses`** — execute the operation, then answer 503: the lost confirmation. Money
 *   moved and the caller cannot know — the case the idempotent ref exists for, and the one an
 *   integration test cannot produce any other way.
 *
 * Tests and the contract harness construct this in-process and hold the object; there is no
 * standalone binary, because the thing it stands in for is the *operator's* system, not ours.
 */

export interface WalletSimFaults {
  /** Refuse every call with a 503 before executing it. */
  refuse?: boolean;
  /** Execute the next N calls, then answer 503 as if the confirmation was lost. */
  loseResponses?: number;
}

export class WalletSim {
  readonly wallet: MockWallet;
  #faults: Required<WalletSimFaults> = { refuse: false, loseResponses: 0 };

  constructor(initial: Record<string, Minor> = {}) {
    this.wallet = new MockWallet(initial);
  }

  setFaults({ refuse = false, loseResponses = 0 }: WalletSimFaults): void {
    this.#faults = { refuse, loseResponses };
  }

  reset(initial: Record<string, Minor>): void {
    this.wallet.reset(initial);
    this.#faults = { refuse: false, loseResponses: 0 };
  }

  /** Refusing happens before the operation, losing a response after — the §4 distinction. */
  intercept(): 'REFUSE' | 'LOSE' | 'DELIVER' {
    if (this.#faults.refuse) return 'REFUSE';
    if (this.#faults.loseResponses > 0) {
      this.#faults.loseResponses -= 1;
      return 'LOSE';
    }
    return 'DELIVER';
  }
}

const execute = (sim: WalletSim, call: WalletCall, body: unknown): Promise<Minor> => {
  switch (call) {
    case 'balance': {
      const { playerId } = WalletRequestSchemas.balance.parse(body);
      return sim.wallet.getBalance(playerId);
    }
    case 'debit': {
      const { playerId, amount, ref } = WalletRequestSchemas.debit.parse(body);
      return sim.wallet.debit(playerId, amount as Minor, ref);
    }
    case 'credit': {
      const { playerId, amount, ref } = WalletRequestSchemas.credit.parse(body);
      return sim.wallet.credit(playerId, amount as Minor, ref);
    }
    case 'rollback': {
      const { ref } = WalletRequestSchemas.rollback.parse(body);
      return sim.wallet.rollback(ref);
    }
  }
};

const enact = async (
  sim: WalletSim,
  call: WalletCall,
  body: unknown,
  reply: FastifyReply,
): Promise<unknown> => {
  if (!WalletRequestSchemas[call].safeParse(body).success) {
    return reply.code(400).send({ message: 'unreadable request' });
  }

  const verdict = sim.intercept();
  if (verdict === 'REFUSE') {
    return reply.code(503).send({ message: 'wallet unavailable' });
  }

  try {
    const balance = await execute(sim, call, body);
    if (verdict === 'LOSE') {
      // The operation ran; the confirmation is what the network ate. To the caller this 503 is
      // indistinguishable from REFUSE — which is the entire point (wallet-api.md §4).
      return reply.code(503).send({ message: 'wallet unavailable' });
    }
    return reply.code(200).send({ balance });
  } catch (error) {
    if (error instanceof WalletError) {
      return reply
        .code(WALLET_STATUS_OF_CODE[error.code])
        .send({ code: error.code, message: error.message });
    }
    throw error;
  }
};

export function buildWalletSimApp(sim: WalletSim): FastifyInstance {
  const app = Fastify({ logger: false });

  for (const call of Object.keys(WALLET_ROUTES) as WalletCall[]) {
    app.post(WALLET_ROUTES[call], (request, reply) => enact(sim, call, request.body, reply));
  }

  return app;
}
