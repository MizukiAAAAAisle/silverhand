import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
  agentHomeWorkspaceId,
  normalizeWorkspaceName,
  type AgentDto,
  type AgentRow,
  type UserRow,
  type WorkspaceDto,
  type WorkspaceKind,
  type WorkspaceMemberDto,
  type WorkspaceMemberRow,
  type WorkspaceRole,
  type WorkspaceRow,
  type WorkspaceUserMemberDto,
  type WorkspaceUserMemberRow,
} from '@silverhand/shared';
import { agentRowToDto } from './agent-repo.js';

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
    // `pinned_at` is a vestigial column (#task:1209): pin/star became per-viewer
    // sort state (user_sort_entry.starred_at), and a workspace lost even that
    // when the container star was retired (#task:1899). The shared column is no
    // longer read/written and must never reach the wire. Strip it here.
    pinned_at: _pinnedAt,
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

export class WorkspaceRepo {
  constructor(private readonly db: Db) {}

  list(_opts: { includeSystem?: boolean } = {}): WorkspaceDto[] {
    const rows = this.db
      .prepare<[], WorkspaceSelectRow>(
        `${WORKSPACE_SELECT}
         WHERE w.workspace_kind IN ('regular', 'agent_home')
         ORDER BY CASE w.workspace_kind WHEN 'regular' THEN 0 ELSE 1 END,
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

  /** Name equality is defined in NFC, not by raw bytes: `WorkspaceNameSchema`
   *  normalizes on every write, so a lookup argument must be normalized too or
   *  a canonically-equivalent spelling (a pasted NFD name, common on macOS)
   *  would silently miss a row that displays identically. */
  getByName(name: string): WorkspaceDto | null {
    const row = this.db
      .prepare<[string], WorkspaceSelectRow>(
        `${WORKSPACE_SELECT}
         WHERE w.name = ?
           AND w.workspace_kind = 'regular'`,
      )
      .get(normalizeWorkspaceName(name));
    return row ? rowToDto(row) : null;
  }

  /** Match by `workspaces.name` across ALL kinds (regular + agent_home).
   *  Returns every row; callers must handle ambiguity. Used by the
   *  agent-facing task ops to resolve `--workspace <name>` without
   *  assuming uniqueness: only `regular` workspaces have a partial
   *  unique index, agent_home names mirror the agent's name and may
   *  collide across the two kinds. Compares in NFC — see `getByName`. */
  findAllByName(name: string): WorkspaceDto[] {
    return this.db
      .prepare<[string], WorkspaceSelectRow>(
        `${WORKSPACE_SELECT}
         WHERE w.name = ?
           AND w.workspace_kind IN ('regular', 'agent_home')
         ORDER BY CASE w.workspace_kind WHEN 'regular' THEN 0 ELSE 1 END,
                  w.created_at ASC`,
      )
      .all(normalizeWorkspaceName(name))
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
  }): WorkspaceDto {
    if (params.workspaceKind && params.workspaceKind !== 'regular') {
      throw new Error('use insertAgentHome for agent_home workspaces');
    }
    // `name` is NFC-normalized at this write boundary (see
    // {@link updateMutableMetadata}) — "every stored name is NFC" must not rest
    // on the caller having parsed through `WorkspaceNameSchema`.
    // relocation-v1 §7 — a regular workspace no longer carries a host binding
    // or a working directory. Its bundle resolves daemon-side to a terminal
    // deterministic agent-centric coordinate at first spawn; the row is a pure
    // DB write with no provisioning step preceding it.
    const id = params.id ?? newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspaces
         (id, name, description, workspace_kind,
          owner_agent_id, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, 'regular', NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        normalizeWorkspaceName(params.name),
        params.description,
        now,
        now,
      );
    const row = this.get(id);
    if (!row) throw new Error('workspace insert failed');
    return row;
  }

  insertAgentHome(params: {
    agent: Pick<AgentDto, 'id' | 'name'>;
  }): WorkspaceDto {
    const id = agentHomeWorkspaceId(params.agent.id);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspaces
         (id, name, description, workspace_kind,
          owner_agent_id, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, 'agent_home', ?, NULL, ?, ?)`,
      )
      .run(
        id,
        params.agent.name,
        `Personal home workspace for ${params.agent.name}`,
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

  /**
   * Mutable-metadata update. `name` is normalized on the way in for the same
   * reason {@link insert} does it: the name is a SELECTOR (`getByName` looks up
   * `normalizeWorkspaceName(name)`), so a row stored in a non-NFC spelling is
   * permanently unaddressable by the name the user reads off the screen. The
   * fence lives here, at the write boundary, rather than resting on every
   * caller having gone through `WorkspaceNameSchema` — the CLI selector path
   * never does. Normalize, do not reject: NFC is an equivalence over spellings
   * of the same characters, so it costs no name and FORMAT validation stays the
   * schema's job (no full re-parse here, and no DB CHECK).
   */
  updateMutableMetadata(
    id: string,
    fields: { name?: string; description?: string | null },
  ): WorkspaceDto | null {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (fields.name !== undefined) {
      sets.push('name = ?');
      values.push(normalizeWorkspaceName(fields.name));
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

  /**
   * Insert a workspace membership row — PURE persistence (use-case-layer
   * spec §4). Returns the row plus a `created` flag (true only when this call
   * actually inserted; false when the member already existed). The caller owns
   * the transaction and the cross-context policy:
   *
   *  - host/placement is asserted by the use case as a pre-commit precondition
   *    (NOT here) — `insertMembership` no longer performs placement checks.
   *    (The host-equality helpers still live on this repo for the placement
   *    resolver to delegate to; they are simply not called from this path.)
   *  - capability default-seeding is the use case's decision (`if (created)`),
   *    run in the SAME caller transaction — `insertMembership` no longer
   *    performs capability seeding.
   *
   * `created` is what preserves cut2's no-silent-re-widen rule: re-adding an
   * existing member is a no-op here, so the caller skips re-seeding a
   * previously narrowed capability set.
   */
  insertMembership(
    workspaceId: string,
    agentId: string,
  ): { member: WorkspaceMemberDto; created: boolean } {
    const now = Date.now();
    const info = this.db
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
    return { member: { ...row }, created: info.changes > 0 };
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
    role: WorkspaceRole = 'member',
  ): WorkspaceUserMemberDto {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_users
         (workspace_id, user_id, joined_at, role)
         VALUES (?, ?, ?, ?)`,
      )
      .run(workspaceId, userId, now, role);
    const row = this.db
      .prepare<[string, string], WorkspaceUserMemberRow>(
        `SELECT * FROM workspace_users
         WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(workspaceId, userId);
    if (!row) throw new Error('workspace_users insert failed');
    return { ...row };
  }

  /**
   * Assign the human governance owner of a workspace (graded-permissions
   * Layer A). Stamps the denormalized `workspaces.owner_user_id` pointer
   * AND promotes the user's `workspace_users` row to `role = 'owner'` in
   * one transaction, so the column and the authoritative role column can
   * never disagree. The user must already be a member (call
   * `addUserMember` first). Ownership transfer is out of scope this round
   * (amendment 1): this is only ever called once, at workspace creation,
   * on a workspace that has no other owner yet — it does not demote a
   * prior owner.
   */
  setOwnerUserId(workspaceId: string, userId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE workspaces SET owner_user_id = ? WHERE id = ?`)
        .run(userId, workspaceId);
      this.db
        .prepare(
          `UPDATE workspace_users SET role = 'owner'
            WHERE workspace_id = ? AND user_id = ?`,
        )
        .run(workspaceId, userId);
    })();
  }

  /**
   * The governance role of a human in a workspace, or `null` if the user
   * is not a member. Authoritative source for `canGovernWorkspace`
   * (graded-permissions Layer A).
   */
  getUserRole(workspaceId: string, userId: string): WorkspaceRole | null {
    const row = this.db
      .prepare<[string, string], { role: WorkspaceRole }>(
        `SELECT role FROM workspace_users
          WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(workspaceId, userId);
    return row?.role ?? null;
  }

  setUserRole(
    workspaceId: string,
    userId: string,
    role: Exclude<WorkspaceRole, 'owner'>,
  ): WorkspaceUserMemberDto | null {
    const row = this.db
      .prepare<[WorkspaceRole, string, string], WorkspaceUserMemberRow>(
        `UPDATE workspace_users
            SET role = ?
          WHERE workspace_id = ?
            AND user_id = ?
            AND role != 'owner'
          RETURNING *`,
      )
      .get(role, workspaceId, userId);
    if (!row) return null;
    return {
      workspace_id: row.workspace_id,
      user_id: row.user_id,
      joined_at: row.joined_at,
      role: row.role,
    };
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

  listUserMemberships(workspaceId: string): WorkspaceUserMemberDto[] {
    return this.db
      .prepare<[string], WorkspaceUserMemberRow>(
        `SELECT * FROM workspace_users
         WHERE workspace_id = ?
         ORDER BY joined_at ASC`,
      )
      .all(workspaceId)
      .map(r => ({
        workspace_id: r.workspace_id,
        user_id: r.user_id,
        joined_at: r.joined_at,
        role: r.role,
      }));
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

}
