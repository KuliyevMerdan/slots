import type { Session } from '@slot/protocol';

/**
 * The session seam, R1-minimal.
 *
 * The wire carries the token only on `authenticate` (§7); every other call is bound to the session
 * the server holds. Until R5 builds real sessions — operator-issued tokens, a Redis store, and a
 * binding that lets one process serve many players — this server deliberately has the simulator's
 * shape: **one active session**, verified by token, renewed by re-issuing. The port is what R5
 * replaces; the domain never learns which implementation it is talking to.
 */
export interface SessionPort {
  /** The session a presented token authenticates, or `undefined` — the caller phrases the error. */
  verify(token: string): Session | undefined;
  /** The session the server currently holds calls against, or `undefined` before any was issued. */
  active(): Session | undefined;
}

/**
 * One session at a time, issued from the composition site (main.ts, a test, the contract
 * harness) — which is the honest reading of §7: the token arrives out of band, and in this
 * process the out-of-band channel is whoever constructed the server.
 *
 * Issuing **renews**: the fresh token replaces the old and re-attaches to the same player — the
 * same behaviour the demo lobby has in `apps/mock-rgs`, because it is what makes the §5 mid-round
 * expiry recovery playable.
 */
export class SingleSessionHost implements SessionPort {
  #token: string | undefined;
  #session: Session | undefined;

  issue(token: string, session: Session): void {
    this.#token = token;
    this.#session = session;
  }

  /** Force the active session to be expired from `now` on — the control plane for expiry tests. */
  expire(at: number): void {
    if (this.#session !== undefined) {
      this.#session = { ...this.#session, expiresAt: at };
    }
  }

  verify(token: string): Session | undefined {
    return this.#token !== undefined && token === this.#token ? this.#session : undefined;
  }

  active(): Session | undefined {
    return this.#session;
  }
}
