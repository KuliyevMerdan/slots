/**
 * The one error this server can produce today.
 *
 * `surface` names the module and the block that builds it (`domain/rounds.spin (R1)`), because the
 * whole point of an expected-red target is that a failure says *what is missing*, not merely that
 * something is. The HTTP layer maps this onto the wire as `NOT_IMPLEMENTED` — a first-class
 * protocol error (docs/protocol.md §6, D10), status 501 — so a client, a proxy log and the contract
 * suite all see the same honest sentence: the route exists, the implementation does not.
 */
export class NotImplementedError extends Error {
  readonly surface: string;

  constructor(surface: string) {
    super(`${surface} is not implemented yet — ROADMAP.md Part III names the block that builds it`);
    this.name = 'NotImplementedError';
    this.surface = surface;
  }
}

export const isNotImplemented = (value: unknown): value is NotImplementedError =>
  value instanceof NotImplementedError;
