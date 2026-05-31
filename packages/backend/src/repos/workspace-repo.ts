import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import {
  agentHomeWorkspaceId,
  type AgentDto,
  type AgentRow,
  type UserRow,
  type WorkspaceDto,
  type WorkspaceKind,
  type WorkspaceMemberDto,
  type WorkspaceMemberRow,
  type WorkspaceRow,
  type WorkspaceUserMemberDto,
  type WorkspaceUserMemberRow,
} from '@silverhand/shared';
import { agentRowToDto } from './agent-repo.js';
import { RuntimeHostPlacementError } from '../host-placement-errors.js';

// Re-exported from the shared single source (`agent-home-workspace.ts`)
// so existing backend importers (`./repos/workspace-repo.js`) keep
// working while the convention has one definition shared with the daemon.
export { agentHomeWorkspaceId } from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

type WorkspaceSelectRow = WorkspaceRow & {
  dm_channel_id: string | null;
  dm_channel_ids_json: string | null;
};

function rowToDto(
  row: WorkspaceSelectRow & { sort_group?: number; sort_name?: string },
): WorkspaceDto {
  const {
    dm_channel_ids_json: _dmChannelIdsJson,
    sort_group: _sortGroup,
    sort_name: _sortName,
    ...workspace
  } = row;
  const dmChannelIds =
    typeof row.dm_channel_ids_json === 'string'
      ? (JSON.parse(row.dm_channel_ids_json) as string[])
      : [];
  return {
    ...workspace,
    owner_agent_id: row.owner_agent_id ?? null,
    dm_channel_id: row.dm_channel_id ?? null,
    dm_channel_ids: dmChannelIds,
  };
}

const WORKSPACE_SELECT = `
  SELECT
    w.*,
    CASE WHEN w.workspace_kind = 'agent_home' THEN (
      SELECT c.id
        FROM conversations c
        LEFT JOIN agents owner ON owner.id = w.owner_agent_id
       WHERE c.workspace_id = w.id
         AND c.kind = 'dm_channel'
       ORDER BY CASE
                  WHEN c.title = 'Onboarding' THEN 0
                  WHEN owner.id IS NOT NULL AND c.title = 'dm-' || owner.name THEN 1
                  ELSE 2
                END,
                c.created_at ASC
       LIMIT 1
    ) ELSE NULL END AS dm_channel_id,
    CASE WHEN w.workspace_kind = 'agent_home' THEN (
      SELECT COALESCE(json_group_array(id), '[]')
        FROM (
          SELECT c.id
            FROM conversations c
            LEFT JOIN agents owner ON owner.id = w.owner_agent_id
           WHERE c.workspace_id = w.id
             AND c.kind = 'dm_channel'
           ORDER BY CASE
                      WHEN c.title = 'Onboarding' THEN 0
                      WHEN owner.id IS NOT NULL AND c.title = 'dm-' || owner.name THEN 1
                      ELSE 2
                    END,
                    c.created_at ASC
        )
    ) ELSE '[]' END AS dm_channel_ids_json
  FROM workspaces w
`;

export interface WorkspaceRepoOptions {
  workspacesRoot: string;
}

export class WorkspaceRepo {
  constructor(
    private readonly db: Db,
    private readonly opts: WorkspaceRepoOptions,
  ) {}

  list(_opts: { includeSystem?: boolean } = {}): WorkspaceDto[] {
    const rows = this.db
      .prepare<[], WorkspaceSelectRow>(
        `${WORKSPACE_SELECT}
         WHERE w.workspace_kind IN ('regular', 'agent_home')
         ORDER BY CASE w.workspace_kind WHEN 'regular' THEN 0 ELSE 1 END,
                  (w.pinned_at IS NOT NULL) DESC,
                  w.pinned_at DESC,
                  w.updated_at DESC`,
      )
      .all();
    return rows.map(rowToDto);
  }

  get(id: string): WorkspaceDto | null {
    const row = this.db
      .prepare<[string], WorkspaceSelectRow>(
        `${WORKSPACE_SELECT}
         WHERE w.id = ?`,
      )
      .get(id);
    return row ? rowToDto(row) : null;
  }

  getByName(name: string): WorkspaceDto | null {
    const row = this.db
      .prepare<[string], WorkspaceSelectRow>(
        `${WORKSPACE_SELECT}
         WHERE w.name = ?
           AND w.workspace_kind = 'regular'`,
      )
      .get(name);
    return row ? rowToDto(row) : null;
  }

  /** Match by `workspaces.name` across ALL kinds (regular + agent_home).
   *  Returns every row; callers must handle ambiguity. Used by the
   *  agent-facing task ops to resolve `--workspace <name>` without
   *  assuming uniqueness: only `regular` workspaces have a partial
   *  unique index, agent_home names mirror the agent's name and may
   *  collide across the two kinds. */
  findAllByName(name: string): WorkspaceDto[] {
    return this.db
      .prepare<[string], WorkspaceSelectRow>(
        `${WORKSPACE_SELECT}
         WHERE w.name = ?
           AND w.workspace_kind IN ('regular', 'agent_home')
         ORDER BY CASE w.workspace_kind WHEN 'regular' THEN 0 ELSE 1 END,
                  w.created_at ASC`,
      )
      .all(name)
      .map(rowToDto);
  }

  listForAgent(agentId: string): WorkspaceDto[] {
    return this.db
      .prepare<[string, string], WorkspaceSelectRow & { sort_group: number; sort_name: string }>(
        `SELECT *
           FROM (
             SELECT
               w.*,
               NULL AS dm_channel_id,
               '[]' AS dm_channel_ids_json,
               0 AS sort_group,
               w.name AS sort_name
              FROM workspaces w
              JOIN workspace_members wm ON wm.workspace_id = w.id
             WHERE wm.agent_id = ?
               AND w.workspace_kind = 'regular'
             UNION ALL
             SELECT
               w.*,
               (
                 SELECT c.id
                   FROM conversations c
                   LEFT JOIN agents owner ON owner.id = w.owner_agent_id
                  WHERE c.workspace_id = w.id
                    AND c.kind = 'dm_channel'
                  ORDER BY CASE
                             WHEN c.title = 'Onboarding' THEN 0
                             WHEN owner.id IS NOT NULL AND c.title = 'dm-' || owner.name THEN 1
                             ELSE 2
                           END,
                           c.created_at ASC
                  LIMIT 1
               ) AS dm_channel_id,
               (
                 SELECT COALESCE(json_group_array(id), '[]')
                   FROM (
                     SELECT c.id
                       FROM conversations c
                       LEFT JOIN agents owner ON owner.id = w.owner_agent_id
                      WHERE c.workspace_id = w.id
                        AND c.kind = 'dm_channel'
                      ORDER BY CASE
                                 WHEN c.title = 'Onboarding' THEN 0
                                 WHEN owner.id IS NOT NULL AND c.title = 'dm-' || owner.name THEN 1
                                 ELSE 2
                               END,
                               c.created_at ASC
                   )
               ) AS dm_channel_ids_json,
               1 AS sort_group,
               w.name AS sort_name
              FROM workspaces w
             WHERE w.owner_agent_id = ?
               AND w.workspace_kind = 'agent_home'
           )
          ORDER BY sort_group ASC,
                   (pinned_at IS NOT NULL) DESC,
                   pinned_at DESC,
                   sort_name COLLATE NOCASE ASC`,
      )
      .all(agentId, agentId)
      .map(rowToDto);
  }

  insert(params: {
    id?: string;
    name: string;
    description: string | null;
    workspaceKind?: WorkspaceKind;
    workspacePath: string;
    workspaceHostId: string;
  }): WorkspaceDto {
    if (params.workspaceKind && params.workspaceKind !== 'regular') {
      throw new Error('use insertAgentHome for agent_home workspaces');
    }
    if (isUnderAgentHomeRoot(params.workspacePath, this.opts.workspacesRoot)) {
      throw new Error('regular workspace_path cannot be under agent home root');
    }
    // D4.e-1 3b: callers that must dispatch `workspace_provision` BEFORE the
    // row exists (the registry keys by workspace_id) pre-generate the id via
    // `newWorkspaceId()` and pass it here so the provision and the row agree.
    const id = params.id ?? newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspaces
         (id, name, description, workspace_kind, workspace_path, workspace_host_id,
          owner_agent_id, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, 'regular', ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        params.name,
        params.description,
        params.workspacePath,
        params.workspaceHostId,
        now,
        now,
      );
    const row = this.get(id);
    if (!row) throw new Error('workspace insert failed');
    return row;
  }

  insertAgentHome(params: {
    agent: Pick<AgentDto, 'id' | 'name' | 'host_id'>;
    workspacePath: string;
  }): WorkspaceDto {
    const id = agentHomeWorkspaceId(params.agent.id);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspaces
         (id, name, description, workspace_kind, workspace_path, workspace_host_id,
          owner_agent_id, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, 'agent_home', ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        params.agent.name,
        `Personal home workspace for ${params.agent.name}`,
        params.workspacePath,
        params.agent.host_id,
        params.agent.id,
        now,
        now,
      );
    const row = this.get(id);
    if (!row) throw new Error('agent_home workspace insert failed');
    return row;
  }

  findAgentHome(agentId: string): WorkspaceDto | null {
    return this.getAgentHomeByOwner(agentId);
  }

  getAgentHomeByOwner(agentId: string): WorkspaceDto | null {
    const row = this.db
      .prepare<[string], WorkspaceSelectRow>(
        `${WORKSPACE_SELECT}
         WHERE w.owner_agent_id = ?
           AND w.workspace_kind = 'agent_home'`,
      )
      .get(agentId);
    return row ? rowToDto(row) : null;
  }

  updateMutableMetadata(
    id: string,
    fields: { name?: string; description?: string | null },
  ): WorkspaceDto | null {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (fields.name !== undefined) {
      sets.push('name = ?');
      values.push(fields.name);
    }
    if (fields.description !== undefined) {
      sets.push('description = ?');
      values.push(fields.description);
    }
    if (sets.length === 0) return this.get(id);
    sets.push('updated_at = ?');
    values.push(Date.now(), id);
    this.db
      .prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);
    return this.get(id);
  }

  /**
   * D4.e-1 3b: pre-generate a workspace id so the caller can dispatch
   * `workspace_provision` (which binds the daemon registry by workspace_id)
   * BEFORE inserting the row, and only insert on a successful provision ack.
   */
  newWorkspaceId(): string {
    return newId();
  }

  /**
   * D4.e-1 3b: refresh the legacy `workspace_path` cache column from the
   * daemon's `bound_workspace_path` ack. The column is a TRANSITIONAL cache
   * of the daemon-authoritative path (registry is the real authority); this
   * is the ONLY writer for the regular-workspace path after create/backfill.
   */
  updateWorkspacePathCache(id: string, boundWorkspacePath: string): WorkspaceDto | null {
    this.db
      .prepare(
        `UPDATE workspaces
         SET workspace_path = ?, updated_at = ?
         WHERE id = ? AND workspace_kind = 'regular'`,
      )
      .run(boundWorkspacePath, Date.now(), id);
    return this.get(id);
  }

  setArchived(id: string, archived: boolean): WorkspaceDto | null {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE workspaces
         SET archived_at = ?, updated_at = ?
         WHERE id = ? AND workspace_kind = 'regular'`,
      )
      .run(archived ? now : null, now, id);
    return this.get(id);
  }

  setPinned(id: string, pinned: boolean): WorkspaceDto | null {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE workspaces
         SET pinned_at = ?, updated_at = ?
         WHERE id = ? AND workspace_kind = 'regular'`,
      )
      .run(pinned ? now : null, now, id);
    return this.get(id);
  }

  delete(id: string): void {
    this.db
      .prepare(`DELETE FROM workspaces WHERE id = ? AND workspace_kind = 'regular'`)
      .run(id);
  }

  assertAgentHostMatchesWorkspaceHost(agentId: string, workspaceHostId: string): void {
    const agent = this.db
      .prepare<[string], Pick<AgentRow, 'id' | 'host_id'>>(
        `SELECT id, host_id FROM agents WHERE id = ?`,
      )
      .get(agentId);
    if (!agent) {
      throw new RuntimeHostPlacementError(
        'agent_missing',
        `agent ${agentId} not found`,
      );
    }
    if (agent.host_id !== workspaceHostId) {
      throw new RuntimeHostPlacementError(
        'host_mismatch',
        `agent ${agentId} host ${agent.host_id} does not match workspace host ${workspaceHostId}`,
      );
    }
  }

  assertHostEqualityForMembership(agentId: string, workspaceId: string): void {
    const workspace = this.get(workspaceId);
    if (!workspace) {
      throw new RuntimeHostPlacementError(
        'workspace_missing',
        `workspace ${workspaceId} not found`,
      );
    }
    this.assertAgentHostMatchesWorkspaceHost(agentId, workspace.workspace_host_id);
  }

  addMember(workspaceId: string, agentId: string): WorkspaceMemberDto {
    this.assertHostEqualityForMembership(agentId, workspaceId);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_members
         (workspace_id, agent_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(workspaceId, agentId, now);
    const row = this.db
      .prepare<[string, string], WorkspaceMemberRow>(
        `SELECT * FROM workspace_members
         WHERE workspace_id = ? AND agent_id = ?`,
      )
      .get(workspaceId, agentId);
    if (!row) throw new Error('workspace member insert failed');
    return { ...row };
  }

  listMemberAgents(workspaceId: string): string[] {
    return this.db
      .prepare<[string], { agent_id: string }>(
        `SELECT agent_id FROM workspace_members
         WHERE workspace_id = ?
         ORDER BY joined_at ASC`,
      )
      .all(workspaceId)
      .map(r => r.agent_id);
  }

  listMembers(workspaceId: string): AgentDto[] {
    return this.db
      .prepare<[string], AgentRow>(
        `SELECT a.*
           FROM agents a
           JOIN workspace_members wm ON wm.agent_id = a.id
          WHERE wm.workspace_id = ?
          ORDER BY wm.joined_at ASC`,
      )
      .all(workspaceId)
      .map(agentRowToDto);
  }

  isMember(workspaceId: string, agentId: string): boolean {
    const row = this.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c
           FROM workspace_members
          WHERE workspace_id = ? AND agent_id = ?`,
      )
      .get(workspaceId, agentId);
    return (row?.c ?? 0) > 0;
  }

  removeMember(workspaceId: string, agentId: string): void {
    this.db
      .prepare(
        `DELETE FROM workspace_members
          WHERE workspace_id = ? AND agent_id = ?`,
      )
      .run(workspaceId, agentId);
  }

  // ── Human (user) membership — `workspace_users` (v25) ───────────
  // Mirrors the agent membership API above but for users. Unlike
  // `workspace_members`, `workspace_users` accepts ALL workspace
  // kinds (regular / agent_home / dm) — humans have no
  // owner_agent_id equivalent that grants implicit access.

  addUserMember(
    workspaceId: string,
    userId: string,
  ): WorkspaceUserMemberDto {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_users
         (workspace_id, user_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(workspaceId, userId, now);
    const row = this.db
      .prepare<[string, string], WorkspaceUserMemberRow>(
        `SELECT * FROM workspace_users
         WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(workspaceId, userId);
    if (!row) throw new Error('workspace_users insert failed');
    return { ...row };
  }

  listUserMemberIds(workspaceId: string): string[] {
    return this.db
      .prepare<[string], { user_id: string }>(
        `SELECT user_id FROM workspace_users
         WHERE workspace_id = ?
         ORDER BY joined_at ASC`,
      )
      .all(workspaceId)
      .map(r => r.user_id);
  }

  listUserMembers(workspaceId: string): UserRow[] {
    return this.db
      .prepare<[string], UserRow>(
        `SELECT u.*
           FROM users u
           JOIN workspace_users wu ON wu.user_id = u.id
          WHERE wu.workspace_id = ?
          ORDER BY wu.joined_at ASC`,
      )
      .all(workspaceId)
      .map(r => ({ ...r }));
  }

  isUserMember(workspaceId: string, userId: string): boolean {
    const row = this.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c
           FROM workspace_users
          WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(workspaceId, userId);
    return (row?.c ?? 0) > 0;
  }

  removeUserMember(workspaceId: string, userId: string): void {
    this.db
      .prepare(
        `DELETE FROM workspace_users
          WHERE workspace_id = ? AND user_id = ?`,
      )
      .run(workspaceId, userId);
  }

  workspacePathFor(name: string): string {
    return join(this.opts.workspacesRoot, name);
  }
}

function isUnderAgentHomeRoot(workspacePath: string, workspacesRoot: string): boolean {
  const silverhandDir = dirname(resolve(workspacesRoot));
  const agentHomeRoot = resolve(silverhandDir, 'agents');
  const target = resolve(workspacePath);
  const rel = relative(agentHomeRoot, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/'));
}
