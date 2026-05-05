import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
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

function rowToDto(row: WorkspaceRow): WorkspaceDto {
  return { ...row };
}

export const SYSTEM_DM_WORKSPACE_ID = '__system_dm_workspace__';

export interface WorkspaceRepoOptions {
  workspacesRoot: string;
}

export class WorkspaceRepo {
  constructor(
    private readonly db: Db,
    private readonly opts: WorkspaceRepoOptions,
  ) {}

  list(opts: { includeSystem?: boolean } = {}): WorkspaceDto[] {
    const rows = opts.includeSystem
      ? this.db
          .prepare<[], WorkspaceRow>(
            `SELECT * FROM workspaces ORDER BY updated_at DESC`,
          )
          .all()
      : this.db
          .prepare<[], WorkspaceRow>(
            `SELECT * FROM workspaces
             WHERE workspace_kind = 'regular'
             ORDER BY updated_at DESC`,
          )
          .all();
    return rows.map(rowToDto);
  }

  get(id: string): WorkspaceDto | null {
    const row = this.db
      .prepare<[string], WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?')
      .get(id);
    return row ? rowToDto(row) : null;
  }

  getByName(name: string): WorkspaceDto | null {
    const row = this.db
      .prepare<[string], WorkspaceRow>('SELECT * FROM workspaces WHERE name = ?')
      .get(name);
    return row ? rowToDto(row) : null;
  }

  listForAgent(agentId: string): WorkspaceDto[] {
    return this.db
      .prepare<[string], WorkspaceRow>(
        `SELECT w.*
           FROM workspaces w
           JOIN workspace_members wm ON wm.workspace_id = w.id
          WHERE wm.agent_id = ?
            AND w.workspace_kind = 'regular'
          ORDER BY wm.joined_at ASC`,
      )
      .all(agentId)
      .map(rowToDto);
  }

  insert(params: {
    name: string;
    description: string | null;
    workspaceKind?: WorkspaceKind;
    workspacePath: string;
    workspaceHostId: string;
  }): WorkspaceDto {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspaces
         (id, name, description, workspace_kind, workspace_path, workspace_host_id,
          archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        params.name,
        params.description,
        params.workspaceKind ?? 'regular',
        params.workspacePath,
        params.workspaceHostId,
        now,
        now,
      );
    const row = this.get(id);
    if (!row) throw new Error('workspace insert failed');
    return row;
  }

  ensureSystemDmWorkspace(params: {
    workspacePath: string;
    workspaceHostId: string;
  }): WorkspaceDto {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workspaces
         (id, name, description, workspace_kind, workspace_path, workspace_host_id,
          archived_at, created_at, updated_at)
         VALUES (?, 'Direct Messages', 'Hidden workspace for direct message conversations',
                 'system_dm', ?, ?, NULL, ?, ?)`,
      )
      .run(
        SYSTEM_DM_WORKSPACE_ID,
        params.workspacePath,
        params.workspaceHostId,
        now,
        now,
      );
    const row = this.get(SYSTEM_DM_WORKSPACE_ID);
    if (!row) throw new Error('system DM workspace insert failed');
    return row;
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
