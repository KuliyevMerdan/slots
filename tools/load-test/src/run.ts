import type {
  AuthenticateRes,
  CallName,
  CallRequest,
  CallResponse,
  ProtocolErrorPayload,
} from '@slot/protocol';
import { CALLS, classOf, routeFor } from '@slot/protocol';
import type { LatencySummary, LoadReport } from './stats.js';
import { summarize } from './stats.js';

/**
 * The driver: N connections playing complete rounds against a base URL, concurrently, through
 * the same wire contract the client speaks — every request built from the `CALLS` table, every
 * response validated with the shared schemas, every retry an identical request under the same
 * `roundId` (§4). The tool is deliberately an honest client: it backs off when told
 * (`retryAfterMs` wins over its own arithmetic), retries only `RECOVERABLE` refusals, and never
 * abandons a round mid-flight — because the closing balance check only means something if every
 * stake it counted was either settled or never accepted.
 */

export interface LoadOptions {
  url: string;
  token: string;
  connections: number;
  /** Full rounds per connection. */
  rounds: number;
  stake: number;
  roundId: () => string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Refusal {
  readonly status: number;
  readonly payload: ProtocolErrorPayload;
}

class RefusedError extends Error {
  constructor(readonly refusal: Refusal) {
    super(`${refusal.payload.code}: ${refusal.payload.message}`);
    this.name = 'RefusedError';
  }
}

const MAX_ATTEMPTS = 10;

export async function runLoad({
  url,
  token,
  connections,
  rounds,
  stake,
  roundId,
  fetchImpl = fetch,
  nowMs = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: LoadOptions): Promise<LoadReport> {
  const samples = new Map<string, number[]>();
  const errorsByCode = new Map<string, number>();
  let retries = 0;
  let callsAnswered = 0;
  let featuresPlayed = 0;

  const record = (call: string, elapsed: number): void => {
    callsAnswered += 1;
    const bucket = samples.get(call) ?? [];
    bucket.push(elapsed);
    samples.set(call, bucket);
  };

  const once = async <N extends CallName>(
    call: N,
    body: CallRequest<N>,
  ): Promise<CallResponse<N>> => {
    const started = nowMs();
    const response = await fetchImpl(`${url}${routeFor(call)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json: unknown = await response.json();
    record(call, nowMs() - started);
    if (response.ok) return CALLS[call].res.parse(json) as CallResponse<N>;
    const payload = json as ProtocolErrorPayload;
    errorsByCode.set(payload.code, (errorsByCode.get(payload.code) ?? 0) + 1);
    throw new RefusedError({ status: response.status, payload });
  };

  /** The retry policy, as the client has it: RECOVERABLE only, same request, server's delay wins. */
  const call = async <N extends CallName>(
    name: N,
    body: CallRequest<N>,
  ): Promise<CallResponse<N>> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await once(name, body);
      } catch (error) {
        if (!(error instanceof RefusedError)) throw error;
        const { code, retryAfterMs } = error.refusal.payload;
        if (classOf(code) !== 'RECOVERABLE') throw error;
        retries += 1;
        if (code === 'RATE_LIMITED') {
          // Being paced is the server working, not failing — so it does not spend the ordinary
          // attempt budget. But the server's retryAfterMs is the refill time for *one* token;
          // under N contenders it is systematically short, and a swarm that all comes back at
          // once just collides again. Scale the wait by how long we have been queuing and add
          // jitter to decorrelate the workers. A server that never yields is still a finding.
          if (attempt >= 1_000) throw error;
          const base = Math.max(retryAfterMs ?? 20, 20);
          await sleep(base * Math.min(attempt, 25) + Math.random() * 30);
          continue;
        }
        if (attempt >= MAX_ATTEMPTS) throw error;
        await sleep(retryAfterMs ?? Math.min(250 * 2 ** (attempt - 1), 5_000));
      }
    }
  };

  const opening = ((await call('authenticate', { token })) as AuthenticateRes).balance;

  let staked = 0;
  let credited = 0;

  const playRound = async (): Promise<void> => {
    const id = roundId();
    const spin = await call('spin', { roundId: id, stake: stake as never });
    staked += stake;
    let next: string = spin.next;
    let step = 0;
    if (next === 'FEATURE_SPIN') featuresPlayed += 1;
    while (next === 'FEATURE_SPIN') {
      step += 1;
      next = (await call('featureSpin', { roundId: id, step })).next;
    }
    if (next === 'SETTLE') {
      // The await stays OUTSIDE the compound assignment: `credited += (await …)` reads the left
      // side *before* suspending (spec order), so every worker that lands a win while this one
      // is parked gets silently overwritten on resume. This tool's first confirmed finding was
      // this line's previous form — a lost-update race in its own accounting, reproducible only
      // at concurrency, which is precisely the class of bug the tool exists to surface.
      const settled = await call('settle', { roundId: id });
      credited += settled.totalWin;
    }
  };

  const started = nowMs();
  await Promise.all(
    Array.from({ length: connections }, async () => {
      for (let round = 0; round < rounds; round += 1) await playRound();
    }),
  );
  const elapsedMs = nowMs() - started;

  const closing = ((await call('authenticate', { token })) as AuthenticateRes).balance;

  const byCall: Record<string, LatencySummary> = {};
  for (const [name, bucket] of samples.entries()) byCall[name] = summarize(bucket);

  return {
    url,
    connections,
    roundsPlayed: connections * rounds,
    featuresPlayed,
    elapsedMs,
    callsAnswered,
    retries,
    byCall,
    errorsByCode: Object.fromEntries(errorsByCode.entries()),
    balance: { opening, closing, expected: opening - staked + credited },
  };
}
