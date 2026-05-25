import { createHash, randomBytes } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import type {
  HostCredentialKind,
  HostCredentialRow,
} from '@silverhand/shared';

export const HOST_TOKEN_ROTATION_GRACE_MS = 60_000;

export interface IssuedHostToken {
  hostToken: string;
  credential: HostCredentialRow;
}

export type VerifyHostTokenFailureCode =
  | 'missing'
  | 'credential_not_usable'
  | 'credential_revoked'
  | 'credential_expired'
  | 'host_revoked'
  | 'host_unbound';

export type VerifyHostTokenResult =
  | {
      ok: true;
      hostId: string;
      userId: string;
      credentialId: string;
    }
  | {
      ok: false;
      code: VerifyHostTokenFailureCode;
    };

export type HostCredentialIssueFailureCode =
  | 'host_missing'
  | 'host_unbound'
  | 'host_revoked';

export class HostCredentialIssueError extends Error {
  constructor(
    readonly code: HostCredentialIssueFailureCode,
    readonly hostId: string,
  ) {
    super(`cannot issue host credential for ${hostId}: ${code}`);
    this.name = 'HostCredentialIssueError';
  }
}

export class HostTokenService {
  constructor(private readonly db: Db) {}

  issueHostToken(input: {
    hostId: string;
    kind?: HostCredentialKind;
    expiresAt?: number | null;
    consumedAt?: number | null;
  }): IssuedHostToken {
    const kind = input.kind ?? 'long_lived';
    this.assertHostCanReceiveCredential(input.hostId);

    const hostToken = randomBytes(32).toString('base64url');
    const tokenHash = hashHostToken(hostToken);
    const id = randomBytes(12).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO host_credentials
           (id, host_id, token_hash, kind, expires_at, consumed_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.hostId,
        tokenHash,
        kind,
        input.expiresAt ?? null,
        input.consumedAt ?? null,
      );
    const credential = this.getCredentialById(id);
    if (!credential) {
      throw new Error(`HostTokenService.issueHostToken: row missing for id=${id}`);
    }
    return { hostToken, credential };
  }

  rotateHostToken(input: {
    hostId: string;
    now?: number;
    graceMs?: number;
  }): IssuedHostToken {
    const now = input.now ?? Date.now();
    const graceUntil = now + (input.graceMs ?? HOST_TOKEN_ROTATION_GRACE_MS);
    return this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE host_credentials
              SET expires_at = CASE
                    WHEN expires_at IS NULL OR expires_at > ? THEN ?
                    ELSE expires_at
                  END
            WHERE host_id = ?
              AND kind = 'long_lived'
              AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .run(graceUntil, graceUntil, input.hostId, now);
      return this.issueHostToken({ hostId: input.hostId });
    })();
  }

  revokeCredential(credentialId: string, revokedAt = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE host_credentials
            SET revoked_at = ?
          WHERE id = ?
            AND revoked_at IS NULL`,
      )
      .run(revokedAt, credentialId);
    return result.changes > 0;
  }

  /** Bulk-revoke every active credential for a host (Stage B.4 host
   *  revoke). No grace — once a host is being soft-deleted there is
   *  no operational reason to leave any active token behind. Returns
   *  the number of rows updated; idempotent (a re-run on an
   *  already-swept host is a no-op). */
  revokeAllCredentialsForHost(
    hostId: string,
    revokedAt: number = Date.now(),
  ): number {
    const result = this.db
      .prepare(
        `UPDATE host_credentials
            SET revoked_at = ?
          WHERE host_id = ?
            AND revoked_at IS NULL`,
      )
      .run(revokedAt, hostId);
    return result.changes;
  }

  verifyHostToken(token: string, opts: { now?: number } = {}): VerifyHostTokenResult {
    const normalized = token.trim();
    if (!normalized) return { ok: false, code: 'missing' };

    const row = this.db
      .prepare<[string], HostCredentialJoinRow>(
        `SELECT c.id,
                c.host_id,
                c.token_hash,
                c.kind,
                c.expires_at,
                c.consumed_at,
                c.revoked_at,
                h.user_id AS host_user_id,
                h.revoked_at AS host_revoked_at
           FROM host_credentials c
           JOIN hosts h ON h.id = c.host_id
          WHERE c.token_hash = ?`,
      )
      .get(hashHostToken(normalized));

    if (!row) return { ok: false, code: 'missing' };
    if (row.kind !== 'long_lived' || row.consumed_at !== null) {
      return { ok: false, code: 'credential_not_usable' };
    }
    if (row.revoked_at !== null) return { ok: false, code: 'credential_revoked' };

    const now = opts.now ?? Date.now();
    if (row.expires_at !== null && row.expires_at <= now) {
      return { ok: false, code: 'credential_expired' };
    }
    if (row.host_revoked_at !== null) return { ok: false, code: 'host_revoked' };
    if (!row.host_user_id) return { ok: false, code: 'host_unbound' };

    return {
      ok: true,
      hostId: row.host_id,
      userId: row.host_user_id,
      credentialId: row.id,
    };
  }

  hasActiveLongLivedCredential(
    hostId: string,
    opts: { now?: number } = {},
  ): boolean {
    const now = opts.now ?? Date.now();
    const row = this.db
      .prepare<[string, number], { c: number }>(
        `SELECT COUNT(*) AS c
           FROM host_credentials c
           JOIN hosts h ON h.id = c.host_id
          WHERE c.host_id = ?
            AND c.kind = 'long_lived'
            AND c.consumed_at IS NULL
            AND c.revoked_at IS NULL
            AND (c.expires_at IS NULL OR c.expires_at > ?)
            AND h.revoked_at IS NULL
            AND h.user_id IS NOT NULL`,
      )
      .get(hostId, now);
    return (row?.c ?? 0) > 0;
  }

  private getCredentialById(id: string): HostCredentialRow | null {
    const row = this.db
      .prepare<[string], HostCredentialRow>(
        `SELECT * FROM host_credentials WHERE id = ?`,
      )
      .get(id);
    return row ?? null;
  }

  private assertHostCanReceiveCredential(hostId: string): void {
    const row = this.db
      .prepare<[string], { user_id: string | null; revoked_at: number | null }>(
        `SELECT user_id, revoked_at FROM hosts WHERE id = ?`,
      )
      .get(hostId);
    if (!row) {
      throw new HostCredentialIssueError('host_missing', hostId);
    }
    if (!row.user_id) {
      throw new HostCredentialIssueError('host_unbound', hostId);
    }
    if (row.revoked_at !== null) {
      throw new HostCredentialIssueError('host_revoked', hostId);
    }
  }
}

export function hashHostToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

interface HostCredentialJoinRow extends HostCredentialRow {
  host_user_id: string | null;
  host_revoked_at: number | null;
}
