-- R5: sessions become rows — operator-issued tokens a restart must not forget.
--
-- The token is the key because it is the only thing the wire ever presents (§2.7, D12). No
-- foreign key to anything: a session exists before its player has a round, and expiry is a
-- timestamp comparison the domain makes against its own clock, not a row deletion — an expired
-- session that still exists is how "the session has expired" stays distinguishable from "no such
-- token", even though both refuse the same way on the wire.

create table sessions (
  token      text primary key,
  player_id  text   not null,
  currency   text   not null,
  expires_at bigint not null
);
