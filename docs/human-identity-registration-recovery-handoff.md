# Human Identity Registration Recovery Handoff

> Purpose: this note preserves the important context from the Silverhand
> conversation before the local DB is restored. Use it after restoring an old
> `~/.silverhand` backup so the registration migration can be validated without
> relying on chat history.

## 1. Why This Exists

The local `~/.silverhand` DB was accidentally cleared while implementing the
V1 human identity registration work. The code changes survived in the repo, but
the Silverhand conversation history may disappear again when the backup DB is
restored.

The requirement recovered from recent Claude Code and Codex records was:

- Add a real `users` table for human identity.
- A `users` row means a registered identity only.
- There is no placeholder user, no `onboarding_required`, and no magic `local`
  user alias.
- Before registration, `app_settings.viewer_user_id` is absent.
- `POST /api/register` is the only public entry point that creates a `users`
  row, and it writes `viewer_user_id` in the same transaction.
- Before registration, public routes are blocked with
  `registration_required`, except:
  - `GET /api/me`
  - `POST /api/register`
  - `GET /api/health`
- `GET /api/me` returns either a `UserDto` or
  `{ registration_required: true, suggested_name: string }`.
- The desktop app shows a full-screen registration gate before the normal app
  shell.
- Registration collects `name`, `display_name`, and avatar.
- `name` is permanent after registration; Settings -> Profile can only edit
  `display_name` and avatar.

## 2. The Dangerous Behavior We Found

`pnpm dev` itself was not deleting `~/.silverhand`.

The dangerous behavior was inside the old v21 migration body: the first startup
of any DB that had not yet applied v21 could silently clear legacy user-owned
data while rebuilding the schema.

The old destructive migration path could:

- NULL old `messages.from_user_id`
- NULL old `messages.task_assignee_user_id`
- NULL old `notifications.user_id`
- delete all `conversation_reads`
- delete user-owned `attachments`

That is unsafe because restoring an old backup and starting the app should not
silently erase historical chat state.

## 3. Final Solution: Deferred Adoption

The reviewed solution is called Deferred Adoption.

It splits the migration into two phases:

1. v21 migration stages old user-owned facts without requiring a registered
   user yet.
2. `POST /api/register` adopts those staged facts into the newly created viewer
   inside the same transaction that creates the user.

This lets the product keep the clean identity invariant while preserving old
backup data.

### v21 Migration

v21 creates the final `users` table, but keeps it empty until registration.

It creates four temporary staging tables:

| Table | Preserved data |
|---|---|
| `legacy_message_from_user_v21` | message ids whose old `from_kind='user'` and `from_user_id IS NOT NULL` |
| `legacy_message_task_assignee_user_v21` | task message ids whose old `task_number IS NOT NULL` and `task_assignee_user_id IS NOT NULL` |
| `legacy_conversation_reads_v21` | old read cursors, including original legacy user id |
| `legacy_user_attachments_v21` | full user-owned attachment rows |

Then v21 rebuilds the live tables into a FK-clean pre-registration state:

- `messages.from_user_id` becomes NULL in the live table, with attribution
  preserved by staging ids.
- `messages.task_assignee_user_id` becomes NULL in the live table, with
  assignment preserved by staging ids.
- `conversation_reads` starts empty in the live table, with old rows preserved
  in staging.
- user-owned attachments are moved out of live `attachments` into staging so
  the new polymorphic owner trigger cannot reject them before a user exists.
- `notifications.user_id` is intentionally not staged; old notifications are
  mostly system-owned, and bulk adopting them would over-claim.

### Register-Time Adoption

When registration succeeds, `UserService.register()` does all of this in one
transaction:

1. INSERT the real `users` row.
2. Write `app_settings.viewer_user_id`.
3. Adopt staged message authorship into the new viewer id.
4. Adopt staged task assignees into the new viewer id.
5. Merge staged read cursors by `conversation_id` using
   `MAX(last_read_seq)` and `MAX(read_at)`.
6. Reinsert staged user attachments into live `attachments` with
   `created_by_kind='user'` and `created_by_id=viewerId`.
7. Write audit keys:
   - `legacy_v21_adoption_completed_at`
   - `legacy_v21_adoption_counts`
8. DROP the four staging tables.

If any step fails, the whole transaction rolls back: no user row, no
`viewer_user_id`, no audit rows, and staging remains intact for retry.

## 4. Implementation Status

The implementation was completed by Alice and reviewed twice by Cindy.

Round 1 review:

- Main Deferred Adoption path was accepted.
- Four cleanup comments were requested:
  - replace stale wipe/no-upgrade comments in v21 tests;
  - replace stale wipe/no-upgrade comments in v22 migration;
  - fix the inaccurate `conversation_reads_legacy_v21 was emptied above`
    comment;
  - use `SETTINGS_KEYS.LEGACY_V21_ADOPTION_*` constants for audit writes and
    correct the transaction comment.

Round 2 review:

- All four cleanup comments were fixed.
- No new blocker was found.
- Cindy final verdict: LGTM.

Important files:

- `packages/shared/src/db/migrations.ts`
  - v21 Deferred Adoption migration.
  - v22 remains a no-op compatibility stub.
- `packages/backend/src/services/user-service.ts`
  - `register()` transaction and `adoptLegacyV21()` helper.
- `packages/backend/src/repos/settings-repo.ts`
  - `VIEWER_USER_ID`
  - `LEGACY_V21_ADOPTION_COMPLETED_AT`
  - `LEGACY_V21_ADOPTION_COUNTS`
- `packages/backend/tests/db-migrations.test.ts`
  - v21 staging contract tests.
- `packages/backend/tests/services/user-service-adoption.test.ts`
  - register-time adoption tests.
- `docs/human-identity-migration-cleanup-plan.md`
  - future cleanup plan after the backup has been restored and adopted.

The worktree was intentionally left uncommitted during review.

## 5. Implementation Anchors

Use these file pointers when rebuilding context after the DB restore:

- `packages/shared/src/db/migrations.ts`
  - v21 contains the core migration contract: four `legacy_*_v21` staging
    tables plus non-destructive FK rebuilds.
  - v22 is intentionally still a no-op compatibility stub.
- `packages/backend/src/services/user-service.ts`
  - `UserService.register()` creates the viewer.
  - `adoptLegacyV21(db, viewerId)` consumes staging.
  - Adoption must run inside the same transaction as registration.
- `packages/backend/src/repos/settings-repo.ts`
  - `SETTINGS_KEYS.VIEWER_USER_ID`
  - `SETTINGS_KEYS.LEGACY_V21_ADOPTION_COMPLETED_AT`
  - `SETTINGS_KEYS.LEGACY_V21_ADOPTION_COUNTS`
- `packages/backend/tests/services/user-service-adoption.test.ts`
  - This is the executable spec for the register-time bridge.
- `packages/backend/tests/db-migrations.test.ts`
  - v21 staging tests verify the historical migration contract.
- `docs/human-identity-migration-cleanup-plan.md`
  - Follow-up cleanup plan. Do not execute it until the real backup has been
    restored, registered, and verified.

Hard constraints from review:

- staging table names are fixed:
  - `legacy_message_from_user_v21`
  - `legacy_message_task_assignee_user_v21`
  - `legacy_conversation_reads_v21`
  - `legacy_user_attachments_v21`
- audit keys are fixed:
  - `legacy_v21_adoption_completed_at`
  - `legacy_v21_adoption_counts`
- `legacy_v21_adoption_completed_at` stores `Date.now()` as a decimal string.
- `legacy_v21_adoption_counts` stores JSON with exactly:
  - `messages_from`
  - `messages_task`
  - `conversation_reads`
  - `attachments`
- `conversation_reads` adoption uses
  `MAX(last_read_seq), MAX(read_at) GROUP BY conversation_id`.
- user-owned attachments are reinserted with an 11-column INSERT-SELECT, not
  updated in place. v21 removes them from the live table before registration
  because the polymorphic owner trigger would reject a user owner before the
  `users` row exists.
- adoption failure must roll back the entire registration transaction. Do not
  catch an adoption error and continue with a registered viewer.

## 6. Verification Already Run

The reviewed patch passed:

```bash
pnpm -r typecheck
pnpm --filter @silverhand/backend test -- packages/backend/tests/db-migrations.test.ts packages/backend/tests/services/user-service-adoption.test.ts
pnpm --filter @silverhand/desktop test
git diff --check
```

Observed results during review:

- backend Vitest ran 59 files / 718 tests successfully.
- desktop Vitest ran 11 files / 191 tests successfully.
- typecheck passed across shared, cli, backend, and desktop.
- `git diff --check` passed.

## 7. Safe Backup Restore Procedure

Before restoring, stop the running app and any `pnpm dev` process.

Keep an extra copy of whatever currently exists:

```bash
mv ~/.silverhand ~/.silverhand.before-restore-$(date +%Y%m%d-%H%M%S)
```

Restore the old backup into:

```bash
~/.silverhand
```

Before starting the app, inspect the restored DB:

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
   WHERE type='table' AND name LIKE 'legacy_%_v21'
   ORDER BY name;
"
```

Interpretation:

- If max migration version is below 21, this is the ideal path. Start the app
  with the Deferred Adoption code and v21 will stage old data.
- If v21/v22 are already applied and `legacy_*_v21` staging tables exist, the
  DB has already run a staging-capable migration and registration should adopt.
- If v21/v22 are already applied, no staging tables exist, and no
  `viewer_user_id` exists, stop and inspect before continuing. This may be an
  old intermediate/destructive v21 state that #task:5 does not repair.
- If `viewer_user_id` already exists, the DB may already be registered or may
  be an older placeholder/local-user state. Inspect before assuming the
  registration gate will appear.

## 8. Expected Product Path After Restore

Start the app from the current working tree:

```bash
pnpm dev
```

Expected flow for a pre-v21 backup:

1. Backend opens the DB and runs v21.
2. v21 creates `users` but leaves it empty.
3. v21 creates and fills the four `legacy_*_v21` staging tables.
4. App opens the registration gate instead of the normal app shell.
5. Register the human identity.
6. `POST /api/register` creates the viewer and adopts staged legacy data.
7. The normal app shell opens.
8. Old chats, old attachments, task assignees, and read cursors should still be
   available.

## 9. Post-Registration DB Verification

Run this after registration:

```bash
sqlite3 ~/.silverhand/silverhand.db "
  SELECT version, name FROM _migrations ORDER BY version DESC LIMIT 5;

  SELECT id, name, display_name FROM users;

  SELECT key, value FROM app_settings
   WHERE key IN (
     'viewer_user_id',
     'legacy_v21_adoption_completed_at',
     'legacy_v21_adoption_counts'
   )
   ORDER BY key;

  SELECT name FROM sqlite_schema
   WHERE type='table' AND name LIKE 'legacy_%_v21'
   ORDER BY name;

  PRAGMA foreign_key_check;
"
```

Expected:

- v21 and v22 are applied.
- `users` has exactly one V1 viewer row.
- `viewer_user_id` equals that user's `id`.
- `legacy_v21_adoption_completed_at` exists.
- `legacy_v21_adoption_counts` exists.
- No `legacy_*_v21` staging tables remain.
- `PRAGMA foreign_key_check` returns no rows.

Useful follow-up checks:

```bash
sqlite3 ~/.silverhand/silverhand.db "
  SELECT COUNT(*) AS user_messages
    FROM messages
   WHERE from_kind='user' AND from_user_id = (
     SELECT value FROM app_settings WHERE key='viewer_user_id'
   );

  SELECT COUNT(*) AS user_assigned_tasks
    FROM messages
   WHERE task_number IS NOT NULL
     AND task_assignee_user_id = (
       SELECT value FROM app_settings WHERE key='viewer_user_id'
     );

  SELECT COUNT(*) AS user_attachments
    FROM attachments
   WHERE created_by_kind='user'
     AND created_by_id = (
       SELECT value FROM app_settings WHERE key='viewer_user_id'
     );

  SELECT COUNT(*) AS read_cursors
    FROM conversation_reads
   WHERE user_id = (
     SELECT value FROM app_settings WHERE key='viewer_user_id'
   );
"
```

The exact counts depend on the backup. For a dirty pre-v21 backup, non-zero
counts are expected when historical user messages, user task assignees,
attachments, or read cursors existed.

## 10. Manual UI Verification

After registration, check:

- old conversations are visible;
- old user-authored messages render as the current viewer;
- old tasks that were assigned to the legacy user show the registered viewer
  as the assignee;
- old attachments open/download and preserve the original filename;
- unread/read position is not reset to zero unexpectedly;
- Settings -> Profile shows:
  - immutable `name`;
  - editable `display_name`;
  - editable avatar.

## 11. Known Boundary

#task:5 protects DBs that have not yet applied v21, plus DBs that already have
the new staging tables.

It does not repair a DB that has already applied an older destructive v21 and
lost data before this patch existed. In that case there may be no staging data
left to adopt.

If the restored backup is already in a v21/v22 intermediate state without
staging, do not treat that as the normal path. It needs a separate corrective
migration or manual inspection. The cleanup plan documents this as a future
v23-style guard/corrective decision.

## 12. After Successful Restore

After the real backup is restored and registration/adoption is verified:

1. Decide whether old pre-v21 backups should remain supported.
2. If yes, keep Deferred Adoption code and tests in place.
3. If no, follow `docs/human-identity-migration-cleanup-plan.md`.
4. Only then ask Alice to commit the reviewed implementation.

Do not edit the v21 migration body after it has shipped to any DB. Future
changes must use a new monotonic migration version.
