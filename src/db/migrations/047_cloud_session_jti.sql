-- Consumed one-time admin-handoff tokens (GET /admin/cloud-session). Each
-- token carries a unique `jti`; recording it here makes the token single-use —
-- a replay finds the row already present and is refused. `exp` (epoch ms) lets
-- us drop rows once the token they represent has expired, which is all the
-- cleanup a 60-second token needs; there is no value in keeping them longer.
CREATE TABLE cloud_session_jti (
  jti        TEXT PRIMARY KEY,
  exp        INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
