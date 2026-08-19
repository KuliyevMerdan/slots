import { randomBytes } from 'node:crypto';
import { runLoad } from './run.js';
import { formatReport, reportIsClean } from './stats.js';
import { uuidV7 } from './uuid.js';

/**
 * `pnpm load` — multi-client load on the spin path (R7).
 *
 *   pnpm load                                        # 10 connections × 50 rounds at the dev URL
 *   pnpm load --url http://host:8788 --token <t>     # a deployment
 *   pnpm load --connections 50 --rounds 200          # more storm
 *
 * The tool is a swarm of honest clients: full rounds, idempotent retries under the same roundId,
 * the server's `retryAfterMs` honoured over its own backoff. It prints latency percentiles per
 * call and — the part that makes it a gate rather than a stopwatch — checks the server's closing
 * balance against its own account of every stake and credit. Drift exits non-zero: a fast server
 * that loses money under load is not a fast server.
 */

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const numberArg = (name: string, fallback: number): number => {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
};

const report = await runLoad({
  url: arg('url') ?? 'http://127.0.0.1:8788',
  token: arg('token') ?? 'rgs-demo-token',
  connections: numberArg('connections', 10),
  rounds: numberArg('rounds', 50),
  stake: numberArg('stake', 100),
  roundId: () => uuidV7(Date.now, (count) => randomBytes(count)),
});

console.log(formatReport(report));

if (!reportIsClean(report)) {
  console.error('\nthe closing balance does not match the session that was played — investigate.');
  process.exit(1);
}
