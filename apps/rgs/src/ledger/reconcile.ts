import type { Minor, RoundId } from '@slot/protocol';
import { ZERO, add, subtract } from '@slot/money';
import { playerDeltaOf } from './ledger.js';
import type { Ledger, LedgerEntry } from './ledger.js';
import type { RoundStore } from '../persistence/store.js';
import type { WalletProvider } from '../wallet/provider.js';

/**
 * The reconciliation job: true the ledger against the wallet and report drift (R3).
 *
 * Two independent axes, because the two failure modes are different:
 *
 * - **Balance drift.** For each player, the wallet's actual balance is compared with what the
 *   journal implies: the caller's `opening` figure plus the ledger's net player delta over the
 *   window. A movement the wallet performed that the journal never learned of — a ledger write
 *   lost to a crash, a rollback delivered but not recorded — shows up here as a signed number.
 *   The baseline is the caller's because the ledger records *movements*, not balances: an
 *   absolute figure has to come from whoever observed the wallet when the window opened.
 *
 * - **Orphaned stakes.** A ref whose entries net to a standing debit while the store holds no
 *   round under it: the debit was confirmed, the round never came to exist, and the rollback
 *   could not be delivered. The wallet and the ledger *agree* in that state — both are down one
 *   stake — which is exactly why balance-truing alone would never find it, and why the domain
 *   journals the stake before it opens the round. Sound wherever the store retains every round it
 *   ever opened (Postgres does); a store that evicts settled rounds (the in-memory one, past its
 *   retention) can surface a false orphan for an evicted zero-win round, which is one more reason
 *   the dev composition's report is informational and the deployed one runs on Postgres.
 *
 * What this deliberately is not: transaction-level truing against the operator's statement. The
 * wallet wire (docs/wallet-api.md) exposes balances and idempotent movements, not a statement
 * export — matching journals entry-for-entry is a settlement-file exercise between two back
 * offices, and an ops concern (R7), not a wire call this seam should invent.
 */

export interface PlayerExpectation {
  readonly playerId: string;
  /** The wallet balance observed when this reconciliation window opened. */
  readonly opening: Minor;
  /** Scope the balance axis to entries recorded at or after this instant (epoch ms). */
  readonly since?: number;
}

export interface PlayerReconciliation {
  readonly playerId: string;
  readonly opening: Minor;
  /** The journal's net player movement over the window — signed. */
  readonly ledgerDelta: Minor;
  readonly expected: Minor;
  readonly actual: Minor;
  /** `actual − expected`. Zero is the only clean answer. */
  readonly drift: Minor;
}

export interface OrphanedStake {
  readonly roundId: RoundId;
  readonly playerId: string;
  /** The standing debit: stakes journaled minus rollbacks journaled, under this round's ref. */
  readonly amount: Minor;
  /** When the standing stake was journaled. */
  readonly at: number;
}

export interface ReconciliationReport {
  readonly players: readonly PlayerReconciliation[];
  readonly orphans: readonly OrphanedStake[];
  readonly clean: boolean;
}

export interface ReconcileDeps {
  ledger: Ledger;
  wallet: WalletProvider;
  store: RoundStore;
  players: readonly PlayerExpectation[];
}

const standingStakes = (entries: readonly LedgerEntry[]): Map<RoundId, OrphanedStake> => {
  const byRound = new Map<RoundId, OrphanedStake>();
  for (const entry of entries) {
    if (entry.kind === 'WIN') continue;
    const current = byRound.get(entry.roundId) ?? {
      roundId: entry.roundId,
      playerId: entry.playerId,
      amount: ZERO,
      at: entry.at,
    };
    byRound.set(entry.roundId, {
      ...current,
      amount:
        entry.kind === 'STAKE'
          ? add(current.amount, entry.amount)
          : subtract(current.amount, entry.amount),
      at: entry.at,
    });
  }
  return byRound;
};

export async function reconcile({
  ledger,
  wallet,
  store,
  players,
}: ReconcileDeps): Promise<ReconciliationReport> {
  const reconciled: PlayerReconciliation[] = [];
  for (const { playerId, opening, since } of players) {
    const windowed = await ledger.entries(since === undefined ? {} : { since });
    const ledgerDelta = playerDeltaOf(windowed, playerId);
    const expected = add(opening, ledgerDelta);
    const actual = await wallet.getBalance(playerId);
    reconciled.push({
      playerId,
      opening,
      ledgerDelta,
      expected,
      actual,
      drift: subtract(actual, expected),
    });
  }

  // The orphan scan reads the whole journal: an orphan does not stop being one because the
  // reconciliation window moved past it.
  const orphans: OrphanedStake[] = [];
  for (const candidate of standingStakes(await ledger.entries()).values()) {
    if (candidate.amount <= ZERO) continue;
    if ((await store.find(candidate.roundId)) === undefined) orphans.push(candidate);
  }

  return {
    players: reconciled,
    orphans,
    clean: reconciled.every((player) => player.drift === ZERO) && orphans.length === 0,
  };
}
