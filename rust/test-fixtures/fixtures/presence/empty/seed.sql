-- The empty whole-wire body: no viewers exist, so the presence answer is the
-- empty wrapper `{ "users": [] }`, not a missing field. A fresh current-schema
-- database already has no users; this no-op statement keeps the fixture a valid,
-- non-empty script both `db.exec` (better-sqlite3) and `sqlx::raw_sql` accept.
SELECT 1;
