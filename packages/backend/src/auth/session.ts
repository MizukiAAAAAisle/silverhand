import { createHash, randomBytes } from 'node:crypto';
import type { AuthSessionRow } from '@silverhand/shared';
import { DEFAULT_AUTH_SESSION_TTL_MS } from './config.js';
import type { AuthSessionsPort } from './ports.js';

export interface AuthSessionServiceOptions {
  sessionTtlMs?: number;
}

export interface IssuedAuthSession {
  userToken: string;
  session: AuthSessionRow;
}

/** Session token domain logic (generation, hashing, TTL); persistence goes
 *  through the driver-free `AuthSessionsPort`. */
export class AuthSessionService {
  private readonly sessionTtlMs: number;

  constructor(
    private readonly sessions: AuthSessionsPort,
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
    const session = this.sessions.insertSession({
      id: randomBytes(12).toString('base64url'),
      userId: input.userId,
      tokenHash,
      createdAt: now,
      lastUsedAt: now,
      userAgent: normalizeInfoField(input.userAgent),
      ipFirstSeen: normalizeInfoField(input.ipFirstSeen),
    });
    return { userToken, session };
  }

  validateSessionToken(
    token: string,
  ): { ok: true; session: AuthSessionRow } | { ok: false; code: 'auth_failed' } {
    const normalized = token.trim();
    if (!normalized) return { ok: false, code: 'auth_failed' };
    const tokenHash = hashSessionToken(normalized);
    const session = this.sessions.getByTokenHash(tokenHash);
    if (!session || session.revoked_at !== null || this.isExpired(session)) {
      return { ok: false, code: 'auth_failed' };
    }
    const now = Date.now();
    this.sessions.touchLastUsed(session.id, now);
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
    return this.sessions.revokeByTokenHash(hashSessionToken(normalized), Date.now());
  }

  revokeAllForUser(userId: string, revokedAt = Date.now()): number {
    return this.sessions.revokeAllForUser(userId, revokedAt);
  }

  getByTokenHash(tokenHash: string): AuthSessionRow | null {
    return this.sessions.getByTokenHash(tokenHash);
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
