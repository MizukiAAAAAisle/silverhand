import { apiPaths, principalAvatarUrl, validateAvatarFile } from '@silverhand/shared';
import type { BlobFileStorage } from '../storage/blob-file-storage.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import type {
  RegistrationUnitOfWork,
  UserDirectWritePort,
  UserProfileSnapshot,
  UserReadPort,
} from './user/ports.js';
import { UserWriteConflictError } from './user/user-write-conflict.js';

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
  users: UserReadPort;
  profileWrites: UserDirectWritePort;
  registration: RegistrationUnitOfWork;
  blobStorage: BlobFileStorage;
  events: ScopeEventBus;
}

export interface UploadAvatarInput {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

export class UserService {
  private readonly users: UserReadPort;
  private readonly profileWrites: UserDirectWritePort;
  private readonly registration: RegistrationUnitOfWork;
  private readonly blobStorage: BlobFileStorage;
  private readonly events: ScopeEventBus;

  constructor(opts: UserServiceOptions) {
    this.users = opts.users;
    this.profileWrites = opts.profileWrites;
    this.registration = opts.registration;
    this.blobStorage = opts.blobStorage;
    this.events = opts.events;
  }

  /**
   * The single seam that broadcasts a user-DTO change to all clients —
   * the mirror image of `AgentService.publishChanged`, because human and
   * agent are isomorphic actors and their identity writes must propagate
   * through the same mechanism. Every identity write path in this service —
   * a genuine first-time `register` and every profile edit — funnels
   * through here, so no route hand-copies a publish.
   *
   * `app` scope + minimal `{user_id}` payload: no profile data on the wire
   * (the client re-reads the authority), and the audience equals the
   * audience of the ungated human directory it invalidates. Contract and
   * its falsifier live on `UserChangedEventSchema` in @silverhand/shared.
   *
   * Called only after a write has actually changed the row: a genuine
   * creation, or a real profile change. A no-op update (same display_name)
   * or a clear on a user with no avatar publishes nothing, and a rejected
   * write throws before reaching here (#task:1707).
   */
  private publishChanged(id: string): void {
    this.events.publishToScope('app', 'user_changed', { user_id: id });
  }

  /** Read the row + resolved avatar URL. The renderer never reaches
   *  for storage keys directly. */
  getDto(id: string): UserDto | null {
    const row = this.users.get(id);
    if (!row) return null;
    return snapshotToDto(row);
  }

  listRelatedDtos(viewerUserId: string): UserDto[] {
    return this.users.listRelated(viewerUserId).map(snapshotToDto);
  }

  listDtos(): UserDto[] {
    return this.users.list().map(snapshotToDto);
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
   * conversations) are impossible. The registration UnitOfWork owns that
   * atomicity and the isolation the single-viewer gate depends on.
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
    const displayName = input.display_name ?? input.name;

    let row: UserProfileSnapshot;
    try {
      row = this.registration.atomically((tx) => {
        // V1 single-user gate; multi-user invite path will replace this
        // embedded-only profile creator in D-stage. The UnitOfWork holds the
        // write lock from BEGIN, which is what makes this read-then-write gate
        // more than a hope (see `RegistrationUnitOfWork`).
        if (tx.users.anyExists()) {
          throw new UserServiceError('already_registered', 'a viewer is already registered');
        }
        const id = randomHex(8); // 16 hex chars
        const created = tx.users.create({ id, name: input.name, displayName });

        // v25 backfill on first embedded registration: this branch covers
        // a DB that has workspaces/conversations but no users yet. Add
        // membership rows now so permission gates immediately reflect the
        // new human.
        //
        // v40 (graded-permissions Layer A): the first registered human is
        // the OWNER of every pre-existing workspace — same "single local
        // human → owner of every workspace" rule as the v40 migration
        // backfill (which only fires when `viewer_user_id` was already set;
        // this register path is the other entry, for a DB that has
        // workspaces but registers its first human now). Without this the
        // first user would be a plain `member` with `owner_user_id` NULL on
        // pre-user workspaces — able to view/post but not govern — breaking
        // Layer A neutrality. Membership + role + owner pointer all land in
        // this same registration tx.
        for (const workspaceId of tx.workspaces.listIds()) {
          tx.workspaces.addOwnerMember(workspaceId, id);
        }
        // Stamp the denormalized owner pointer on every workspace that has
        // no owner yet (all of them on this first-register path).
        tx.workspaces.claimUnowned(id);
        for (const conversationId of tx.conversations.listIds()) {
          tx.conversations.addMember(conversationId, id);
        }

        return created;
      });
    } catch (err) {
      if (err instanceof UserServiceError) throw err;
      // The handle is the only conflict axis this path can lose on: it writes
      // no email, and the id is freshly generated (a `user_id` conflict would
      // be a genuine bug here, so it propagates untranslated rather than
      // becoming a 409 about the name).
      if (err instanceof UserWriteConflictError && err.kind === 'name') {
        throw new UserServiceError('name_taken', `name "${input.name}" is already taken`);
      }
      throw err;
    }
    // Reaching here means a genuine first-time registration: the single-user
    // gate above throws `already_registered` otherwise, and a name collision
    // throws `name_taken`. Announce the new identity so every already-open
    // app-scope viewer converges its directory + identity carriers without a
    // remount (#task:1707).
    this.publishChanged(row.id);
    return snapshotToDto(row);
  }

  /**
   * Update mutable profile fields. By design this only accepts
   * `display_name` — the user's `name` is set once at registration and
   * is not editable through any service / route surface.
   *
   * Publishes one `user_changed` when the row actually changed; a patch
   * that resolves to no field change returns the existing DTO silently.
   *
   * Throws `invalid_input` on whitespace-only `display_name`, and
   * `user_not_found` (404) when the row no longer exists.
   */
  updateProfile(id: string, input: { display_name?: string }): UserDto {
    const existing = this.users.get(id);
    if (!existing) {
      throw new UserServiceError('user_not_found', `user ${id} does not exist`);
    }

    const patch: { display_name?: string } = {};
    if (input.display_name !== undefined && input.display_name !== existing.display_name) {
      patch.display_name = input.display_name;
    }

    if (Object.keys(patch).length === 0) {
      return snapshotToDto(existing);
    }

    const updated = this.profileWrites.updateProfile(id, patch);
    if (!updated) {
      throw new UserServiceError('user_not_found', `user ${id} does not exist`);
    }
    this.publishChanged(id);
    return snapshotToDto(updated);
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
      throw new UserServiceError(validation.code, validation.message);
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

    const updated = this.profileWrites.setAvatar(id, {
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

    this.publishChanged(id);
    return snapshotToDto(updated);
  }

  /** Remove the avatar (DB + blob). Idempotent — calling on a user
   *  that has no avatar is a no-op (and publishes nothing). */
  async clearAvatar(id: string): Promise<UserDto> {
    const existing = this.users.get(id);
    if (!existing) {
      throw new UserServiceError('user_not_found', `user ${id} does not exist`);
    }
    if (!existing.avatar_storage_key) {
      return snapshotToDto(existing);
    }
    const previousKey = existing.avatar_storage_key;
    const updated = this.profileWrites.clearAvatar(id);
    if (!updated) {
      throw new UserServiceError('user_not_found', `user ${id} does not exist`);
    }
    void this.blobStorage
      .delete({ storage: this.blobStorage.kind, storageKey: previousKey })
      .catch(() => {});
    this.publishChanged(id);
    return snapshotToDto(updated);
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

function snapshotToDto(row: UserProfileSnapshot): UserDto {
  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    avatar_url: principalAvatarUrl(
      apiPaths.userAvatar(row.id),
      row.avatar_storage_key,
      row.updated_at,
    ),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function avatarFilename(row: UserProfileSnapshot): string {
  const ext = (row.avatar_content_type ?? 'image/png').split('/')[1] ?? 'png';
  return `avatar.${ext}`;
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
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
