import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { CurrencySchema } from '@slot/protocol';
import type { SessionService } from '../domain/sessions.js';

/**
 * The operator surface (docs/protocol.md §7, R5) — the lobby's face on this server.
 *
 * Deliberately *outside* the game contract, exactly as `/demo/session` is on `apps/mock-rgs`: the
 * game wire never carries session issuance, because tokens arrive out of band. What is different
 * here is who calls it — an operator's lobby service, not a player's browser — so it speaks plain
 * operator JSON (no `ProtocolError` envelope; the game's error taxonomy classifies refusals *of
 * the game*, and a misconfigured lobby is not one) and it is guarded by a shared key in
 * `x-operator-key`. Key comparison is exact and the refusal names nothing: which half of the
 * credential was wrong is not something an unauthenticated caller gets to learn.
 */

const IssueSchema = z
  .object({
    playerId: z.string().min(1).max(128),
    currency: CurrencySchema.optional(),
    /** Bounded: a session that outlives a month is a leak with a timestamp. */
    ttlMs: z.int().min(60_000).max(2_592_000_000).optional(),
    /**
     * An explicit token, for out-of-band channels that already hold one (the demo env token).
     * Absent — the operator path — the server mints one from its own entropy.
     */
    token: z.string().min(8).max(128).optional(),
  })
  .strict();

export interface OperatorOptions {
  sessions: SessionService;
  /** The shared key an operator presents in `x-operator-key`. */
  key: string;
}

export function registerOperatorRoutes(app: FastifyInstance, { sessions, key }: OperatorOptions) {
  app.post('/operator/sessions', async (request, reply) => {
    if (request.headers['x-operator-key'] !== key) {
      return reply.code(401).send({ error: 'operator key required' });
    }

    const parsed = IssueSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return reply.code(400).send({ error: detail });
    }

    const issued = await sessions.issue(parsed.data);
    request.log.info({ playerId: parsed.data.playerId }, 'session issued');
    return reply.code(201).send(issued);
  });
}
