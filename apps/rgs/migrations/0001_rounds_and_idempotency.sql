-- R1: the round machine and the idempotency store (docs/protocol.md §3, §4).
--
-- Two tables, and the two constraints that carry the whole design:
--   * rounds.state is guarded by the application's compare-and-swap UPDATE (WHERE state = $from),
--     run inside the same transaction as the idempotency insert — a transition whose precondition
--     no longer holds updates zero rows and the transaction rolls back.
--   * idempotency_records' primary key is the uniqueness constraint that makes replay a property
--     of the storage rather than a habit of the code: a duplicate insert FAILS, and that failure
--     is what routes a racing retry to the recorded answer.
--
-- Money is bigint minor units (ADR-0002). JSONB carries wire shapes (results, feature progress,
-- recorded responses) verbatim — they are validated at the boundary by the shared schemas, and the
-- database stores what the wire said rather than a second modelling of it.

create table rounds (
  round_id       uuid primary key,
  -- Monotonic insertion order. openedAt comes from an injected clock that tests deliberately
  -- freeze, so "newest first" needs an order the clock cannot flatten.
  seq            bigint generated always as identity,
  player_id      text not null,
  state          text not null check (state in ('OPEN', 'RESOLVED', 'SETTLED')),
  stake          bigint not null check (stake > 0),
  cumulative_win bigint not null default 0 check (cumulative_win >= 0),
  capped         boolean not null default false,
  client_seed    text,
  fingerprint    text not null,
  feature        jsonb,
  last_result    jsonb,
  steps          integer not null default 0 check (steps >= 0),
  opened_at      bigint not null
);

-- The lookup paths: recovery reads the player's oldest in-flight round; history reads the
-- player's newest settled ones.
create index rounds_player_pending on rounds (player_id, seq) where state <> 'SETTLED';
create index rounds_player_settled on rounds (player_id, seq desc) where state = 'SETTLED';

create table idempotency_records (
  round_id    uuid not null references rounds (round_id) on delete cascade,
  -- "call" is a keyword; the suffix costs nothing and keeps every query unquoted.
  call_name   text not null check (call_name in ('spin', 'featureSpin', 'settle')),
  step        integer not null check (step >= 0),
  fingerprint text not null,
  response    jsonb not null,
  primary key (round_id, call_name, step)
);
