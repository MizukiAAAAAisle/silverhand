import type { Database as Db } from 'better-sqlite3';
import type { UserRow } from '@silverhand/shared';

/**
 * Repository for the `users` table.
 *
 * Identity model:
 *   - `id` is a stable internal id (16 lowercase hex chars; generator
 *     in the service layer); never exposed to humans, never editable.
 *   - `name` is the public mention name (`@<name>`), decided once at
 *     registration and never editable after. Globally unique across
 *     `users.name` ⊕ `agents.name` — migration v21 triggers enforce
 *     this in DB.
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
  list(): UserRow[] {
    return this.db
      .prepare<[], UserRow>('SELECT * FROM users ORDER BY created_at ASC')
      .all();
  }

  /**
   * INSERT a new user row. Callers must run this inside the transaction
   * that creates any adjacent credential or bridge rows.
   *
   * The migration v21 cross-namespace uniqueness trigger throws if
   * `name` collides with an existing `agents.name`; the column UNIQUE
   * fires for collisions inside `users`. better-sqlite3 surfaces both
   * as SqliteError instances the caller can map to 409.
   */
  create(input: {
    id: string;
    name: string;
    displayName: string;
    email?: string | null;
  }): UserRow {
    const now = Date.now();
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
