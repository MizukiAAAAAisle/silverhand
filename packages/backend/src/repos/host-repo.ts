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
    revoked_at: row.revoked_at,
    last_seen_at: row.last_seen_at,
  };
}

export const LOCAL_HOST_NAME = 'local';

export interface CreateHostOptions {
  userId?: string | null;
  installationId?: string | null;
  lastSeenAt?: number | null;
}

export interface ClaimLocalHostResult {
  host: HostRow;
  created: boolean;
}

export class HostRepo {
  constructor(private readonly db: Db) {}

  list(): HostDto[] {
    const rows = this.db
      .prepare<[], HostRow>('SELECT * FROM hosts ORDER BY created_at ASC')
      .all();
    return rows.map(rowToDto);
  }

  /** Owner-scoped list used by `GET /api/hosts` (Stage B.4 viewer
   *  filter). Includes revoked rows so the user can see audit
   *  history; sort active rows first then by created_at. */
  listForUser(userId: string): HostDto[] {
    const rows = this.db
      .prepare<[string], HostRow>(
        `SELECT * FROM hosts
          WHERE user_id = ?
          ORDER BY (CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END) ASC,
                   created_at ASC`,
      )
      .all(userId);
    return rows.map(rowToDto);
  }

  /** DTO conversion exposed for routes that already hold a row. */
  toDto(row: HostRow): HostDto {
    return rowToDto(row);
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

  /** Active-only lookup. Stage B.4 changed the partial-unique index
   *  on `(user_id, installation_id)` to active-only so `claim-or-create`
   *  can mint a fresh active row for a recurring installation after
   *  revoke; this lookup matches that invariant. Revoked rows stay in
   *  the table for audit history but never surface here. */
  getByUserInstallation(userId: string, installationId: string): HostRow | null {
    const row = this.db
      .prepare<[string, string], HostRow>(
        `SELECT * FROM hosts
          WHERE user_id = ?
            AND installation_id = ?
            AND revoked_at IS NULL`,
      )
      .get(userId, installationId);
    return row ?? null;
  }

  getOwnedLocalForUser(userId: string): HostRow | null {
    const row = this.db
      .prepare<[string], HostRow>(
        `SELECT * FROM hosts
          WHERE user_id = ?
            AND kind = 'local'
            AND revoked_at IS NULL
          ORDER BY COALESCE(last_seen_at, created_at) DESC,
                   created_at DESC`,
      )
      .get(userId);
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

  claimOrCreateLocal(input: {
    userId: string;
    installationId: string;
    preferredName?: string;
    now?: number;
  }): ClaimLocalHostResult {
    const now = input.now ?? Date.now();
    // Active-only lookup (Stage B.4). If a prior host for the same
    // (user, installation) was revoked, it is no longer surfaced here
    // and the path falls through to legacy/unclaimed reuse or to a
    // fresh `create`, matching the active-only partial-unique index.
    const existing = this.getByUserInstallation(input.userId, input.installationId);
    if (existing) {
      this.touchLastSeen(existing.id, now);
      const touched = this.get(existing.id);
      if (!touched) {
        throw new Error(
          `HostRepo.claimOrCreateLocal: missing existing host ${existing.id}`,
        );
      }
      return { host: touched, created: false };
    }

    const legacyLocal = this.getUnclaimedLocal();
    if (legacyLocal) {
      return {
        host: this.bindToUserInstallation({
          hostId: legacyLocal.id,
          userId: input.userId,
          installationId: input.installationId,
          lastSeenAt: now,
        }),
        created: false,
      };
    }

    return {
      host: this.create(this.uniqueLocalHostName(input), 'local', {
        userId: input.userId,
        installationId: input.installationId,
        lastSeenAt: now,
      }),
      created: true,
    };
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

  private getUnclaimedLocal(): HostRow | null {
    const row = this.db
      .prepare<[string], HostRow>(
        `SELECT * FROM hosts
          WHERE name = ?
            AND kind = 'local'
            AND user_id IS NULL
            AND installation_id IS NULL
            AND revoked_at IS NULL`,
      )
      .get(LOCAL_HOST_NAME);
    return row ?? null;
  }

  private uniqueLocalHostName(input: {
    installationId: string;
    preferredName?: string;
  }): string {
    const base = normalizeHostName(input.preferredName ?? LOCAL_HOST_NAME);
    const prefix = input.installationId.replace(/-/g, '').slice(0, 8);
    const candidates = [
      base,
      `${base}-${prefix}`,
      `${LOCAL_HOST_NAME}-${prefix}`,
    ];
    for (const candidate of candidates) {
      if (!this.getByName(candidate)) return candidate;
    }
    for (let i = 0; i < 8; i++) {
      const candidate = `${LOCAL_HOST_NAME}-${prefix}-${randomBytes(3).toString('hex')}`;
      if (!this.getByName(candidate)) return candidate;
    }
    throw new Error('HostRepo.claimOrCreateLocal: unable to allocate host name');
  }
}

function normalizeHostName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || LOCAL_HOST_NAME;
}
