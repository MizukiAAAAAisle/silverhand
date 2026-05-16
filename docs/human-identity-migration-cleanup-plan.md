# Human Identity Migration Cleanup Plan

> Status: **Mode B cleanup landed.** The Deferred Adoption bridge has
> been removed from runtime — `UserService.register()` no longer calls
> `adoptLegacyV21`, the `LEGACY_V21_ADOPTION_*` settings keys are
> gone, and migration v23 (`remove_v21_adoption_bridge`) drops the
> empty staging tables on every DB / refuses to apply when staging
> still holds unadopted rows. Migration v24 removes the two historical
> `legacy_v21_adoption_*` audit rows from `app_settings`. v21's body is
> preserved unmodified (mutating an applied migration is forbidden), and its
> staging-creation contract tests stop at v22 to remain meaningful.
> This file is now historical reference for how the bridge worked
> and how it was retired.

## 1. Background

The V1 human identity rewrite changes the product model from an implicit
single local user to an explicit registered human row:

- `users` rows mean registered identities only.
- Pre-registration means `app_settings.viewer_user_id` is absent.
- `POST /api/register` is the only public creator of `users` rows and writes
  `viewer_user_id` in the same transaction.
- Before registration, public routes are gated except `GET /api/me`,
  `POST /api/register`, and `GET /api/health`.

The tricky part is old local DBs. Earlier schemas stored user references as
loose strings such as `local` without a `users` table. After the rewrite,
those references must point at a real `users.id`. If we rebuild the schema
directly, the old ids are invalid.

Deferred Adoption solves this by temporarily moving legacy user-owned state
into staging tables during v21, then adopting it into the newly registered
viewer inside `POST /api/register`.

## 2. Current Deferred Adoption Flow

When an old pre-v21 DB starts:

1. v21 creates the final `users` table but leaves it empty.
2. v21 rebuilds user-FK tables so the main schema is valid immediately.
3. v21 moves legacy user-owned facts into staging tables:

| Staging table | Meaning |
|---|---|
| `legacy_message_from_user_v21` | Message ids whose old `from_user_id` was non-null |
| `legacy_message_task_assignee_user_v21` | Task message ids whose old `task_assignee_user_id` was non-null |
| `legacy_conversation_reads_v21` | Old read cursors, before merging into one V1 viewer |
| `legacy_user_attachments_v21` | Full old user-owned attachment rows |

When the human submits the registration form:

1. `UserService.register()` inserts the real `users` row.
2. It writes `app_settings.viewer_user_id`.
3. In the same transaction, it adopts staged data to that new viewer id:
   - user-authored message rows get `from_user_id = viewerId`;
   - user-assigned task rows get `task_assignee_user_id = viewerId`;
   - conversation read cursors merge by `conversation_id` using
     `MAX(last_read_seq)` and `MAX(read_at)`;
   - user-owned attachments are inserted back into `attachments` with
     `created_by_kind = 'user'` and `created_by_id = viewerId`.
4. It writes audit keys in `app_settings`:
   - `legacy_v21_adoption_completed_at`
   - `legacy_v21_adoption_counts`
5. It drops the four staging tables.

This keeps the final product invariant clean: staging is not a permanent user
state. It is only a bridge from old implicit V1 data to the first explicit
registered viewer.

## 3. Cleanup Goal

After the migration has landed and the old backup data has been successfully
adopted, we should decide whether the bridge still needs to support future
old-backup restores. If not, remove the temporary bridge code so the
steady-state system is simple again:

- no staging-table handling in runtime registration code;
- no tests that imply staging is part of the long-term product model;
- no docs telling users to rely on staging after the cutoff;
- no leftover staging tables in the user's active DB.

The target steady state is:

- migrations create the final `users` schema;
- `POST /api/register` only creates the registered viewer and optional profile
  data;
- historical backup adoption has already completed and was verified before the
  final v24 audit-KV cleanup;
- future V2 multi-human work uses auth/token identity and invite tables, not
  this V1 staging bridge.

If we still want restored pre-v21 backups to keep working later, the steady
state is different: keep Deferred Adoption as an upgrade path. There is no
cleanup action in this mode. Successful adoption drops staging inside the
registration transaction, so adopted DBs should not have leftover staging
tables.

## 4. Do Not Clean Up Too Early

Do not remove Deferred Adoption while any target DB may still need it.

Specifically, keep it if any of these are true:

- the user's backup has not yet been restored and registered;
- `_migrations` in the restored DB is below v21;
- staging tables still exist in the active DB;
- `app_settings.viewer_user_id` is absent;
- `legacy_v21_adoption_completed_at` is absent after registration;
- the team still wants old pre-v21 backups to start and self-adopt.

If we still need to support old backups, v21 and the register adoption helper
must remain intact. Removing them would turn "restore backup and start app" back
into a broken or lossy path.

## 5. Cleanup Checklist

Run this inspection on the active DB first:

```bash
sqlite3 ~/.silverhand/silverhand.db "
  SELECT version, name FROM _migrations ORDER BY version DESC LIMIT 5;
  SELECT key, value FROM app_settings
   WHERE key IN (
     'viewer_user_id',
     'legacy_v21_adoption_completed_at',
     'legacy_v21_adoption_counts'
   );
  SELECT name FROM sqlite_schema
   WHERE type='table'
     AND name IN (
       'legacy_message_from_user_v21',
       'legacy_message_task_assignee_user_v21',
       'legacy_conversation_reads_v21',
       'legacy_user_attachments_v21'
     );
  PRAGMA foreign_key_check;
"
```

Proceed only if:

- v21 and v22 are applied;
- `viewer_user_id` exists;
- adoption audit keys exist;
- no staging tables remain;
- `PRAGMA foreign_key_check` returns no rows;
- manual UI verification confirms old messages, attachments, and read position
  are present after registration.

## 6. Code Cleanup Plan

### Step 1: Decide the Support Window

There are two valid cleanup modes. Pick one explicitly.

**Mode A: still support old backups**

Do not edit v21 to remove staging. Migrations are part of the upgrade path. In
this mode, keep the register-time adoption helper as long as a restored old DB
may appear. Steady-state action is none.

The cost is one extra migration plus a small adoption helper in `register()`
that lives indefinitely. This is acceptable as long as restoring an old backup
remains a supported user path.

**Mode B: no longer support old pre-v21 backups**

If we deliberately stop supporting old backups, do not edit the v21 migration
body. Once v21 has been applied by any DB, its body is history: changing it
would make already-applied and not-yet-applied DBs follow different schema
paths while both claim the same migration version.

Instead:

- add a new monotonic migration, e.g. v23;
- v23 asserts no `legacy_*_v21` staging tables exist;
- remove register-time adoption runtime in the same change;
- keep v21 body and its v21 contract tests intact.

v23 must fail fast if staging tables are present:

```ts
// In packages/shared/src/db/migrations.ts, add a `precondition` to
// the v23 entry. SQL `RAISE(ABORT, ...)` is **not** valid in standalone
// statements (SQLite restricts it to trigger programs), so the runner
// supports a code-level precondition that runs inside the same
// transaction as the migration's `up` body. Throwing aborts the
// transaction, leaves `_migrations.version=23` unwritten, and is
// retried on next boot.
{
  version: 23,
  name: 'remove_v21_adoption_bridge',
  precondition: db => {
    const sqliteDb = db as { prepare: (s: string) => any; pragma: (c: string) => any };
    const stagingNames = [
      'legacy_message_from_user_v21',
      'legacy_message_task_assignee_user_v21',
      'legacy_conversation_reads_v21',
      'legacy_user_attachments_v21',
    ];
    const present = sqliteDb
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type='table' AND name IN (${stagingNames.map(() => '?').join(',')})`,
      )
      .all(...stagingNames) as Array<{ name: string }>;
    const nonEmpty: Array<{ name: string; rows: number }> = [];
    for (const { name } of present) {
      const r = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number };
      if (r.n > 0) nonEmpty.push({ name, rows: r.n });
    }
    if (nonEmpty.length > 0) {
      throw new Error(
        `v23 cleanup: legacy_*_v21 staging tables still hold unadopted rows`,
      );
    }
    const fk = sqliteDb.pragma('foreign_key_check') as unknown[];
    if (fk.length > 0) {
      throw new Error(`v23 cleanup: foreign_key_check found ${fk.length} violation(s)`);
    }
  },
  up: `
    DROP TABLE IF EXISTS legacy_message_from_user_v21;
    DROP TABLE IF EXISTS legacy_message_task_assignee_user_v21;
    DROP TABLE IF EXISTS legacy_conversation_reads_v21;
    DROP TABLE IF EXISTS legacy_user_attachments_v21;
  `,
}
```

Notes:

- v23 NEVER drops a non-empty staging table — silently dropping would
  lose the user's old messages / reads / attachments. Empty staging
  tables (created by v21 on a fresh install whose source tables were
  already empty) are dropped by the `up` body, which is safe by
  construction.
- `PRAGMA foreign_key_check` returns rows for violations and does
  **not** raise on its own; the precondition must inspect the rows
  array itself.

This is only acceptable after the team agrees the old-backup migration window is
closed.

### Step 2: Remove Register-Time Adoption Runtime

Only do this in Mode B.

In `packages/backend/src/services/user-service.ts`:

- remove the staging-table existence checks;
- remove adoption DML for messages, tasks, reads, and attachments;
- remove adoption count calculation;
- remove writes to `legacy_v21_adoption_completed_at` and
  `legacy_v21_adoption_counts`;
- keep the core `register()` transaction for `users` insert +
  `viewer_user_id` write.

Keep `already_registered` behavior unchanged.

### Step 3: Add v23 Guard Migration In Mode B

Do not add a migration that drops *non-empty* staging tables.

Staging tables can legally remain non-empty when v21 ran but
registration has not completed. In that state they may contain the
user's old messages, reads, and attachments waiting to be adopted.
Dropping them would silently lose data.

The Mode B migration should:

- assert no `legacy_*_v21` staging tables hold rows;
- abort with an explicit "register first" message if any do;
- run `PRAGMA foreign_key_check` and abort on any violation;
- DROP the (now provably-empty) staging tables in its `up` body so
  the steady-state schema no longer carries dead bridge tables.

If all staging tables were dropped by successful registration before
v23 runs, the precondition is a no-op and the `up` body's
`DROP TABLE IF EXISTS` is also a no-op.

### Step 4: Update Tests

Remove or narrow tests whose only purpose was Deferred Adoption:

- register adoption tests (Mode B only);
- rollback tests for register-time staging preservation (Mode B only);
- audit count tests (Mode B only).

Keep v21 staging-creation tests even in Mode B. They verify historical v21's
contract and protect DBs that have not yet applied v21.

Keep tests for the permanent identity model:

- `GET /api/me` returns `registration_required` before registration;
- `POST /api/register` creates exactly one registered viewer;
- second register returns `already_registered`;
- `users.name` is alpha-first and globally unique against `agents.name`;
- app shell is gated until registration;
- profile update cannot rename `users.name`.

### Step 5: Update Docs

Update or remove temporary language in:

- this document;
- `CLAUDE.md`;
- `docs/progress.md`;
- migration comments near v21/v22;
- any implementation checklist created for Deferred Adoption.

Keep the durable rule:

> `pnpm dev` and `pnpm dev:clean` must never clear `~/.silverhand` or silently
> erase DB data. Data reset must remain an explicit user action.

## 7. Verification After Cleanup

Run:

```bash
pnpm -r typecheck
pnpm test
pnpm --filter @silverhand/desktop test
```

Then inspect the active DB:

```bash
sqlite3 ~/.silverhand/silverhand.db "
  SELECT id, name, display_name FROM users;
  SELECT key, value FROM app_settings WHERE key='viewer_user_id';
  SELECT name FROM sqlite_schema WHERE name LIKE 'legacy_%_v21';
  PRAGMA foreign_key_check;
"
```

Expected:

- exactly one registered viewer for V1;
- `viewer_user_id` points to that viewer;
- no staging tables remain;
- no FK violations.

Finally, launch the app and manually verify:

- old chats are visible;
- old user-authored messages render as the current viewer;
- old user-owned attachments still open;
- old attachments download/display with the original filename;
- old conversation unread counts match the pre-registration read cursor merge
  semantics and are not reset to zero by cleanup;
- Settings -> Profile shows immutable `name` and editable display name/avatar.

Cleanup is a one-way product decision. If we remove the bridge and later decide
old backups must be supported again, restore the v21 staging-creation and
register adoption helper from git history as a coherent pair. Do not try to
patch a partial bridge into a later migration; that risks schema drift across
DBs with different `_migrations` histories.

## 8. Open Decision

Before cleanup, decide and record one answer:

```text
Do we still need restored pre-v21 backups to auto-adopt in the future?
```

If yes, keep v21/adoption support. If no, remove the bridge and treat the
registered V1 identity model as the only supported local state.

Also record:

```text
V2 invite flow uses a separate pending_invites table and is unrelated to this
V1 bridge. Shipping V2 does not require closing the V1 Deferred Adoption path.
```
