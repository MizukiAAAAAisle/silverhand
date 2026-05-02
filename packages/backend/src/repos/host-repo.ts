import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { HostDto, HostKind, HostRow } from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

function rowToDto(row: HostRow): HostDto {
  return { ...row };
}

export const LOCAL_HOST_NAME = 'local';

export class HostRepo {
  constructor(private readonly db: Db) {}

  list(): HostDto[] {
    const rows = this.db
      .prepare<[], HostRow>('SELECT * FROM hosts ORDER BY created_at ASC')
      .all();
    return rows.map(rowToDto);
  }

  get(id: string): HostDto | null {
    const row = this.db
      .prepare<[string], HostRow>('SELECT * FROM hosts WHERE id = ?')
      .get(id);
    return row ? rowToDto(row) : null;
  }

  getByName(name: string): HostDto | null {
    const row = this.db
      .prepare<[string], HostRow>('SELECT * FROM hosts WHERE name = ?')
      .get(name);
    return row ? rowToDto(row) : null;
  }

  create(name: string, kind: HostKind): HostDto {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO hosts (id, name, kind, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(id, name, kind, now);
    const row = this.get(id);
    if (!row) throw new Error('insert failed');
    return row;
  }

  ensureLocal(): HostDto {
    const existing = this.getByName(LOCAL_HOST_NAME);
    if (existing) return existing;
    return this.create(LOCAL_HOST_NAME, 'local');
  }
}
