import type { BackendLogger } from './context.js';
import { openDatabase, openDatabaseUnmigratedReadOnly } from './db.js';
import { isSqliteContention } from './db-errors.js';
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
import { scanConversationTitleAddresses } from './read-model/conversation-title-audit.js';
import { scanWorkspaceNameAddresses } from './read-model/workspace-name-audit.js';
import {
  describeConversationTitleAudit,
  describeWorkspaceNameAudit,
  type ConversationTitleAuditReport,
  type WorkspaceNameAuditReport,
} from '@silverhand/shared';

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

export interface AdminScanTitleAddressesOptions {
  dbPath: string;
  logger?: BackendLogger;
}

export interface AdminScanTitleAddressesResult {
  report: ConversationTitleAuditReport;
  /** The operator-facing rendering, produced by the shared describer. */
  description: string;
}

/**
 * Report every title-address half-state in a database, on demand (#task:2016).
 *
 * Two jobs in one command, deliberately not split: it is the PRE-migration
 * cleanup probe (the v72 migration aborts on folded-title collisions and refuses
 * to rename anyone's channel for them, so the operator needs to see the pairs
 * first) and it is the POST-migration answer to "is this database clean?" — a
 * question boot can only answer negatively, since a clean scan at `info` would
 * not survive the default `warn` log level.
 *
 * The connection is read-only and UNMIGRATED: a diagnostic that upgraded the
 * schema before answering would destroy the state it was asked about. That is
 * also why nothing here maps contention — the command takes no lock a writer can
 * hold, and a WAL reader does not wait for one.
 */
export function scanTitleAddresses(
  opts: AdminScanTitleAddressesOptions,
): AdminScanTitleAddressesResult {
  const db = openDatabaseUnmigratedReadOnly(opts.dbPath);
  try {
    const report = scanConversationTitleAddresses(db);
    const description = describeConversationTitleAudit(report);
    opts.logger?.warn(
      {
        admin_op: 'scan-title-addresses',
        scanned: report.scanned,
        keys_expected: report.keysExpected,
        defects: report.defects.length,
        kinds: [...new Set(report.defects.map(defect => defect.kind))],
        ts: Date.now(),
      },
      description,
    );
    return { report, description };
  } finally {
    db.close();
  }
}

export interface AdminScanWorkspaceAddressesResult {
  report: WorkspaceNameAuditReport;
  description: string;
}

/** Read-only pre/post migration diagnostic for the workspace root namespace. */
export function scanWorkspaceAddresses(
  opts: AdminScanTitleAddressesOptions,
): AdminScanWorkspaceAddressesResult {
  const db = openDatabaseUnmigratedReadOnly(opts.dbPath);
  try {
    const report = scanWorkspaceNameAddresses(db);
    const description = describeWorkspaceNameAudit(report);
    opts.logger?.warn({
      admin_op: 'scan-workspace-addresses',
      scanned: report.regularScanned,
      keys_expected: report.keysExpected,
      defects: report.defects.length,
      kinds: [...new Set(report.defects.map(defect => defect.kind))],
      ts: Date.now(),
    }, 'workspace address scan completed');
    return { report, description };
  } finally {
    db.close();
  }
}

function mapAdminDbError(err: unknown): never {
  if (err instanceof AdminResetPasswordError) throw err;
  // The contention verdict comes from the driver-dialect module (#task:1983 W4):
  // this CLI-layer command decides the OPERATOR-facing outcome, never which
  // driver codes mean "someone else holds the lock". It used to compare against
  // `SQLITE_BUSY` alone, so `SQLITE_BUSY_SNAPSHOT` and the `SQLITE_LOCKED*`
  // family reached the operator as a raw driver error instead of this advice.
  if (isSqliteContention(err)) {
    throw new AdminResetPasswordError(
      'db_locked',
      'db_locked: another Silverhand process is writing the database; retry when the write lock is free',
    );
  }
  throw err;
}
