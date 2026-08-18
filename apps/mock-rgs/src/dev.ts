import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCodeSchema, SlotError } from '@slot/protocol';
import type { Minor } from '@slot/protocol';
import { NO_FAULTS, createSimState } from '@slot/rgs-sim';
import type { FaultConfig, SimServer } from '@slot/rgs-sim';
import { errorBody } from './errors.js';

/**
 * The debug surface: fault injection, reset, and a look at the session.
 *
 * These are the controls the debug panel (C7) drives, and the reason they are HTTP routes rather
 * than a browser-only affordance is that the *interesting* faults are network faults. Flipping a
 * drop rate in-process proves the client survives a promise that never settles; flipping it here
 * proves it survives a socket that goes quiet, which is the thing that actually happens to players.
 *
 * They are also what makes the contract suite (S3) able to demand a specific failure from a target
 * instead of waiting for one — and they are mounted only when `devRoutes` is on. `apps/rgs` will not
 * have them at all.
 */

const RateSchema = z.number().min(0).max(1);

/**
 * The runtime shape of `FaultConfig`.
 *
 * `@slot/rgs-sim` declares it as a TypeScript interface because in-process nobody can send it
 * anything else. Over HTTP anybody can, so the boundary gets a schema — the same rule the wire
 * follows, applied to the control plane. `.strict()` is deliberate: a typo'd `dropRatio` that
 * silently injected no faults would be a debugging session nobody deserves.
 */
export const FaultConfigSchema = z
  .object({
    latencyMs: z.int().min(0).max(60_000).optional(),
    jitterMs: z.int().min(0).max(60_000).optional(),
    errorRates: z.partialRecord(ErrorCodeSchema, RateSchema).optional(),
    dropRate: RateSchema.optional(),
    slowMs: z.int().min(0).max(60_000).optional(),
    slowRate: RateSchema.optional(),
  })
  .strict();

const ResetSchema = z
  .object({
    /** Minor units. Defaults to the balance this server booted with. */
    balance: z.int().min(0).optional(),
    /** A different seed is a different game — every outcome in the session changes with it. */
    serverSeed: z.string().min(1).optional(),
  })
  .strict();

/** A validation failure on the control plane speaks the same error shape as the game does. */
const rejectInvalid = (
  reply: FastifyReply,
  request: FastifyRequest,
  issues: z.core.$ZodIssue[],
): FastifyReply =>
  reply
    .code(400)
    .send(
      errorBody(
        new SlotError(
          'SCHEMA_MISMATCH',
          issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; '),
        ),
        request.id,
      ),
    );

export function registerDevRoutes(app: FastifyInstance, sim: SimServer): void {
  // Captured before the first request: this is the session the server booted with, and what `reset`
  // returns to.
  const boot = sim.state;

  app.get('/dev/faults', () => sim.faults);

  app.put('/dev/faults', (request, reply) => {
    const parsed = FaultConfigSchema.safeParse(request.body);
    if (!parsed.success) return rejectInvalid(reply, request, parsed.error.issues);

    sim.setFaults(parsed.data as FaultConfig);
    request.log.info({ faults: parsed.data }, 'fault injection updated');
    return reply.code(200).send(sim.faults);
  });

  app.delete('/dev/faults', (request, reply) => {
    sim.setFaults(NO_FAULTS);
    request.log.info('fault injection cleared');
    return reply.code(200).send(sim.faults);
  });

  /**
   * A fresh session on the same server.
   *
   * The E2E suite (C8) and the contract suite (S3) both need a known starting point without
   * restarting a process, and the alternative — tests that depend on the order they run in — is the
   * kind of thing that goes unnoticed until it goes wrong in CI only.
   */
  app.post('/dev/reset', (request, reply) => {
    const parsed = ResetSchema.safeParse(request.body ?? {});
    if (!parsed.success) return rejectInvalid(reply, request, parsed.error.issues);

    const serverSeed = parsed.data.serverSeed ?? boot.serverSeed;
    const balance = (parsed.data.balance ?? boot.balance) as Minor;

    sim.reset(
      createSimState({
        serverSeed,
        balance,
        expiresAt: boot.session.expiresAt,
        playerId: boot.session.playerId,
        currency: boot.session.currency,
        // The token is derived from the seed, so an unchanged seed keeps the token a running client
        // already holds.
        ...(serverSeed === boot.serverSeed ? { token: boot.token } : {}),
      }),
    );

    request.log.info({ serverSeed, balance }, 'session reset');
    return reply.code(200).send({ token: sim.state.token, balance: sim.state.balance });
  });

  /**
   * What the simulator thinks is true — the server-side half of the debug panel's state inspector.
   *
   * A summary, not the whole state: the rounds carry their full stored responses (that is what makes
   * idempotent replay possible) and dumping fifty of them over HTTP would be megabytes to look at
   * four fields.
   */
  app.get('/dev/state', () => ({
    serverSeed: sim.state.serverSeed,
    token: sim.state.token,
    balance: sim.state.balance,
    seq: sim.state.seq,
    session: sim.state.session,
    rounds: sim.state.rounds.map((round) => ({
      roundId: round.roundId,
      state: round.state,
      stake: round.stake,
      cumulativeWin: round.cumulativeWin,
      steps: round.steps.length,
    })),
  }));
}
