import type { BackendLogger } from './context.js';
import { openDatabase } from './db.js';
import { PasswordCredentialService } from './auth/password.js';
import {
  UserAuthService,
  type UserPasswordResetResult,
} from './auth/user-auth-service.js';
import { UserRepo } from './repos/user-repo.js';
import { SqliteAuthCredentialsRepo } from './repos/auth-credentials-repo.js';
import {
  createHandleNamespacePort,
  createSqliteAuthUnitOfWork,
} from './repos/auth-uow.js';

export type AdminResetPasswordErrorCode = 'user_not_found' | 'db_locked';

export class AdminResetPasswordError extends Error {
  constructor(
    readonly code: AdminResetPasswordErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdminResetPasswordError';
  }
}

export interface AdminResetPasswordOptions {
  dbPath: string;
  email: string;
  password: string;
  allowSchemaUpgrade?: boolean;
  logger?: BackendLogger;
}

export async function resetAdminPassword(
  opts: AdminResetPasswordOptions,
): Promise<UserPasswordResetResult> {
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(opts.dbPath, {
      busyTimeoutMs: 0,
      allowSchemaUpgrade: opts.allowSchemaUpgrade ?? false,
    });
  } catch (err) {
    mapAdminDbError(err);
  }

  try {
    const userAuth = new UserAuthService({
      // Offline admin competes with a running server for the same db file:
      // the immediate policy takes the write lock up front, and this
      // process's busyTimeoutMs=0 connection turns contention into an
      // instant db_locked instead of a mid-transaction stall.
      uow: createSqliteAuthUnitOfWork(db, { txMode: 'immediate' }),
      users: new UserRepo(db),
      // Unused by `resetPassword`, required by the service surface: signup's
      // handle check spans agents ∪ users (#task:1830).
      handles: createHandleNamespacePort(db),
      passwordCredentials: new PasswordCredentialService(new SqliteAuthCredentialsRepo(db)),
    });
    const reset = await userAuth.resetPassword({
      email: opts.email,
      password: opts.password,
    });
    if (!reset.ok) {
      throw new AdminResetPasswordError(
        'user_not_found',
        `user_not_found: no registered user has email ${opts.email}`,
      );
    }
    opts.logger?.info(
      {
        admin_op: 'reset-password',
        user_email: reset.reset.email,
        success: true,
        sessions_revoked: reset.reset.sessionsRevoked,
        ts: Date.now(),
      },
      'admin reset-password succeeded',
    );
    return reset.reset;
  } catch (err) {
    mapAdminDbError(err);
  } finally {
    db.close();
  }
}

function mapAdminDbError(err: unknown): never {
  if (err instanceof AdminResetPasswordError) throw err;
  if (isSqliteBusy(err)) {
    throw new AdminResetPasswordError(
      'db_locked',
      'db_locked: another Silverhand process is writing the database; retry when the write lock is free',
    );
  }
  throw err;
}

function isSqliteBusy(err: unknown): boolean {
  return (
    !!err
    && typeof err === 'object'
    && 'code' in err
    && String((err as { code?: unknown }).code) === 'SQLITE_BUSY'
  );
}
