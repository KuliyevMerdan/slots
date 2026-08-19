/**
 * The game's math is the shared package, re-exported — never re-implemented.
 *
 * This is the seam the contract suite's self-consistency assertion exists for: the day this server
 * computes an outcome (R1+), it computes it with the same strips, paytable and evaluator the client
 * ships, and `MATH_VERSION` is how the two prove it on the authenticate path. A server with its own
 * copy of the paytable is a server whose reels can light a win the player was not paid.
 */
export * from '@slot/game-math';
