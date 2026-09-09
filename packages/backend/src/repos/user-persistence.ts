// Human-identity persistence composition (#task:1982 W1). The ONLY file that
// wires the concrete `users` / workspace / conversation repos into the user
// domain's driver-free ports, so `UserService` holds no `Database` handle, no
// repo and no SQL — its whole persistence surface is the ports below.
//
// It composes NO effects: `user_changed` publication and avatar blob writes
// stay in the service, post-commit, which is what keeps "the registration
// transaction structurally cannot publish or touch storage" true.
import type { Database as Db } from 'better-sqlite3';
import type { UserRow } from '@silverhand/shared';
import { ConversationRepo } from './conversation-repo.js';
import { UserRepo } from './user-repo.js';
import { WorkspaceRepo } from './workspace-repo.js';
import type {
  RegistrationTxScope,
  RegistrationUnitOfWork,
  UserDirectWritePort,
  UserPersistence,
  UserProfileSnapshot,
  UserReadPort,
} from '../services/user/ports.js';

/**
 * The R4 projection boundary: a NEW object listing the seven fields the user
 * domain is allowed to see. It is written field-by-field on purpose — a spread
 * plus `delete`, or a cast, would keep `email` and `last_seen_at` on the object
 * at runtime and the type would still check. Adding a `users` column must not
 * silently widen what crosses this line, so the only way to publish one is to
 * name it here AND in `UserProfileSnapshot`.
 */
function toSnapshot(row: UserRow): UserProfileSnapshot {
  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    avatar_storage_key: row.avatar_storage_key,
    avatar_content_type: row.avatar_content_type,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toSnapshotOrNull(row: UserRow | null): UserProfileSnapshot | null {
  return row ? toSnapshot(row) : null;
}

/**
 * Single-connection SQLite: one scope object serves the registration
 * transaction because every repo here shares `db`. A pooled engine breaks that
 * invariant — such an adapter must build per-transaction ports bound to the
 * transaction's client instead of hoisting them like this.
 */
export function createSqliteUserPersistence(db: Db): UserPersistence {
  const users = new UserRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);

  const read: UserReadPort = {
    get: (id) => toSnapshotOrNull(users.get(id)),
    list: () => users.list().map(toSnapshot),
    listRelated: (viewerUserId) => users.listRelated(viewerUserId).map(toSnapshot),
  };

  const profile: UserDirectWritePort = {
    updateProfile: (id, input) => toSnapshotOrNull(users.updateProfile(id, input)),
    setAvatar: (id, avatar) => toSnapshotOrNull(users.setAvatar(id, avatar)),
    clearAvatar: (id) => toSnapshotOrNull(users.clearAvatar(id)),
  };

  const scope: RegistrationTxScope = {
    users: {
      // An existence query (`SELECT 1 … LIMIT 1`), not a narrowed list read:
      // the port asks whether any identity exists, and the repository answers
      // it without reading or ordering user rows. `list().length > 0` was the
      // pre-#1982 form; `tests/repos/user-persistence.test.ts` pins the
      // statement shape so a future edit cannot quietly return to it.
      anyExists: () => users.anyExists(),
      create: (input) => toSnapshot(users.create(input)),
    },
    workspaces: {
      // Deliberately `SELECT id FROM workspaces` and not `WorkspaceRepo.list()`,
      // which is a UI read model: it enumerates kinds (`IN ('regular',
      // 'agent_home')`) and builds the full DTO with its dm-channel subquery.
      // The set is the same TODAY because those are the only two kinds, but the
      // backfill's obligation is "every workspace that exists" — under a third
      // kind the enumeration would silently leave the first human out of it,
      // and a silent narrowing here means unreachable pre-existing workspaces.
      listIds: () =>
        db
          .prepare<[], { id: string }>(`SELECT id FROM workspaces`)
          .all()
          .map((r) => r.id),
      addOwnerMember: (workspaceId, userId) => {
        // `WorkspaceRepo.addUserMember` is the same INSERT OR IGNORE with an
        // explicit role; it additionally re-reads the row (a read this scope
        // discards). `joined_at` is stamped per row by the repo instead of once
        // per backfill — an informational column no ordering or uniqueness
        // rule reads.
        workspaces.addUserMember(workspaceId, userId, 'owner');
      },
      // One statement, guarded by `owner_user_id IS NULL`: it claims what has
      // no owner and provably cannot demote an owned workspace. NOT
      // `setOwnerUserId` per id — that one overwrites unconditionally and
      // opens its own transaction.
      claimUnowned: (userId) => {
        db.prepare(`UPDATE workspaces SET owner_user_id = ? WHERE owner_user_id IS NULL`).run(
          userId,
        );
      },
    },
    conversations: {
      listIds: () =>
        db
          .prepare<[], { id: string }>(`SELECT id FROM conversations`)
          .all()
          .map((r) => r.id),
      addMember: (conversationId, userId) => {
        // Same INSERT OR IGNORE as the pre-#1982 statement, plus a discarded
        // re-read; see `addOwnerMember` on `joined_at`.
        conversations.addUser(conversationId, userId);
      },
    },
  };

  const registration: RegistrationUnitOfWork = {
    /**
     * BEGIN IMMEDIATE, not the default deferred BEGIN: the callback's FIRST
     * statement is the single-viewer gate read, and that read decides whether
     * the INSERT is legal. Under a deferred BEGIN the write lock would not be
     * held yet, so the gate would rest on "there is usually one writer"
     * instead of on writer ordering (`RegistrationUnitOfWork` states the
     * obligation and what a pooled engine owes instead).
     */
    atomically<T>(fn: (tx: RegistrationTxScope) => T): T {
      // Root-only: nested, `.immediate()` silently degrades to a savepoint and
      // takes no write lock at all (same reasoning as `auth-uow.ts`).
      if (db.inTransaction) {
        throw new Error(
          'user registration UnitOfWork: immediate transactions are root-only; already inside a transaction',
        );
      }
      return db.transaction(() => fn(scope)).immediate();
    },
  };

  return { read, profile, registration };
}
