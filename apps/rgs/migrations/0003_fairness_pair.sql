-- R4: the fairness pair, bound to the round at open (docs/protocol.md §9, D11; ADR-0006).
--
-- The seed is what every step of the round derives from — persisted so a restart can still
-- resolve a stranded round identically and reveal honestly at the close. The commitment is the
-- SHA-256 the player held before betting; `authenticate` re-reports it on `pendingRound`.
--
-- The empty-string default exists only for rows opened before R4; the domain writes both fields
-- on every open, and a pre-R4 row simply has no fairness story to tell (the wire omits the
-- fairness block when the commitment is not well-formed).

alter table rounds add column server_seed text not null default '';
alter table rounds add column commitment text not null default '';
