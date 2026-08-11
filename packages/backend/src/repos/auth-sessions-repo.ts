import type { Database as Db } from 'better-sqlite3';
import type { AuthSessionRow } from '@silverhand/shared';
import { prepareObserved } from '../observability/observed-statement.js';
import type { AuthSessionsPort, NewAuthSessionRow } from '../auth/ports.js';

export class SqliteAuthSessionsRepo implements AuthSessionsPort {
  constructor(private readonly db: Db) {}

  insertSession(row: NewAuthSessionRow): AuthSessionRow {
    prepareObserved(
      this.db,
      'auth_sessions.insert',
      `INSERT INTO auth_sessions
         (id, user_id, token_hash, created_at, last_used_at, revoked_at,
          user_agent, ip_first_seen)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      row.id,
      row.userId,
      row.tokenHash,
      row.createdAt,
      row.lastUsedAt,
      row.userAgent,
      row.ipFirstSeen,
    );
    const inserted = this.getByTokenHash(row.tokenHash);
    if (!inserted) {
      throw new Error(`SqliteAuthSessionsRepo.insertSession: row missing for id=${row.id}`);
    }
    return inserted;
  }

  getByTokenHash(tokenHash: string): AuthSessionRow | null {
    const row = prepareObserved<[string], AuthSessionRow>(
      this.db,
      'auth_sessions.get_by_token_hash',
      `SELECT * FROM auth_sessions WHERE token_hash = ?`,
    ).get(tokenHash);
    return row ?? null;
  }

  touchLastUsed(id: string, at: number): void {
    prepareObserved(
      this.db,
      'auth_sessions.touch_last_used',
      `UPDATE auth_sessions SET last_used_at = ? WHERE id = ?`,
    ).run(at, id);
  }

  revokeByTokenHash(tokenHash: string, at: number): boolean {
    const result = prepareObserved(
      this.db,
      'auth_sessions.revoke_by_token_hash',
      `UPDATE auth_sessions
          SET revoked_at = ?
        WHERE token_hash = ?
          AND revoked_at IS NULL`,
    ).run(at, tokenHash);
    return result.changes > 0;
  }

  revokeAllForUser(userId: string, at: number): number {
    const result = prepareObserved(
      this.db,
      'auth_sessions.revoke_all_for_user',
      `UPDATE auth_sessions
          SET revoked_at = ?
        WHERE user_id = ?
          AND revoked_at IS NULL`,
    ).run(at, userId);
    return result.changes;
  }
}
