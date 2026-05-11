import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import type {
  AgentDto,
  AgentRow,
  WorkspaceDto,
  WorkspaceKind,
  WorkspaceMemberDto,
  WorkspaceMemberRow,
  WorkspaceRow,
} from '@silverhand/shared';

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
                  w.pinned_at ASC,
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
          ORDER BY sort_group ASC, sort_name COLLATE NOCASE ASC`,
      )
      .all(agentId, agentId)
      .map(rowToDto);
  }

  insert(params: {
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
    const id = newId();
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

  addMember(workspaceId: string, agentId: string): WorkspaceMemberDto {
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
      .map(r => ({ ...r }));
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

  workspacePathFor(name: string): string {
    return join(this.opts.workspacesRoot, name);
  }
}

export function agentHomeWorkspaceId(agentId: string): string {
  return `wsah_${agentId}`;
}

function isUnderAgentHomeRoot(workspacePath: string, workspacesRoot: string): boolean {
  const silverhandDir = dirname(resolve(workspacesRoot));
  const agentHomeRoot = resolve(silverhandDir, 'agents');
  const target = resolve(workspacePath);
  const rel = relative(agentHomeRoot, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/'));
}
