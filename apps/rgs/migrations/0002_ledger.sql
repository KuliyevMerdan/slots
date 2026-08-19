-- R3: the double-entry ledger (docs — CLAUDE.md "apps/rgs", ADR-0005).
--
-- One table, append-only, integer minor units. Each row is one money movement with both legs
-- explicit; seq is the journal order the folds and the reconciliation read in.
--
-- Two absences are deliberate:
--   * No foreign key to rounds. The ledger can legitimately hold entries for a round that never
--     came to exist — a debit whose store open failed and whose rollback could not be delivered is
--     exactly the orphan the reconciliation job exists to find, and a constraint would make it
--     unrecordable.
--   * No UPDATE or DELETE path — enforced by trigger, not promised by code review. A correction
--     is a new entry; history is immutable, as in any book of account.

create table ledger_entries (
  seq            bigint generated always as identity primary key,
  round_id       uuid not null,
  player_id      text not null,
  kind           text not null check (kind in ('STAKE', 'WIN', 'ROLLBACK')),
  debit_account  text not null check (debit_account in ('PLAYER_BALANCE', 'GAME_ROUNDS')),
  credit_account text not null check (credit_account in ('PLAYER_BALANCE', 'GAME_ROUNDS')),
  amount         bigint not null check (amount >= 0),
  ref            text not null,
  recorded_at    bigint not null,
  check (debit_account <> credit_account)
);

-- The read paths: per-round entries for the gate and per-ref history for the idempotency verdict.
create index ledger_entries_round on ledger_entries (round_id, seq);
create index ledger_entries_ref on ledger_entries (ref, seq);

create function ledger_entries_are_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'ledger entries are append-only — a correction is a new entry';
end
$$;

create trigger ledger_entries_immutable
  before update or delete on ledger_entries
  for each row execute function ledger_entries_are_append_only();
