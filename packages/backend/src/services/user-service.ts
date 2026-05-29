import type { Database as Db } from 'better-sqlite3';
import type { UserRow } from '@silverhand/shared';
import { apiPaths, validateAvatarFile } from '@silverhand/shared';
import type { BlobFileStorage } from '../storage/blob-file-storage.js';
import type { UserRepo } from '../repos/user-repo.js';

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

  constructor(opts: UserServiceOptions) {
    this.db = opts.db;
    this.users = opts.users;
    this.blobStorage = opts.blobStorage;
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
   * Embedded-only profile-registration creator. Password signup creates
   * credentialed `users` rows through `UserAuthService.signup`; the
   * public `/api/register` route has been removed.
   *
   * Atomically:
   *   1. Generate a fresh user id (16 hex chars).
   *   2. INSERT into `users` (name, display_name).
   * Membership backfill shares the same transaction so partial states
   * (user row exists but is not a member of existing workspaces /
   * conversations) are impossible. better-sqlite3's `db.transaction()`
   * wraps DDL/DML and propagates exceptions to abort.
   *
   * Note: the original V1 ship included a Deferred Adoption helper
   * here that imported pre-v21 staging tables into the freshly
   * registered viewer (see migration v21's header for the historical
   * contract). That bridge was removed by migration v23 alongside the
   * Mode B cleanup — pre-v21 backups are no longer auto-adopted, and
   * v23's precondition fails fast if `legacy_*_v21` staging tables
   * are still present at upgrade time.
   *
   * Throws:
   *   - `already_registered` (409) — a V1 single-user DB already has
   *     a user. D-stage multi-user invite/signup paths will replace
   *     this embedded-only creator.
   *   - `name_taken` (409) — `users.name` collides with itself or
   *     `agents.name` (column UNIQUE / cross-namespace trigger).
   */
  register(input: { name: string; display_name?: string }): UserDto {
    const tx = this.db.transaction((args: { name: string; displayName: string }) => {
      // V1 single-user gate; multi-user invite path will replace this
      // embedded-only profile creator in D-stage.
      if (this.users.list().length > 0) {
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

      // v25 backfill on first embedded registration: this branch covers
      // a DB that has workspaces/conversations but no users yet. Add
      // membership rows now so permission gates immediately reflect the
      // new human.
      const now = Date.now();
      const insertWorkspaceUser = this.db.prepare(
        `INSERT OR IGNORE INTO workspace_users
           (workspace_id, user_id, joined_at) VALUES (?, ?, ?)`,
      );
      const insertConversationUser = this.db.prepare(
        `INSERT OR IGNORE INTO conversation_users
           (conversation_id, user_id, joined_at) VALUES (?, ?, ?)`,
      );
      const workspaceRows = this.db
        .prepare<[], { id: string }>(`SELECT id FROM workspaces`)
        .all();
      for (const w of workspaceRows) {
        insertWorkspaceUser.run(w.id, id, now);
      }
      const conversationRows = this.db
        .prepare<[], { id: string }>(`SELECT id FROM conversations`)
        .all();
      for (const c of conversationRows) {
        insertConversationUser.run(c.id, id, now);
      }

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
