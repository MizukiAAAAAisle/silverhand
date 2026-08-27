import type { Database as Db } from 'better-sqlite3';
import type { UserPasswordCredentialRow } from '@silverhand/shared';
import { prepareObserved } from '../observability/observed-statement.js';
import type {
  Argon2idPasswordHashParams,
  PasswordHashResult,
  PersistedPasswordHashParams,
} from '../auth/credential-types.js';
import type { AuthCredentialsPort } from '../auth/ports.js';

export class SqliteAuthCredentialsRepo implements AuthCredentialsPort {
  constructor(private readonly db: Db) {}

  getCredential(userId: string): UserPasswordCredentialRow | null {
    const row = prepareObserved<[string], UserPasswordCredentialRow>(
      this.db,
      'auth_credentials.get',
      `SELECT * FROM user_password_credentials WHERE user_id = ?`,
    ).get(userId);
    return row ?? null;
  }

  upsertPreparedCredential(
    userId: string,
    { passwordHash, passwordHashParams }: PasswordHashResult,
  ): UserPasswordCredentialRow {
    const now = Date.now();
    prepareObserved(
      this.db,
      'auth_credentials.upsert',
      `INSERT INTO user_password_credentials
         (user_id, password_hash, password_hash_params, password_updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         password_hash = excluded.password_hash,
         password_hash_params = excluded.password_hash_params,
         password_updated_at = excluded.password_updated_at`,
    ).run(userId, passwordHash, serializePasswordHashParams(passwordHashParams), now);
    const row = this.getCredential(userId);
    if (!row) {
      throw new Error(
        `SqliteAuthCredentialsRepo.upsertPreparedCredential: row missing for user_id=${userId}`,
      );
    }
    return row;
  }

  lookupLoginCredential(
    email: string,
  ): { userId: string; passwordHash: string | null } | null {
    const row = prepareObserved<[string], { user_id: string; password_hash: string | null }>(
      this.db,
      'auth_credentials.lookup_login',
      `SELECT u.id AS user_id, c.password_hash AS password_hash
         FROM users u
         LEFT JOIN user_password_credentials c ON c.user_id = u.id
        WHERE u.email = ? COLLATE NOCASE`,
    ).get(email);
    if (!row) return null;
    return { userId: row.user_id, passwordHash: row.password_hash };
  }
}

/** Persistence codec for the `password_hash_params` JSON column. */
export function serializePasswordHashParams(
  params: Argon2idPasswordHashParams,
): string {
  return JSON.stringify(params);
}

/**
 * Read the persisted `password_hash_params`, admitting BOTH producer arms. The
 * shared cost fields are validated once; then `library` discriminates the arm and
 * selects its required provenance block (`benchmark` for Node, `calibration` for
 * Rust). Any other `library`, or a missing provenance block, is invalid.
 */
export function parsePasswordHashParams(raw: string): PersistedPasswordHashParams {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    parsed.algorithm !== 'argon2id'
    || parsed.version !== '0x13'
    || !positiveInteger(parsed.memoryCostKiB)
    || !positiveInteger(parsed.timeCost)
    || !positiveInteger(parsed.parallelism)
    || !positiveInteger(parsed.outputLen)
  ) {
    throw new Error('invalid password_hash_params');
  }
  if (parsed.library === '@node-rs/argon2') {
    if (!parsed.benchmark) {
      throw new Error('invalid password_hash_params');
    }
    return parsed as unknown as Argon2idPasswordHashParams;
  }
  if (parsed.library === 'silverhand/argon2-rustcrypto') {
    if (!parsed.calibration) {
      throw new Error('invalid password_hash_params');
    }
    return parsed as unknown as PersistedPasswordHashParams;
  }
  throw new Error('invalid password_hash_params');
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
