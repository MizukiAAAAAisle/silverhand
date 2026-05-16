import type { Database as Db } from 'better-sqlite3';
import type { UserRow } from '@silverhand/shared';
import { apiPaths, validateAvatarFile } from '@silverhand/shared';
import type { BlobFileStorage } from '../storage/blob-file-storage.js';
import type { UserRepo } from '../repos/user-repo.js';
import { SettingsRepo, SETTINGS_KEYS } from '../repos/settings-repo.js';

/**
 * Domain-typed errors so the route layer can map to HTTP status codes
 * without importing better-sqlite3 internals. Cross-namespace name
 * collisions raise `name_taken` (409); everything else is a 4xx input
 * error or 404.
 */
export class UserServiceError extends Error {
  constructor(
    public readonly code:
      | 'user_not_found'
      | 'name_taken'
      | 'invalid_input'
      | 'already_registered'
      | 'avatar_too_large'
      | 'avatar_unsupported_type'
      | 'avatar_missing'
      | 'avatar_storage_failed',
    message: string,
  ) {
    super(message);
    this.name = 'UserServiceError';
  }
}

export interface UserServiceOptions {
  db: Db;
  users: UserRepo;
  blobStorage: BlobFileStorage;
}

export interface UploadAvatarInput {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

export class UserService {
  private readonly db: Db;
  private readonly users: UserRepo;
  private readonly blobStorage: BlobFileStorage;
  private readonly settings: SettingsRepo;

  constructor(opts: UserServiceOptions) {
    this.db = opts.db;
    this.users = opts.users;
    this.blobStorage = opts.blobStorage;
    this.settings = new SettingsRepo(opts.db);
  }

  /** Read the row + resolved avatar URL. The renderer never reaches
   *  for storage keys directly. */
  getDto(id: string): UserDto | null {
    const row = this.users.get(id);
    if (!row) return null;
    return rowToDto(row);
  }

  listDtos(): UserDto[] {
    return this.users.list().map(rowToDto);
  }

  /**
   * Generate a placeholder name for the registration UI to seed its
   * input field. Shape: `user-<4hex>`. Not persisted; the user is free
   * to overwrite. Same shape every call so the renderer's UX stays
   * predictable across reloads.
   */
  suggestRegistrationName(): string {
    return `user-${randomHex(4)}`;
  }

  /**
   * The sole creator of `users` rows. Called by `POST /api/register`
   * exactly once per machine in V1 (and once per signup in V2).
   *
   * Atomically:
   *   1. Generate a fresh user id (16 hex chars).
   *   2. INSERT into `users` (name, display_name).
   *   3. SET `app_settings.viewer_user_id` to the new id.
   *   4. **Deferred Adoption**: rewrite legacy v21 staging rows so the
   *      newly registered viewer owns pre-v21 messages / tasks / read
   *      cursors / attachments. Staging tables are dropped on success.
   *      See migration v21's header comment + the cleanup plan doc for
   *      the rationale. On a fresh install (no pre-v21 backup) staging
   *      tables exist but are empty, so this step is a no-op with
   *      all-zero audit counts.
   *
   * All steps share a single transaction — partial states would
   * otherwise leak (e.g. user row exists but the principal middleware
   * still sees no viewer pointer; or staging dropped while audit row
   * unwritten). better-sqlite3's `db.transaction()` wraps DDL/DML and
   * propagates exceptions to abort.
   *
   * Throws:
   *   - `already_registered` (409) — `app_settings.viewer_user_id` is
   *     already set; the human must not be able to overwrite their
   *     identity from the registration window.
   *   - `name_taken` (409) — `users.name` collides with itself or
   *     `agents.name` (column UNIQUE / cross-namespace trigger).
   */
  register(input: { name: string; display_name?: string }): UserDto {
    const tx = this.db.transaction((args: { name: string; displayName: string }) => {
      if (this.settings.getViewerUserId()) {
        throw new UserServiceError(
          'already_registered',
          'a viewer is already registered',
        );
      }
      const id = randomHex(8); // 16 hex chars
      const row = this.users.create({
        id,
        name: args.name,
        displayName: args.displayName,
      });
      this.settings.set(SETTINGS_KEYS.VIEWER_USER_ID, id);
      // Adopt pre-v21 legacy data into the freshly registered viewer.
      // Same transaction: any failure rolls the user row + viewer
      // pointer back, leaving staging untouched for retry.
      adoptLegacyV21(this.db, id);
      return row;
    });

    let row: UserRow;
    try {
      row = tx({
        name: input.name,
        displayName: input.display_name ?? input.name,
      });
    } catch (err) {
      if (err instanceof UserServiceError) throw err;
      if (isNameConflict(err)) {
        throw new UserServiceError(
          'name_taken',
          `name "${input.name}" is already taken`,
        );
      }
      throw err;
    }
    return rowToDto(row);
  }

  /**
   * Update mutable profile fields. By design this only accepts
   * `display_name` — the user's `name` is set once at registration and
   * is not editable through any service / route surface.
   *
   * Throws `invalid_input` on whitespace-only `display_name`, and
   * `user_not_found` (404) when the row no longer exists.
   */
  updateProfile(
    id: string,
    input: { display_name?: string },
  ): UserDto {
    const existing = this.users.get(id);
    if (!existing) {
      throw new UserServiceError('user_not_found', `user ${id} does not exist`);
    }

    const patch: { display_name?: string } = {};
    if (
      input.display_name !== undefined
      && input.display_name !== existing.display_name
    ) {
      patch.display_name = input.display_name;
    }

    if (Object.keys(patch).length === 0) {
      return rowToDto(existing);
    }

    const updated = this.users.updateProfile(id, patch);
    if (!updated) {
      throw new UserServiceError(
        'user_not_found',
        `user ${id} does not exist`,
      );
    }
    return rowToDto(updated);
  }

  /**
   * Replace the avatar atomically: write the new blob first, then
   * point the user row at it, then delete the old blob (best-effort).
   * Caller is expected to have validated the principal already; this
   * function only validates payload shape.
   */
  async uploadAvatar(id: string, input: UploadAvatarInput): Promise<UserDto> {
    const existing = this.users.get(id);
    if (!existing) {
      throw new UserServiceError('user_not_found', `user ${id} does not exist`);
    }
    const contentType = input.contentType.toLowerCase();
    const validation = validateAvatarFile({
      size: input.buffer.byteLength,
      type: contentType,
    });
    if (validation) {
      throw new UserServiceError(
        validation.code,
        validation.message,
      );
    }

    let stored;
    try {
      // Use a per-upload random id so re-uploading the same picture
      // creates a fresh blob (no clobber, no cache hit at the
      // immutable Cache-Control header). We delete the old blob below.
      stored = await this.blobStorage.put({
        namespace: `users/${id}/avatars`,
        id: randomBlobId(),
        filename: input.filename || 'avatar',
        contentType,
        buffer: input.buffer,
      });
    } catch (err) {
      throw new UserServiceError(
        'avatar_storage_failed',
        `avatar storage failed: ${(err as Error).message}`,
      );
    }

    const previousKey = existing.avatar_storage_key;
    const previousStorage = stored.storage; // same kind for now (single backend)

    const updated = this.users.setAvatar(id, {
      storageKey: stored.storageKey,
      contentType,
    });
    if (!updated) {
      // Row vanished mid-flight. Clean up the orphaned blob and
      // surface the same error path tests expect.
      void this.blobStorage.delete(stored).catch(() => {});
      throw new UserServiceError('user_not_found', `user ${id} does not exist`);
    }

    if (previousKey) {
      void this.blobStorage
        .delete({ storage: previousStorage, storageKey: previousKey })
        .catch(() => {
          // Best-effort: an orphaned previous avatar is annoying but
          // not fatal. The DB pointer is already updated.
        });
    }

    return rowToDto(updated);
  }

  /** Remove the avatar (DB + blob). Idempotent — calling on a user
   *  that has no avatar is a no-op. */
  async clearAvatar(id: string): Promise<UserDto> {
    const existing = this.users.get(id);
    if (!existing) {
      throw new UserServiceError('user_not_found', `user ${id} does not exist`);
    }
    if (!existing.avatar_storage_key) {
      return rowToDto(existing);
    }
    const previousKey = existing.avatar_storage_key;
    const updated = this.users.clearAvatar(id);
    if (!updated) {
      throw new UserServiceError('user_not_found', `user ${id} does not exist`);
    }
    void this.blobStorage
      .delete({ storage: this.blobStorage.kind, storageKey: previousKey })
      .catch(() => {});
    return rowToDto(updated);
  }

  /** Resolve the storage ref for an avatar download. Returns null
   *  when the user does not exist or has no avatar set. */
  getAvatarStorageRef(
    id: string,
  ): { storageKey: string; contentType: string; filename: string } | null {
    const row = this.users.get(id);
    if (!row || !row.avatar_storage_key || !row.avatar_content_type) {
      return null;
    }
    return {
      storageKey: row.avatar_storage_key,
      contentType: row.avatar_content_type,
      filename: avatarFilename(row),
    };
  }
}

export interface UserDto {
  id: string;
  name: string;
  display_name: string;
  avatar_url: string | null;
  created_at: number;
  updated_at: number;
}

function rowToDto(row: UserRow): UserDto {
  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    avatar_url: row.avatar_storage_key
      ? `${apiPaths.userAvatar(row.id)}?v=${row.updated_at}`
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function avatarFilename(row: UserRow): string {
  const ext = (row.avatar_content_type ?? 'image/png').split('/')[1] ?? 'png';
  return `avatar.${ext}`;
}

function isNameConflict(err: unknown): boolean {
  // Migration v21 cross-namespace trigger raises with "users.name
  // collides" wording; the column UNIQUE also fires with the standard
  // SQLITE_CONSTRAINT_UNIQUE message.
  if (!err || typeof err !== 'object') return false;
  const message = String((err as { message?: unknown }).message ?? '');
  if (/users\.name collides with an existing agent name/.test(message)) return true;
  if (/UNIQUE constraint failed: users\.name/.test(message)) return true;
  return false;
}

/**
 * Deferred Adoption (Phase 2): consume the four `legacy_*_v21`
 * staging tables that v21 populates from pre-v21 dev data, rewriting
 * legacy user-id references to point at the freshly registered
 * viewer. Runs INSIDE the `register()` transaction — any failure
 * here aborts user creation along with adoption.
 *
 * Behaviour by segment:
 *   - `messages.from_user_id`: only message ids captured in
 *     `legacy_message_from_user_v21` get rewritten (rows that were
 *     originally NULL pre-v21 stay NULL — see Cindy's review #2).
 *   - `messages.task_assignee_user_id`: only ids captured in
 *     `legacy_message_task_assignee_user_v21` (review #3).
 *   - `conversation_reads`: rows merged by `(viewer_user_id,
 *     conversation_id)` using `MAX(last_read_seq), MAX(read_at)`.
 *     This is V1 single-viewer semantics: any pre-v21 read marker
 *     belonged to "you" regardless of whether it was stamped 'local',
 *     'desktop-user-42', etc. (review #4).
 *   - `attachments(kind=user)`: full rows re-INSERTed into the live
 *     `attachments` table with `created_by_id = viewerId` (review #1
 *     — main table can't host a row with a non-existent owner because
 *     the v21 dispatch trigger validates).
 *
 * Audit row written via `app_settings`:
 *   - `legacy_v21_adoption_completed_at` — `Date.now()` decimal string.
 *   - `legacy_v21_adoption_counts` — JSON `{ messages_from, messages_task,
 *      conversation_reads, attachments }`.
 *
 * Idempotent on a fresh install: staging tables exist after v21 ran
 * but are empty, so all DML is a no-op and counts are zero.
 *
 * Defensive on missing staging: if a staging table is absent (e.g.
 * a pre-rewrite `_migrations` row that never created them), skip
 * that segment rather than aborting registration. Audit count
 * defaults to 0.
 */
function adoptLegacyV21(db: Db, viewerId: string): void {
  const stagingTables = [
    'legacy_message_from_user_v21',
    'legacy_message_task_assignee_user_v21',
    'legacy_conversation_reads_v21',
    'legacy_user_attachments_v21',
  ] as const;
  const present = new Set(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table'
              AND name IN (${stagingTables.map(() => '?').join(',')})`,
        )
        .all(...stagingTables) as Array<{ name: string }>
    ).map(r => r.name),
  );

  const counts = {
    messages_from: 0,
    messages_task: 0,
    conversation_reads: 0,
    attachments: 0,
  };

  if (present.has('legacy_message_from_user_v21')) {
    const result = db
      .prepare(
        `UPDATE messages
            SET from_user_id = ?
          WHERE id IN (SELECT message_id FROM legacy_message_from_user_v21)`,
      )
      .run(viewerId);
    counts.messages_from = result.changes;
  }

  if (present.has('legacy_message_task_assignee_user_v21')) {
    const result = db
      .prepare(
        `UPDATE messages
            SET task_assignee_user_id = ?
          WHERE id IN (SELECT message_id FROM legacy_message_task_assignee_user_v21)`,
      )
      .run(viewerId);
    counts.messages_task = result.changes;
  }

  if (present.has('legacy_conversation_reads_v21')) {
    // V1 single-viewer merge: any pre-v21 read marker belonged to
    // the human running this machine, regardless of whether it was
    // recorded under 'local', 'desktop-user-42', etc. We aggregate
    // by conversation_id and take the most-permissive (= furthest)
    // read position so registration never *regresses* unread state.
    const result = db
      .prepare(
        `INSERT INTO conversation_reads (user_id, conversation_id, last_read_seq, read_at)
         SELECT ?, conversation_id, MAX(last_read_seq), MAX(read_at)
           FROM legacy_conversation_reads_v21
          GROUP BY conversation_id`,
      )
      .run(viewerId);
    counts.conversation_reads = result.changes;
  }

  if (present.has('legacy_user_attachments_v21')) {
    // Re-INSERT full rows into the live attachments table. The
    // dispatch trigger installed in v21 will accept these because
    // `created_by_id = viewerId` and the user row was inserted
    // earlier in the same transaction.
    const result = db
      .prepare(
        `INSERT INTO attachments
           (id, channel_id, source_conversation_id, filename, size, content_type,
            storage, storage_key, created_by_kind, created_by_id, created_at)
         SELECT id, channel_id, source_conversation_id, filename, size, content_type,
                storage, storage_key, 'user', ?, created_at
           FROM legacy_user_attachments_v21`,
      )
      .run(viewerId);
    counts.attachments = result.changes;
  }

  // Write the audit row (timestamp + per-segment counts) before
  // dropping staging. All four statements run in the same outer
  // transaction as register(), so any failure here — including a
  // DROP failure, however unlikely — rolls everything back: the
  // viewer row, the viewer pointer, the audit rows, and the staging
  // tables remain. That's intentional: a failed adoption must not
  // leave a half-registered viewer with phantom audit telemetry.
  const now = String(Date.now());
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SETTINGS_KEYS.LEGACY_V21_ADOPTION_COMPLETED_AT, now);
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SETTINGS_KEYS.LEGACY_V21_ADOPTION_COUNTS, JSON.stringify(counts));

  for (const t of stagingTables) {
    db.exec(`DROP TABLE IF EXISTS ${t};`);
  }
}

function randomBlobId(): string {
  // 12 random bytes is plenty of collision resistance for per-user
  // avatar versions; we don't expose this id outside the storage key.
  return randomHex(12);
}

/** Lowercase hex string of the requested byte count. */
function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
