import { z } from 'zod';

/**
 * Provable fairness on the wire (docs/protocol.md §9, D11) — optional everywhere, because it is a
 * *capability*: a server that honours `forceOutcome` (the simulator, by design) cannot commit to
 * outcomes, and shipping the fields as required would make it lie. A server that does commit
 * plays this scheme:
 *
 * - **Commit before the bet.** `authenticate` (and every closing response) carries the SHA-256 of
 *   the seed the *next* round will bind. The player holds it before choosing `roundId` and
 *   `clientSeed` — both client-minted, so the server has nothing left to adapt.
 * - **Bind at open.** The spin response echoes the commitment its round bound.
 * - **Reveal at close.** The response that closes the round — `spin` for a dead round, `settle`
 *   otherwise — discloses the bound seed and the next commitment. `sha256(reveal)` must equal the
 *   held commitment, and every step's `stops[]` recomputes from
 *   `deriveSpinSeed(reveal, roundId, clientSeed, step)` (`@slot/game-math`).
 */

/** A SHA-256 digest, lowercase hex — the one hash this protocol speaks (D11). */
export const CommitmentSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'a commitment is 64 lowercase hex characters of SHA-256');

export type Commitment = z.infer<typeof CommitmentSchema>;

/** The seed disclosed at close. Printable and bounded; its hash is the held commitment. */
export const RevealedSeedSchema = z.string().min(1).max(128);

/** `authenticate`: the commitment on offer for the next round to open. */
export const FairnessNextSchema = z.object({
  next: CommitmentSchema,
});

export type FairnessNext = z.infer<typeof FairnessNextSchema>;

/** `pendingRound`: the commitment the interrupted round bound — re-learned on resume (§5). */
export const FairnessBindingSchema = z.object({
  commitment: CommitmentSchema,
});

export type FairnessBinding = z.infer<typeof FairnessBindingSchema>;

/**
 * `spin`: the binding always; the reveal and the next commitment exactly when this response
 * closed the round (a dead round settles atomically). The refinement is the rule: reveal and
 * next travel together — both on the closing response, neither before it.
 */
export const SpinFairnessSchema = z
  .object({
    commitment: CommitmentSchema,
    reveal: RevealedSeedSchema.optional(),
    next: CommitmentSchema.optional(),
  })
  .refine((fairness) => (fairness.reveal === undefined) === (fairness.next === undefined), {
    message: 'reveal and next travel together: both on the closing response, neither before',
  });

export type SpinFairness = z.infer<typeof SpinFairnessSchema>;

/** `settle`: the response that closes every round with money — all three, always. */
export const SettleFairnessSchema = z.object({
  commitment: CommitmentSchema,
  reveal: RevealedSeedSchema,
  next: CommitmentSchema,
});

export type SettleFairness = z.infer<typeof SettleFairnessSchema>;
