import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { HostDto, HostKind, HostRow } from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

function rowToDto(row: HostRow): HostDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    created_at: row.created_at,
  };
}

export const LOCAL_HOST_NAME = 'local';

export interface CreateHostOptions {
  userId?: string | null;
  installationId?: string | null;
  lastSeenAt?: number | null;
}

export class HostRepo {
  constructor(private readonly db: Db) {}

  list(): HostDto[] {
    const rows = this.db
      .prepare<[], HostRow>('SELECT * FROM hosts ORDER BY created_at ASC')
      .all();
    return rows.map(rowToDto);
  }

  get(id: string): HostRow | null {
    const row = this.db
      .prepare<[string], HostRow>('SELECT * FROM hosts WHERE id = ?')
      .get(id);
    return row ?? null;
  }

  getByName(name: string): HostRow | null {
    const row = this.db
      .prepare<[string], HostRow>('SELECT * FROM hosts WHERE name = ?')
      .get(name);
    return row ?? null;
  }

  create(name: string, kind: HostKind, opts: CreateHostOptions = {}): HostRow {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO hosts
           (id, name, kind, user_id, installation_id, last_seen_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        id,
        name,
        kind,
        opts.userId ?? null,
        opts.installationId ?? null,
        opts.lastSeenAt ?? null,
        now,
      );
    const row = this.get(id);
    if (!row) throw new Error('insert failed');
    return row;
  }

  getByUserInstallation(userId: string, installationId: string): HostRow | null {
    const row = this.db
      .prepare<[string, string], HostRow>(
        `SELECT * FROM hosts
          WHERE user_id = ?
            AND installation_id = ?`,
      )
      .get(userId, installationId);
    return row ?? null;
  }

  bindToUserInstallation(input: {
    hostId: string;
    userId: string;
    installationId: string;
    lastSeenAt?: number;
  }): HostRow {
    this.db
      .prepare(
        `UPDATE hosts
            SET user_id = ?,
                installation_id = ?,
                last_seen_at = ?
          WHERE id = ?`,
      )
      .run(
        input.userId,
        input.installationId,
        input.lastSeenAt ?? Date.now(),
        input.hostId,
      );
    const row = this.get(input.hostId);
    if (!row) {
      throw new Error(
        `HostRepo.bindToUserInstallation: missing host ${input.hostId}`,
      );
    }
    return row;
  }

  touchLastSeen(id: string, lastSeenAt = Date.now()): boolean {
    const result = this.db
      .prepare(`UPDATE hosts SET last_seen_at = ? WHERE id = ?`)
      .run(lastSeenAt, id);
    return result.changes > 0;
  }

  revoke(id: string, revokedAt = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE hosts
            SET revoked_at = ?
          WHERE id = ?
            AND revoked_at IS NULL`,
      )
      .run(revokedAt, id);
    return result.changes > 0;
  }

  ensureLocal(): HostRow {
    const existing = this.getByName(LOCAL_HOST_NAME);
    if (existing) return existing;
    return this.create(LOCAL_HOST_NAME, 'local');
  }
}
