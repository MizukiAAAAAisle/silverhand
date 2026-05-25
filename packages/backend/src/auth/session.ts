import { createHash, randomBytes } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import type { AuthSessionRow } from '@silverhand/shared';
import { DEFAULT_AUTH_SESSION_TTL_MS } from './config.js';

export interface AuthSessionServiceOptions {
  sessionTtlMs?: number;
}

export interface IssuedAuthSession {
  userToken: string;
  session: AuthSessionRow;
}

export class AuthSessionService {
  private readonly sessionTtlMs: number;

  constructor(
    private readonly db: Db,
    opts: AuthSessionServiceOptions = {},
  ) {
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_AUTH_SESSION_TTL_MS;
  }

  issueSession(input: {
    userId: string;
    userAgent?: string | null;
    ipFirstSeen?: string | null;
  }): IssuedAuthSession {
    const userToken = randomBytes(32).toString('base64url');
    const tokenHash = hashSessionToken(userToken);
    const now = Date.now();
    const id = randomBytes(12).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO auth_sessions
           (id, user_id, token_hash, created_at, last_used_at, revoked_at,
            user_agent, ip_first_seen)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        tokenHash,
        now,
        now,
        normalizeInfoField(input.userAgent),
        normalizeInfoField(input.ipFirstSeen),
      );
    const session = this.getByTokenHash(tokenHash);
    if (!session) {
      throw new Error(`AuthSessionService.issueSession: row missing for id=${id}`);
    }
    return { userToken, session };
  }

  validateSessionToken(
    token: string,
  ): { ok: true; session: AuthSessionRow } | { ok: false; code: 'auth_failed' } {
    const normalized = token.trim();
    if (!normalized) return { ok: false, code: 'auth_failed' };
    const tokenHash = hashSessionToken(normalized);
    const session = this.getByTokenHash(tokenHash);
    if (!session || session.revoked_at !== null || this.isExpired(session)) {
      return { ok: false, code: 'auth_failed' };
    }
    const now = Date.now();
    this.db
      .prepare(`UPDATE auth_sessions SET last_used_at = ? WHERE id = ?`)
      .run(now, session.id);
    return {
      ok: true,
      session: {
        ...session,
        last_used_at: now,
      },
    };
  }

  revokeSessionToken(token: string): boolean {
    const normalized = token.trim();
    if (!normalized) return false;
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE auth_sessions
            SET revoked_at = ?
          WHERE token_hash = ?
            AND revoked_at IS NULL`,
      )
      .run(now, hashSessionToken(normalized));
    return result.changes > 0;
  }

  getByTokenHash(tokenHash: string): AuthSessionRow | null {
    const row = this.db
      .prepare<[string], AuthSessionRow>(
        `SELECT * FROM auth_sessions WHERE token_hash = ?`,
      )
      .get(tokenHash);
    return row ?? null;
  }

  private isExpired(session: AuthSessionRow): boolean {
    return session.last_used_at + this.sessionTtlMs < Date.now();
  }
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function normalizeInfoField(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 512);
}
