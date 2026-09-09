/**
 * Application-facing persistence contract for the human-identity domain
 * (#task:1982 W1). Driver-free by gate: `tests/db-boundary/port-contract.test.ts`
 * walks this file's whole relative import closure and reddens on any
 * better-sqlite3 binding, so no `Database` handle can reach `UserService`
 * through a re-export hop.
 */

/**
 * What this domain is allowed to see of a human: the identity + profile fields
 * its DTO and avatar-download surfaces are built from, and nothing else.
 *
 * A RUNTIME projection, not a narrowed alias of the physical row (R4): the two
 * columns it omits are owned by other surfaces —
 *   - `email` is the LOGIN handle, read by the auth domain through its own
 *     port (`AuthUsersPort.getByEmail`). Passing the whole row here would put
 *     it one accidental spread away from `UserDto`, which every app-scope
 *     viewer receives.
 *   - `last_seen_at` belongs to presence, which has its own writer and reader.
 * A type-level `Omit<UserRow, …>` would satisfy the compiler while the object
 * still carried both values at runtime, so the adapter must build a new object
 * and the adapter contract test asserts the KEY SET, not assignability.
 */
export interface UserProfileSnapshot {
  id: string;
  /** Mention handle. Decided once at registration, never editable after. */
  name: string;
  display_name: string;
  /** Storage key inside the configured BlobFileStorage; NULL when no avatar is
   *  set. Coupled with `avatar_content_type` — both NULL or both set. */
  avatar_storage_key: string | null;
  avatar_content_type: string | null;
  created_at: number;
  updated_at: number;
}

/** Identity reads. `list()` is ordered by `created_at ASC`, as the directory
 *  and the registration gate both expect. */
export interface UserReadPort {
  get(id: string): UserProfileSnapshot | null;
  list(): UserProfileSnapshot[];
  listRelated(viewerUserId: string): UserProfileSnapshot[];
}

/**
 * Post-registration profile writes, OUTSIDE any transaction. `name` is
 * deliberately absent: the mention handle is decided once at registration and
 * has no writer here.
 *
 * Each method promises exactly this: the row is updated and the UPDATED
 * projection is returned, or `null` when no such user exists. It does NOT
 * promise single-statement execution or any isolation — the SQLite adapter
 * implements each as existence-check → UPDATE → re-read, so a concurrent
 * deletion between the write and the re-read would surface as `null` after a
 * successful write. That is acceptable because these fields have a single
 * writer per user (the profile owner) and no invariant spans two of them; a
 * future adapter may collapse it into `UPDATE … RETURNING` without changing
 * this contract.
 */
export interface UserDirectWritePort {
  updateProfile(
    id: string,
    input: { display_name?: string },
  ): UserProfileSnapshot | null;
  setAvatar(
    id: string,
    avatar: { storageKey: string; contentType: string },
  ): UserProfileSnapshot | null;
  clearAvatar(id: string): UserProfileSnapshot | null;
}

/**
 * The capabilities the registration transaction needs — and nothing else.
 * Every method here is used by the single `register` callback; the callback
 * constructs no repository of its own, so all persistence inside the
 * transaction demonstrably comes from this scope (#task:1982 R1/R3).
 */
export interface RegistrationTxScope {
  users: {
    /** The V1 single-viewer gate: is ANY human already registered? */
    anyExists(): boolean;
    create(input: {
      id: string;
      name: string;
      displayName: string;
    }): UserProfileSnapshot;
  };
  workspaces: {
    /** EVERY workspace row, with no kind enumeration: humans have no implicit
     *  access anywhere, so the backfill's obligation is "every workspace that
     *  exists". An adapter must not implement this with the ordinary workspace
     *  list — that one is a read model over a fixed kind list, so a kind added
     *  later would silently leave the first human out of those workspaces. */
    listIds(): string[];
    /** Idempotent membership write with `role = 'owner'`; re-running it on an
     *  existing membership leaves the stored row untouched. */
    addOwnerMember(workspaceId: string, userId: string): void;
    /** Stamp the denormalized `workspaces.owner_user_id` pointer on every
     *  workspace that currently has NO owner, in one statement. Deliberately
     *  not a per-workspace assignment: this is the "first human owns what
     *  predates them" backfill, and it must not touch an owned workspace. */
    claimUnowned(userId: string): void;
  };
  conversations: {
    listIds(): string[];
    /** Idempotent membership write; see `addOwnerMember`. */
    addMember(conversationId: string, userId: string): void;
  };
}

/**
 * Atomicity for the one operation in this domain that spans aggregates: the
 * first registration creates the human AND backfills their membership in
 * everything that predates them, so a partial commit would leave a user who
 * cannot see the workspaces they own.
 *
 * ISOLATION OBLIGATION (#task:1982 R5) — the single-viewer gate is a
 * read-then-write invariant (`anyExists()` decides whether the INSERT is
 * legal), and atomicity alone does not close it: two connections could both
 * read "no users" and both commit. The mechanism is named per engine, not
 * assumed:
 *   - SQLite: the adapter takes the write lock at BEGIN (root-only
 *     IMMEDIATE), which totally orders writers, so the second registration
 *     observes the first one's row and answers `already_registered`.
 *   - future pooled / PostgreSQL: a locking read cannot serialize this — the
 *     gate is a predicate over an EMPTY set, and `SELECT … FOR UPDATE` locks
 *     no rows when none exist. Such an adapter MUST run the callback at
 *     SERIALIZABLE, or take a registration-scoped advisory lock before the
 *     gate read.
 * Independently of this gate, `users.name` uniqueness (column UNIQUE plus the
 * cross-namespace trigger) is enforced by the schema, so a handle race is
 * answered by a typed conflict rather than by this lock.
 */
export interface RegistrationUnitOfWork {
  atomically<T>(fn: (tx: RegistrationTxScope) => T): T;
}

/** What a persistence adapter supplies to the user domain. */
export interface UserPersistence {
  read: UserReadPort;
  profile: UserDirectWritePort;
  registration: RegistrationUnitOfWork;
}
