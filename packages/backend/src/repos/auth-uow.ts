import type { Database as Db } from 'better-sqlite3';
import { isParticipantHandleAvailable } from '../application/name-availability.js';
import type {
  AuthTxScope,
  AuthUnitOfWork,
  HandleNamespacePort,
} from '../auth/ports.js';
import { AgentRepo } from './agent-repo.js';
import { SqliteAuthCredentialsRepo } from './auth-credentials-repo.js';
import { SqliteAuthSessionsRepo } from './auth-sessions-repo.js';
import { UserRepo } from './user-repo.js';

export interface SqliteAuthUnitOfWorkOptions {
  /**
   * Persistence-side transaction policy, chosen at composition time and
   * invisible to the application contract:
   * - 'deferred': plain transaction (regular server composition);
   * - 'immediate': BEGIN IMMEDIATE — the write lock is taken before the
   *   callback runs, so a conflict with a concurrent writer surfaces before
   *   any work and the connection's busy policy decides waiting (the offline
   *   admin process opens with busyTimeoutMs=0 and fails fast as db_locked).
   */
  txMode: 'deferred' | 'immediate';
}

export function createSqliteAuthUnitOfWork(
  db: Db,
  opts: SqliteAuthUnitOfWorkOptions,
): AuthUnitOfWork {
  // better-sqlite3 is single-connection, so one scope instance can serve
  // every transaction; a pooled engine would construct per-transaction ports
  // bound to the transaction's connection here instead.
  const scope: AuthTxScope = {
    users: new UserRepo(db),
    credentials: new SqliteAuthCredentialsRepo(db),
    sessions: new SqliteAuthSessionsRepo(db),
  };
  return {
    atomically<T>(fn: (tx: AuthTxScope) => T): T {
      if (opts.txMode === 'immediate') {
        // The immediate policy's guarantee — lock conflict surfaces BEFORE the
        // callback — only holds for a ROOT transaction. Nested under an outer
        // tx it would silently degrade to a savepoint, so refuse loudly.
        if (db.inTransaction) {
          throw new Error(
            'SqliteAuthUnitOfWork: immediate txMode is root-only; already inside a transaction',
          );
        }
        return db.transaction(() => fn(scope)).immediate();
      }
      return db.transaction(() => fn(scope))();
    },
  };
}

export function createHandleNamespacePort(db: Db): HandleNamespacePort {
  const deps = { agents: new AgentRepo(db), users: new UserRepo(db) };
  return {
    isParticipantHandleTaken(name: string): boolean {
      return !isParticipantHandleAvailable(deps, name);
    },
  };
}
