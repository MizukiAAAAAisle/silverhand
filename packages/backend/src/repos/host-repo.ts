import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { HOST_DISPLAY_LABEL_MAX_LENGTH } from '@silverhand/shared';
import type {
  HostDto,
  HostKind,
  HostLifecycleStatus,
  HostProvisioningSource,
  HostRow,
} from '@silverhand/shared';
import { prepareObserved } from '../observability/observed-statement.js';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

export const HOST_READY_FOR_PLACEMENT_SQL =
  'activated_at IS NOT NULL AND finalized_at IS NOT NULL AND revoked_at IS NULL';

// Keep this TS predicate in lockstep with HOST_READY_FOR_PLACEMENT_SQL above.
// SQL query paths use the constant; in-memory/assertion paths use this helper.
export function isHostReadyForPlacement(
  row: Pick<HostRow, 'activated_at' | 'finalized_at' | 'revoked_at'>,
): boolean {
  return (
    row.activated_at !== null &&
    row.finalized_at !== null &&
    row.revoked_at === null
  );
}

export function getHostLifecycleStatus(
  row: Pick<HostRow, 'activated_at' | 'finalized_at' | 'revoked_at'>,
): HostLifecycleStatus {
  if (row.revoked_at !== null) return 'revoked';
  if (isHostReadyForPlacement(row)) return 'active';
  if (row.activated_at !== null) return 'attached';
  return 'pending';
}

function rowToDto(row: HostRow): HostDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
    last_seen_at: row.last_seen_at,
    activated_at: row.activated_at,
    finalized_at: row.finalized_at,
    connected_host_name: null,
    provisioning_source: row.provisioning_source,
    status: getHostLifecycleStatus(row),
    placeable: isHostReadyForPlacement(row),
    creator_user_id: row.user_id,
    display_label: row.display_label,
  };
}

export const LOCAL_HOST_NAME = 'local';
export const STANDALONE_SERVER_HOST_NAME = 'standalone-server';

export interface CreateHostOptions {
  userId?: string | null;
  installationId?: string | null;
  lastSeenAt?: number | null;
  /** v36: raw user-supplied label captured at claim time. Stored as
   *  `hosts.display_label`; the renderer reads `display_label ?? name`.
   *  `name` is independently the normalized stable identifier. */
  displayLabel?: string | null;
  activatedAt?: number | null;
  finalizedAt?: number | null;
  provisioningSource?: HostProvisioningSource;
}

export interface ClaimLocalHostResult {
  host: HostRow;
  created: boolean;
}

export class HostRepo {
  constructor(private readonly db: Db) {}

  list(): HostDto[] {
    const rows = prepareObserved<[], HostRow>(
      this.db,
      'hosts.list_all',
      'SELECT * FROM hosts ORDER BY created_at ASC',
    ).all();
    return rows.map(rowToDto);
  }

  /** Owner-scoped list used by `GET /api/hosts` (Stage B.4 viewer
   *  filter). Includes revoked rows so the user can see audit
   *  history; sort active rows first then by created_at. */
  listForUser(userId: string): HostDto[] {
    const rows = prepareObserved<[string], HostRow>(
      this.db,
      'hosts.list_for_user',
      `SELECT * FROM hosts
          WHERE user_id = ?
            AND NOT (
              provisioning_source = 'user_invite'
              AND finalized_at IS NULL
            )
          ORDER BY (CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END) ASC,
                   created_at ASC`,
    ).all(userId);
    return rows.map(rowToDto);
  }

  /** DTO conversion exposed for routes that already hold a row. */
  toDto(row: HostRow): HostDto {
    return rowToDto(row);
  }

  get(id: string): HostRow | null {
    const row = prepareObserved<[string], HostRow>(
      this.db,
      'hosts.get_by_id',
      'SELECT * FROM hosts WHERE id = ?',
    ).get(id);
    return row ?? null;
  }

  getByName(name: string): HostRow | null {
    const row = prepareObserved<[string], HostRow>(
      this.db,
      'hosts.get_by_name',
      'SELECT * FROM hosts WHERE name = ?',
    ).get(name);
    return row ?? null;
  }

  create(name: string, kind: HostKind, opts: CreateHostOptions = {}): HostRow {
    const id = newId();
    const now = Date.now();
    const activatedAt =
      opts.activatedAt !== undefined
        ? opts.activatedAt
        : opts.userId && kind === 'local'
          ? (opts.lastSeenAt ?? now)
          : null;
    const finalizedAt =
      opts.finalizedAt !== undefined
        ? opts.finalizedAt
        : opts.userId && kind === 'local'
          ? activatedAt
          : null;
    const provisioningSource =
      opts.provisioningSource ??
      (opts.userId && kind === 'local' && opts.installationId
        ? 'app_install'
        : 'system');
    prepareObserved(
      this.db,
      'hosts.create',
      `INSERT INTO hosts
           (id, name, kind, user_id, installation_id, last_seen_at, revoked_at, created_at, display_label, activated_at, finalized_at, provisioning_source)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      kind,
      opts.userId ?? null,
      opts.installationId ?? null,
      opts.lastSeenAt ?? null,
      now,
      normalizeDisplayLabel(opts.displayLabel),
      activatedAt,
      finalizedAt,
      provisioningSource,
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
  getByUserInstallation(
    userId: string,
    installationId: string,
  ): HostRow | null {
    const row = prepareObserved<[string, string], HostRow>(
      this.db,
      'hosts.get_by_user_installation',
      `SELECT * FROM hosts
          WHERE user_id = ?
            AND installation_id = ?
            AND revoked_at IS NULL`,
    ).get(userId, installationId);
    return row ?? null;
  }

  getOwnedLocalForUser(userId: string): HostRow | null {
    const row = prepareObserved<[string], HostRow>(
      this.db,
      'hosts.get_owned_local_for_user',
      `SELECT * FROM hosts
          WHERE user_id = ?
            AND kind = 'local'
            AND revoked_at IS NULL
          ORDER BY COALESCE(last_seen_at, created_at) DESC,
                   created_at DESC`,
    ).get(userId);
    return row ?? null;
  }

  /**
   * D4.c C1 — list every active local host owned by `userId`,
   * sorted with the most-recently-seen first (same secondary sort
   * key as `getOwnedLocalForUser`).
   *
   * Why a separate method:
   * - `getOwnedLocalForUser` silently picks the "best" single host
   *   when the user has multiple active local hosts (e.g. local
   *   daemon + sandbox daemon on the same machine, or two desktop
   *   hosts both attached to the same remote backend). In M1
   *   multi-host scenarios this silent-pick is no longer safe —
   *   the placement layer needs to either get a single row or
   *   surface a typed `local_host_ambiguous` error so the caller
   *   picks explicitly.
   * - This list view is the basis for that ambiguity detection in
   *   `RuntimeHostPlacementResolver.resolveOwnedLocalForUser`:
   *   0 rows → `local_host_unbound`, 1 row → return, ≥2 rows →
   *   `local_host_ambiguous`.
   * - Revoked rows are excluded (same as the single-row variant);
   *   they live in the table for audit history only.
   */
  listOwnedActiveLocalForUser(userId: string): HostRow[] {
    return prepareObserved<[string], HostRow>(
      this.db,
      'hosts.list_owned_active_local_for_user',
      `SELECT * FROM hosts
          WHERE user_id = ?
            AND kind = 'local'
            AND revoked_at IS NULL
          ORDER BY COALESCE(last_seen_at, created_at) DESC,
                   created_at DESC`,
    ).all(userId);
  }

  listOwnedReadyForPlacement(userId: string): HostRow[] {
    return prepareObserved<[string], HostRow>(
      this.db,
      'hosts.list_owned_ready_for_placement',
      `SELECT * FROM hosts
          WHERE user_id = ?
            AND ${HOST_READY_FOR_PLACEMENT_SQL}
          ORDER BY COALESCE(last_seen_at, activated_at, created_at) DESC,
                   created_at DESC`,
    ).all(userId);
  }

  bindToUserInstallation(input: {
    hostId: string;
    userId: string;
    installationId: string;
    lastSeenAt?: number;
  }): HostRow {
    const lastSeenAt = input.lastSeenAt ?? Date.now();
    prepareObserved(
      this.db,
      'hosts.bind_to_user_installation',
      `UPDATE hosts
            SET user_id = ?,
                installation_id = ?,
                last_seen_at = ?,
                activated_at = COALESCE(activated_at, ?),
                finalized_at = COALESCE(finalized_at, ?),
                provisioning_source = 'app_install'
          WHERE id = ?`,
    ).run(
      input.userId,
      input.installationId,
      lastSeenAt,
      lastSeenAt,
      lastSeenAt,
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
    const existing = this.getByUserInstallation(
      input.userId,
      input.installationId,
    );
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
      const bound = this.bindToUserInstallation({
        hostId: legacyLocal.id,
        userId: input.userId,
        installationId: input.installationId,
        lastSeenAt: now,
      });
      // v36 (#task:808): the preferred label is the user's chosen
      // rename; it must apply whether we minted a fresh row OR bound an
      // existing legacy `local` placeholder — otherwise renaming would
      // silently drop on bootstrap-only installs (those where
      // `ensureLocal` ran first and left an unclaimed row sitting on the
      // canonical `LOCAL_HOST_NAME`). Only set when a label was actually
      // supplied, so subsequent reclaims without a label don't blank an
      // existing display_label.
      const labeled =
        input.preferredName !== undefined
          ? this.updateDisplayLabel(bound.id, input.preferredName)
          : null;
      return { host: labeled ?? bound, created: false };
    }

    return {
      host: this.create(this.uniqueLocalHostName(input), 'local', {
        userId: input.userId,
        installationId: input.installationId,
        lastSeenAt: now,
        displayLabel: input.preferredName ?? null,
      }),
      created: true,
    };
  }

  /** v36 (#task:808): user-facing rename. Pass `null` to clear the
   *  custom label back to the default (renderer falls back to `name`).
   *  Returns the updated row, or `null` when the host id doesn't exist.
   *  Trims/validates length per `normalizeDisplayLabel`. */
  updateDisplayLabel(id: string, label: string | null): HostRow | null {
    const normalized = normalizeDisplayLabel(label);
    prepareObserved(
      this.db,
      'hosts.update_display_label',
      'UPDATE hosts SET display_label = ? WHERE id = ?',
    ).run(normalized, id);
    return this.get(id);
  }

  touchLastSeen(id: string, lastSeenAt = Date.now()): boolean {
    const result = prepareObserved(
      this.db,
      'hosts.touch_last_seen',
      'UPDATE hosts SET last_seen_at = ? WHERE id = ?',
    ).run(lastSeenAt, id);
    return result.changes > 0;
  }

  markActivated(id: string, activatedAt = Date.now()): HostRow | null {
    prepareObserved(
      this.db,
      'hosts.mark_activated',
      `UPDATE hosts
            SET activated_at = COALESCE(activated_at, ?),
                last_seen_at = ?
          WHERE id = ?`,
    ).run(activatedAt, activatedAt, id);
    return this.get(id);
  }

  markFinalized(id: string, finalizedAt = Date.now()): HostRow | null {
    prepareObserved(
      this.db,
      'hosts.mark_finalized',
      `UPDATE hosts
            SET finalized_at = COALESCE(finalized_at, ?)
          WHERE id = ?`,
    ).run(finalizedAt, id);
    return this.get(id);
  }

  deleteOwnedUserInvite(input: { hostId: string; userId: string }): boolean {
    const result = prepareObserved(
      this.db,
      'hosts.delete_owned_user_invite',
      `DELETE FROM hosts
          WHERE id = ?
            AND user_id = ?
            AND kind = 'remote'
            AND provisioning_source = 'user_invite'`,
    ).run(input.hostId, input.userId);
    return result.changes > 0;
  }

  revoke(id: string, revokedAt = Date.now()): boolean {
    const result = prepareObserved(
      this.db,
      'hosts.revoke',
      `UPDATE hosts
            SET revoked_at = ?
          WHERE id = ?
            AND revoked_at IS NULL`,
    ).run(revokedAt, id);
    return result.changes > 0;
  }

  ensureLocal(): HostRow {
    const existing = this.getByName(LOCAL_HOST_NAME);
    if (existing) return existing;
    return this.create(LOCAL_HOST_NAME, 'local');
  }

  ensureStandaloneServer(): HostRow {
    // D1 standalone uses one shared control-plane placeholder. D2 remote
    // daemon placement must introduce per-user host ownership before any
    // agent placement path treats this row as executable.
    const existing = this.getByName(STANDALONE_SERVER_HOST_NAME);
    if (existing) return existing;
    return this.create(STANDALONE_SERVER_HOST_NAME, 'remote');
  }

  createUserInvite(input: { userId: string }): HostRow {
    for (let i = 0; i < 8; i++) {
      const name = `computer-${randomBytes(4).toString('hex')}`;
      if (this.getByName(name)) continue;
      return this.create(name, 'remote', {
        userId: input.userId,
        installationId: null,
        lastSeenAt: null,
        activatedAt: null,
        provisioningSource: 'user_invite',
        displayLabel: null,
      });
    }
    throw new Error('HostRepo.createUserInvite: unable to allocate host name');
  }

  private getUnclaimedLocal(): HostRow | null {
    const row = prepareObserved<[string], HostRow>(
      this.db,
      'hosts.get_unclaimed_local',
      `SELECT * FROM hosts
          WHERE name = ?
            AND kind = 'local'
            AND user_id IS NULL
            AND installation_id IS NULL
            AND revoked_at IS NULL`,
    ).get(LOCAL_HOST_NAME);
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
    throw new Error(
      'HostRepo.claimOrCreateLocal: unable to allocate host name',
    );
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

/**
 * v36: display-label normalization. UI-facing field — much looser than
 * `name`: keep user-typed characters as-is (CJK, spaces, casing all
 * fine) but trim whitespace and coerce empty → null so the renderer's
 * `display_label ?? name` fallback fires.
 *
 * Length is NOT normalized here. This used to `slice(0, 64)`, which made
 * the write layer silently return a value the caller never sent
 * (#task:1849). Every production caller now arrives through a schema
 * bounded by `HOST_DISPLAY_LABEL_MAX_LENGTH`, so an over-long label at
 * this depth means a caller bypassed the contract: throw and let it
 * surface as a 500 rather than quietly storing something else.
 */
function normalizeDisplayLabel(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length > HOST_DISPLAY_LABEL_MAX_LENGTH) {
    throw new Error(
      `display_label exceeds ${HOST_DISPLAY_LABEL_MAX_LENGTH} characters `
        + `(got ${trimmed.length}) — validate at the API boundary before writing`,
    );
  }
  return trimmed.length > 0 ? trimmed : null;
}
