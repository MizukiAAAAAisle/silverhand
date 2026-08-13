import type { Database as Db } from 'better-sqlite3';
import type {
  HostAuthStatePort,
  HostCredentialsPort,
  HostSetupPort,
  HostTxScope,
  HostUnitOfWork,
} from '../auth/host-ports.js';
import { HostRepo } from './host-repo.js';
import { SqliteHostCredentialsRepo } from './host-credentials-repo.js';

/** The minimal host-aggregate face the host-token use cases need — backed by
 *  HostRepo, deliberately NOT the whole repo surface. */
function hostAggregatePort(db: Db): HostAuthStatePort {
  const hosts = new HostRepo(db);
  const read = (hostId: string) => {
    const row = hosts.get(hostId);
    if (!row) return null;
    return { userId: row.user_id, revokedAt: row.revoked_at };
  };
  return {
    getAuthState: read,
    // LOCKING-read contract, satisfied by the scope and not by this read: the
    // UnitOfWork below opens `BEGIN IMMEDIATE`, so the write lock is already
    // held when this runs and no other writer's commit can be ordered between
    // it and the credential insert. Outside such a scope this is a plain read
    // (that is what `getAuthState` is for). A future pooled adapter must back
    // this with `SELECT ... FOR UPDATE`.
    getAuthStateForUpdate: read,
    revoke(hostId, revokedAt) {
      return hosts.revoke(hostId, revokedAt);
    },
    createUserInvite(input) {
      return hosts.createUserInvite(input);
    },
  };
}

/** The setup-lifecycle face (#task:1982 W5). Both directions are projections:
 *  the read drops install identity and telemetry the finalize decision must not
 *  consult, and the two writes return a wire DTO built here (R4) so no physical
 *  `hosts` row — and no future column — reaches the use case. */
function hostSetupPort(db: Db): HostSetupPort {
  const hosts = new HostRepo(db);
  return {
    // Locking read by virtue of the scope's BEGIN IMMEDIATE (see the port
    // contract): the lock is held before this statement, which matters here
    // more than anywhere else in the domain because this read PRECEDES every
    // write in the scope. A pooled adapter MUST make this `SELECT ... FOR
    // UPDATE`.
    getSetupStateForUpdate(hostId) {
      const row = hosts.get(hostId);
      if (!row) return null;
      return {
        ownerUserId: row.user_id,
        revokedAt: row.revoked_at,
        provisioningSource: row.provisioning_source,
        kind: row.kind,
        activatedAt: row.activated_at,
        finalizedAt: row.finalized_at,
      };
    },
    // `toDto` is a pure row → wire mapping (no second read): the repo method
    // already re-selected the updated row, and projecting here is what keeps
    // `HostRow` out of `application/update-host.ts`.
    updateDisplayLabel(hostId, label) {
      const row = hosts.updateDisplayLabel(hostId, label);
      return row ? hosts.toDto(row) : null;
    },
    markFinalized(hostId, finalizedAt) {
      const row = hosts.markFinalized(hostId, finalizedAt);
      return row ? hosts.toDto(row) : null;
    },
  };
}

export interface SqliteHostPersistence {
  credentials: HostCredentialsPort;
  hosts: HostAuthStatePort;
  uow: HostUnitOfWork;
}

/** One-stop composition: ports for reads/single writes, UoW for atomics.
 *
 *  `setup` is deliberately NOT re-exported next to `credentials` / `hosts`:
 *  every setup write belongs to a decision made from `getSetupStateForUpdate`
 *  in the same scope, so the only way to reach it is through `atomically`. */
export function createSqliteHostPersistence(db: Db): SqliteHostPersistence {
  const scope: HostTxScope = {
    credentials: new SqliteHostCredentialsRepo(db),
    hosts: hostAggregatePort(db),
    setup: hostSetupPort(db),
  };
  return {
    credentials: scope.credentials,
    hosts: scope.hosts,
    uow: {
      /**
       * BEGIN IMMEDIATE, root-only. Every flow in this domain reads the host's
       * authoritative state FIRST and writes from that decision (credential
       * eligibility → insert; setup facts → rename/finalize), so the write
       * lock has to be held before the callback's first statement — a deferred
       * BEGIN would take it only at the first write, i.e. after the fact it is
       * meant to protect. Nested is refused rather than degraded: inside an
       * open transaction `.immediate()` becomes a savepoint and takes no write
       * lock at all, which would silently turn both `...ForUpdate` reads back
       * into plain reads (same reasoning as `auth-uow.ts` / `user-persistence.ts`).
       */
      atomically<T>(fn: (tx: HostTxScope) => T): T {
        if (db.inTransaction) {
          throw new Error(
            'host UnitOfWork: immediate transactions are root-only; already inside a transaction',
          );
        }
        return db.transaction(() => fn(scope)).immediate();
      },
    },
  };
}

// single-connection SQLite: one scope serves every transaction; a pooled
// engine would construct per-transaction ports bound to the tx connection.
export function createSqliteHostUnitOfWork(db: Db): HostUnitOfWork {
  return createSqliteHostPersistence(db).uow;
}
