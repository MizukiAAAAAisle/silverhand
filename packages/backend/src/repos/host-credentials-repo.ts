import type { Database as Db } from 'better-sqlite3';
import type { HostCredentialRow } from '@silverhand/shared';
import { prepareObserved } from '../observability/observed-statement.js';
import type {
  CredentialWithHostStatus,
  HostCredentialsPort,
  NewHostCredentialRow,
} from '../auth/host-ports.js';

export class SqliteHostCredentialsRepo implements HostCredentialsPort {
  constructor(private readonly db: Db) {}

  insert(row: NewHostCredentialRow): HostCredentialRow {
    prepareObserved(
      this.db,
      'host_credentials.insert',
      `INSERT INTO host_credentials
         (id, host_id, token_hash, kind, expires_at, consumed_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run(row.id, row.hostId, row.tokenHash, row.kind, row.expiresAt, row.consumedAt);
    const inserted = this.getById(row.id);
    if (!inserted) {
      throw new Error(`SqliteHostCredentialsRepo.insert: row missing for id=${row.id}`);
    }
    return inserted;
  }

  getById(id: string): HostCredentialRow | null {
    const row = prepareObserved<[string], HostCredentialRow>(
      this.db,
      'host_credentials.get_by_id',
      `SELECT * FROM host_credentials WHERE id = ?`,
    ).get(id);
    return row ?? null;
  }

  lookupVerification(tokenHash: string): CredentialWithHostStatus | null {
    const row = prepareObserved<[string], CredentialWithHostStatus>(
      this.db,
      'host_credentials.lookup_verification',
      `SELECT cred.id,
              cred.host_id,
              cred.token_hash,
              cred.kind,
              cred.expires_at,
              cred.consumed_at,
              cred.revoked_at,
              h.user_id AS host_user_id,
              h.revoked_at AS host_revoked_at
         FROM host_credentials cred
         JOIN hosts h ON h.id = cred.host_id
        WHERE cred.token_hash = ?`,
    ).get(tokenHash);
    return row ?? null;
  }

  hasActiveLongLivedCredential(hostId: string, now: number): boolean {
    const row = prepareObserved<[string, number], { c: number }>(
      this.db,
      'host_credentials.has_active_long_lived',
      `SELECT COUNT(*) AS c
         FROM host_credentials cred
         JOIN hosts h ON h.id = cred.host_id
        WHERE cred.host_id = ?
          AND cred.kind = 'long_lived'
          AND cred.consumed_at IS NULL
          AND cred.revoked_at IS NULL
          AND (cred.expires_at IS NULL OR cred.expires_at > ?)
          AND h.revoked_at IS NULL
          AND h.user_id IS NOT NULL`,
    ).get(hostId, now);
    return (row?.c ?? 0) > 0;
  }

  revokeById(credentialId: string, revokedAt: number): boolean {
    const result = prepareObserved(
      this.db,
      'host_credentials.revoke_by_id',
      `UPDATE host_credentials
          SET revoked_at = ?
        WHERE id = ?
          AND revoked_at IS NULL`,
    ).run(revokedAt, credentialId);
    return result.changes > 0;
  }

  revokeAllForHost(hostId: string, revokedAt: number): number {
    const result = prepareObserved(
      this.db,
      'host_credentials.revoke_all_for_host',
      `UPDATE host_credentials
          SET revoked_at = ?
        WHERE host_id = ?
          AND revoked_at IS NULL`,
    ).run(revokedAt, hostId);
    return result.changes;
  }

  revokeOtherLongLivedForHost(input: {
    hostId: string;
    keepCredentialId: string;
    revokedAt: number;
    consumedAt: number;
    onlyUnexpiredAt?: number;
  }): number {
    if (input.onlyUnexpiredAt !== undefined) {
      const result = prepareObserved(
        this.db,
        'host_credentials.revoke_other_long_lived_unexpired',
        `UPDATE host_credentials
            SET revoked_at = ?,
                consumed_at = COALESCE(consumed_at, ?)
          WHERE host_id = ?
            AND id <> ?
            AND kind = 'long_lived'
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)`,
      ).run(
        input.revokedAt,
        input.consumedAt,
        input.hostId,
        input.keepCredentialId,
        input.onlyUnexpiredAt,
      );
      return result.changes;
    }
    const result = prepareObserved(
      this.db,
      'host_credentials.revoke_other_long_lived',
      `UPDATE host_credentials
          SET revoked_at = ?,
              consumed_at = COALESCE(consumed_at, ?)
        WHERE host_id = ?
          AND id <> ?
          AND kind = 'long_lived'
          AND revoked_at IS NULL`,
    ).run(input.revokedAt, input.consumedAt, input.hostId, input.keepCredentialId);
    return result.changes;
  }
}
