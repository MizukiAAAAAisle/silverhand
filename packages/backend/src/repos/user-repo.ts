import type { Database as Db } from 'better-sqlite3';
import { ParticipantNameSchema, type UserRow } from '@silverhand/shared';
import { throwAsUserWriteConflict } from './sqlite-user-conflicts.js';

/**
 * Repository for the `users` table.
 *
 * Identity model:
 *   - `id` is a stable internal id (16 lowercase hex chars; generator
 *     in the service layer); never exposed to humans, never editable.
 *   - `name` is the public mention name (`@<name>`), chosen by the user at
 *     password signup, decided once and never editable after. Globally unique
 *     across `users.name` ⊕ `agents.name` — migration v21 triggers enforce
 *     this in DB; its FORMAT is enforced here, in `create` (see there
 *     for why the two halves of "what is a valid name" live in
 *     different layers). A handle is also never RECYCLED: there is no account
 *     deletion path today, and if one is added it must soft-delete or otherwise
 *     keep the handle reserved forever, because `@mentions` are re-parsed from
 *     stored message text at read time and a reused handle would silently
 *     re-point every historical mention of the previous holder (shiki,
 *     2026-08-05; `docs/auth-and-host-model.md` §3.1).
 *   - `display_name` is a human label. Editable post-registration via
 *     `updateProfile`; no uniqueness constraint.
 *
 * Avatar fields are coupled by a CHECK constraint: both NULL or both
 * non-NULL. Callers should always pass them together via `setAvatar` /
 * `clearAvatar`, never one at a time.
 *
 * Invariant: a row in `users` represents a registered identity. There
 * is no "pending user" state — pre-registration there is simply no row.
 * `create()` is the sole table INSERT helper, called by the legacy
 * profile registration service and by password signup. Callers own the
 * surrounding transaction and any credential / legacy current-viewer bridge writes.
 */
export class UserRepo {
  constructor(private readonly db: Db) {}

  get(id: string): UserRow | null {
    const row = this.db
      .prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?')
      .get(id);
    return row ?? null;
  }

  getByName(name: string): UserRow | null {
    const row = this.db
      .prepare<[string], UserRow>('SELECT * FROM users WHERE name = ?')
      .get(name);
    return row ?? null;
  }

  getByEmail(email: string): UserRow | null {
    const row = this.db
      .prepare<[string], UserRow>(
        'SELECT * FROM users WHERE email = ? COLLATE NOCASE',
      )
      .get(email);
    return row ?? null;
  }

  /**
   * List every user. V1 has at most one row (created at registration);
   * exposed for tests + future V2 admin views.
   */
  listRelated(viewerUserId: string): UserRow[] {
    return this.db.prepare<[string], UserRow>(`
      SELECT * FROM users WHERE id IN (
        SELECT wu.user_id FROM workspaces w
        JOIN workspace_users wu ON wu.workspace_id = w.id
        WHERE w.owner_user_id = ? AND w.owner_agent_id IS NULL
      ) ORDER BY created_at ASC, id ASC
    `).all(viewerUserId);
  }

  list(): UserRow[] {
    return this.db
      .prepare<[], UserRow>('SELECT * FROM users ORDER BY created_at ASC')
      .all();
  }

  /**
   * Existence, not rows: the V1 single-viewer registration gate only needs to
   * know whether ANY human identity exists. `LIMIT 1` stops at the first row
   * and no user column is selected, so the answer never depends on — nor pays
   * for — reading and ordering the table (`list().length > 0` was the
   * pre-#task:1982 form and its full-row read was never part of the contract).
   */
  anyExists(): boolean {
    const row = this.db
      .prepare<[], { one: number }>('SELECT 1 AS one FROM users LIMIT 1')
      .get();
    return row !== undefined;
  }

  touchLastSeen(id: string, seenAt: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE users
            SET last_seen_at = ?
          WHERE id = ?`,
      )
      .run(seenAt, id);
    return result.changes > 0;
  }

  /**
   * INSERT a new user row. Callers must run this inside the transaction
   * that creates any adjacent credential or bridge rows.
   *
   * The migration v21 cross-namespace uniqueness trigger throws if
   * `name` collides with an existing `agents.name`; the column UNIQUE
   * fires for collisions inside `users`, and the partial index
   * `uniq_users_email_when_set` for a duplicate login email. All of them
   * leave this method as a `UserWriteConflictError` carrying the conflicting
   * axis (`sqlite-user-conflicts.ts` is the only decoder), so neither create
   * path has to read driver messages. Anything else propagates unchanged.
   *
   * `name` FORMAT is asserted here against `ParticipantNameSchema` — the
   * single declarative authority for "what an addressable participant name
   * is" (#task:1826/1828). `users.name` IS a mention handle and every
   * production writer of it funnels through this method, so this assertion is
   * what makes "a stored human handle is mentionable" a declared property
   * instead of an emergent one. Format is a pure function of the value, so a
   * single check at the write boundary is terminal; uniqueness is a race
   * property, which is why that half legitimately lives in DB triggers.
   *
   * Since #task:1830 the signup handle is USER-supplied rather than derived from
   * an email, which raises this from a regression tripwire to the last format
   * gate on untrusted input (`AuthSignupInputSchema` is the first, at the route).
   * Neither is redundant: the route decides what the API accepts, this decides
   * what the table may hold.
   *
   * Scope note: this fences the production write path, not the table. Test
   * fixtures INSERT rows directly, and pre-existing rows predate the check, so
   * it is not a claim about what `users.name` values the DB can contain. Read
   * paths deliberately do not re-validate (`UserRow.name` stays `z.string()`),
   * so no stored row can be made unreadable by tightening this.
   */
  create(input: {
    id: string;
    name: string;
    displayName: string;
    email?: string | null;
  }): UserRow {
    if (!ParticipantNameSchema.safeParse(input.name).success) {
      throw new Error(
        `UserRepo.create: name must satisfy ParticipantNameSchema (got ${JSON.stringify(input.name)})`,
      );
    }
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO users
             (id, name, display_name, avatar_storage_key, avatar_content_type,
              email, created_at, updated_at)
           VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          input.displayName,
          input.email ?? null,
          now,
          now,
        );
    } catch (err) {
      throwAsUserWriteConflict(err);
    }
    const row = this.get(input.id);
    if (!row) {
      throw new Error(`UserRepo.create: row not found post-INSERT for id=${input.id}`);
    }
    return row;
  }

  /**
   * Update mutable profile fields. Only `display_name` is mutable
   * post-registration — `name` is intentionally not accepted here. The
   * registration boundary is the only writer of `name`.
   */
  updateProfile(
    id: string,
    input: { display_name?: string },
  ): UserRow | null {
    if (!this.get(id)) return null;
    if (input.display_name === undefined) return this.get(id);
    this.db
      .prepare(
        `UPDATE users
            SET display_name = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(input.display_name, Date.now(), id);
    return this.get(id);
  }

  /**
   * Set avatar storage_key + content_type as a unit. Caller must have
   * already persisted the blob via `BlobFileStorage.put`.
   */
  setAvatar(
    id: string,
    avatar: { storageKey: string; contentType: string },
  ): UserRow | null {
    if (!this.get(id)) return null;
    this.db
      .prepare(
        `UPDATE users
            SET avatar_storage_key = ?,
                avatar_content_type = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(avatar.storageKey, avatar.contentType, Date.now(), id);
    return this.get(id);
  }

  /** Clear avatar (both storage_key + content_type to NULL together). */
  clearAvatar(id: string): UserRow | null {
    if (!this.get(id)) return null;
    this.db
      .prepare(
        `UPDATE users
            SET avatar_storage_key = NULL,
                avatar_content_type = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(Date.now(), id);
    return this.get(id);
  }
}
