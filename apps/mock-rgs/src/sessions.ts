import { randomUUID } from 'node:crypto';
import type { SimServer, SimState } from '@slot/rgs-sim';

/**
 * One simulator per visitor — what turns a development server into a demo a stranger can share
 * a URL with.
 *
 * `@slot/rgs-sim` is single-session by design: one token, one balance, one `pendingRound`, and
 * `issueSession` *renews* that session rather than minting another (§5's mid-round expiry is
 * playable because of it). On `localhost` that is one developer. On a public URL it made every
 * visitor the same player — a shared wallet, each other's rounds resumed, `ROUND_CONFLICT` between
 * strangers, and one visitor's `/dev/faults` landing on everyone.
 *
 * So the multiplicity lives here, in the app, and the simulator stays exactly what it is: each
 * visitor gets their own `SimServer`, found by the token they carry. Nothing about a round's rules
 * moved — the pool decides only *which* simulator a call reaches.
 *
 * Two kinds of session live in the pool:
 *
 * - **The resident** — the simulator the app was built with, pinned and never evicted. It is what
 *   a call with no credential reaches (the tests, a developer's `curl`), and what the lobby renews
 *   when the pool may not create visitors at all.
 * - **Visitors** — created by the lobby on demand, one per `POST /demo/session` that names no live
 *   session. Bounded: an idle visitor is forgotten after `idleMs`, and at capacity the
 *   longest-idle one makes room. Forgetting loses play money and, at worst, a round abandoned
 *   mid-feature for longer than the idle window — the same thing the demo's restart loses, and
 *   the price of a server whose memory cannot grow without bound.
 */

/** What makes a visitor: the token they will carry and their ordinal, for a replayable seed. */
export interface VisitorIdentity {
  readonly token: string;
  readonly ordinal: number;
}

export interface VisitorPolicy {
  /** Builds a visitor's simulator. Injected, so the app never decides what a session starts with. */
  create: (identity: VisitorIdentity) => SimServer;
  /** Most visitors held at once; the resident is not counted. */
  maxSessions: number;
  /** How long a visitor may go without a call before the pool forgets them. */
  idleMs: number;
  /** The pool's clock — for idleness only; each simulator keeps its own. */
  now?: () => number;
  /** A token nobody can guess. Injected so a test can name the tokens it expects. */
  mintToken?: () => string;
}

export interface Session {
  readonly sim: SimServer;
  /** The state this session began with — what `/dev/reset` returns it to. */
  readonly boot: SimState;
  readonly resident: boolean;
}

interface Entry extends Session {
  lastSeen: number;
}

export class SessionPool {
  readonly resident: Session;
  readonly #visitors = new Map<string, Entry>();
  readonly #policy: VisitorPolicy | undefined;
  readonly #now: () => number;
  readonly #mintToken: () => string;
  #ordinal = 0;

  constructor(resident: SimServer, policy?: VisitorPolicy) {
    this.resident = { sim: resident, boot: resident.state, resident: true };
    this.#policy = policy;
    this.#now = policy?.now ?? Date.now;
    this.#mintToken = policy?.mintToken ?? (() => `demo-${randomUUID()}`);
  }

  /** How many visitors are held right now. */
  get size(): number {
    return this.#visitors.size;
  }

  /**
   * The session a token belongs to, or `undefined` for a token this server does not hold — never
   * issued, or forgotten. Finding a session counts as activity.
   */
  find(token: string): Session | undefined {
    if (token === this.resident.sim.state.token) return this.resident;
    const entry = this.#visitors.get(token);
    if (entry !== undefined) entry.lastSeen = this.#now();
    return entry;
  }

  /**
   * The demo lobby (§7): renew the session `requested` names, or begin a new one.
   *
   * Renewing is what it always was — the same token re-attached to the same balance and the same
   * `pendingRound` — so a reload, and the §5 renewal after an expiry, find the round they left.
   * A token the pool no longer holds (the server restarted, or the visitor idled out) is not an
   * error: the visitor simply starts again, which is what a demo that forgot them should do.
   */
  issue(requested?: string): { token: string } {
    if (requested !== undefined) {
      const known = this.find(requested);
      if (known !== undefined) return known.sim.issueSession();
    }
    if (this.#policy === undefined) return this.resident.sim.issueSession();

    this.#sweep();
    if (this.#visitors.size >= this.#policy.maxSessions) this.#evictLongestIdle();

    const token = this.#mintToken();
    this.#ordinal += 1;
    const sim = this.#policy.create({ token, ordinal: this.#ordinal });
    this.#visitors.set(token, { sim, boot: sim.state, resident: false, lastSeen: this.#now() });
    return sim.issueSession();
  }

  #sweep(): void {
    if (this.#policy === undefined) return;
    const cutoff = this.#now() - this.#policy.idleMs;
    for (const [token, entry] of this.#visitors) {
      if (entry.lastSeen < cutoff) this.#visitors.delete(token);
    }
  }

  #evictLongestIdle(): void {
    let oldest: [string, Entry] | undefined;
    for (const candidate of this.#visitors) {
      if (oldest === undefined || candidate[1].lastSeen < oldest[1].lastSeen) oldest = candidate;
    }
    if (oldest !== undefined) this.#visitors.delete(oldest[0]);
  }
}
