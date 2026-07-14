import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
  ChannelConversationDto,
  ConversationAgentDto,
  ConversationAgentRow,
  ConversationDto,
  ConversationKind,
  ConversationRow,
  ConversationUserMemberDto,
  ConversationUserMemberRow,
  ConversationVisibility,
  DmChannelDto,
  UserRow,
  WorkspaceChannelListItem,
} from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

// `pinned_at` is a vestigial column (#task:1209): pin/star became per-viewer
// state in `user_sort_entry`, so the shared column is no longer read or written
// and must never reach the wire. These mappers strip it from the row before it
// becomes a DTO — the type drops it too, but stripping kills the runtime leak.
function rowToDto(row: ConversationRow): ConversationDto {
  const { pinned_at: _pinnedAt, ...dto } = row;
  return { ...dto };
}

function assertChannelLike(row: ConversationRow): ChannelConversationDto | DmChannelDto {
  if (row.kind === 'dm_channel') return rowToDmChannel(row);
  return rowToChannel(row);
}

function rowToChannel(row: ConversationRow): ChannelConversationDto {
  if (row.kind !== 'channel') {
    throw new Error('conversation is not a channel');
  }
  const { pinned_at: _pinnedAt, ...rest } = row;
  return { ...rest, kind: 'channel' };
}

function rowToDmChannel(row: ConversationRow): DmChannelDto {
  if (row.kind !== 'dm_channel') {
    throw new Error('conversation is not a dm_channel');
  }
  const { pinned_at: _pinnedAt, ...rest } = row;
  return { ...rest, kind: 'dm_channel' };
}

export class ConversationRepo {
  constructor(private readonly db: Db) {}

  list(): ConversationDto[] {
    const rows = this.db
      .prepare<[], ConversationRow>(
        'SELECT * FROM conversations ORDER BY updated_at DESC',
      )
      .all();
    return rows.map(rowToDto);
  }

  get(id: string): ConversationDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>('SELECT * FROM conversations WHERE id = ?')
      .get(id);
    return row ? rowToDto(row) : null;
  }

  getChannel(id: string): ChannelConversationDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE id = ? AND kind = 'channel'`,
      )
      .get(id);
    return row ? rowToChannel(row) : null;
  }

  getDmChannel(id: string): DmChannelDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE id = ? AND kind = 'dm_channel'`,
      )
      .get(id);
    return row ? rowToDmChannel(row) : null;
  }

  getChannelLike(id: string): ChannelConversationDto | DmChannelDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE id = ? AND kind IN ('channel', 'dm_channel')`,
      )
      .get(id);
    return row ? assertChannelLike(row) : null;
  }

  /** All active (non-archived) regular channels for a workspace — IDENTITY
   *  only, no viewer. Returns every active channel regardless of visibility or
   *  membership, so it is NOT a sidebar/discovery query: use it for
   *  workspace-wide existence/fan-out needs where there is no viewer to project
   *  membership against. The per-viewer sidebar list is
   *  `listActiveChannelsForViewer`. */
  listActiveChannelsForWorkspace(workspaceId: string): ChannelConversationDto[] {
    const rows = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE workspace_id = ? AND kind = 'channel' AND archived_at IS NULL
         ORDER BY created_at ASC`,
      )
      .all(workspaceId);
    return rows.map(rowToChannel);
  }

  /** Active (non-archived) regular channels for a workspace, as a per-viewer
   *  DISCOVERY UNION (`WorkspaceChannelListItem`, `kind='channel'`). Each item
   *  carries a route-computed `is_member` — the viewer-scoped bit the
   *  channel-detail envelope exposes; identity DTOs stay pure.
   *
   *  The result is the union of (a) channels the viewer has joined — any
   *  visibility, `is_member: true` — and (b) active PUBLIC channels the viewer
   *  has NOT joined — `is_member: false`, the browse-and-Join discovery surface.
   *  Private channels the viewer is not a member of are excluded. This is the
   *  authoritative channel set for BOTH the sidebar list and sort-group
   *  validation, so a public channel a viewer can see is a reorderable member of
   *  their sidebar.
   *
   *  `viewerUserId` is REQUIRED: membership is a per-viewer fact, so there is no
   *  viewer-less form of this projection (a caller needing all-active identity
   *  uses `listActiveChannelsForWorkspace`). */
  listActiveChannelsForViewer(
    workspaceId: string,
    viewerUserId: string,
  ): WorkspaceChannelListItem[] {
    const rows = this.db
      .prepare<[string, string, string], ConversationRow & { is_member: number }>(
        `SELECT conversations.*,
                EXISTS (
                  SELECT 1 FROM conversation_users cu
                   WHERE cu.conversation_id = conversations.id AND cu.user_id = ?
                ) AS is_member
           FROM conversations
          WHERE workspace_id = ? AND kind = 'channel' AND archived_at IS NULL
            AND (
              visibility = 'public'
              OR EXISTS (
                SELECT 1 FROM conversation_users cu2
                 WHERE cu2.conversation_id = conversations.id AND cu2.user_id = ?
              )
            )
          ORDER BY created_at ASC`,
      )
      .all(viewerUserId, workspaceId, viewerUserId);
    return rows.map(row => {
      const { is_member, ...conversation } = row;
      return { ...rowToChannel(conversation), is_member: is_member === 1 };
    });
  }

  listArchivedChannelsForWorkspace(
    workspaceId: string,
    opts: { forUserId?: string } = {},
  ): ChannelConversationDto[] {
    const args: Array<string> = [workspaceId];
    let userJoin = '';
    if (opts.forUserId !== undefined) {
      userJoin = `AND EXISTS (
        SELECT 1 FROM conversation_users cu
         WHERE cu.conversation_id = conversations.id AND cu.user_id = ?
      )`;
      args.push(opts.forUserId);
    }
    const rows = this.db
      .prepare<typeof args, ConversationRow>(
        `SELECT * FROM conversations
         WHERE workspace_id = ? AND kind = 'channel' AND archived_at IS NOT NULL
           ${userJoin}
         ORDER BY archived_at DESC, created_at ASC`,
      )
      .all(...args);
    return rows.map(rowToChannel);
  }

  /** All `kind='channel'` conversations for a workspace regardless of
   *  archive state. Used when callers need to fan out (e.g. workspace
   *  rename announce) and shouldn't silently skip archived channels. */
  listAllChannelsForWorkspace(workspaceId: string): ChannelConversationDto[] {
    const rows = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE workspace_id = ? AND kind = 'channel'
         ORDER BY created_at ASC`,
      )
      .all(workspaceId);
    return rows.map(rowToChannel);
  }

  /** Flat archived-channel list across all workspaces, with the parent
   *  workspace's name. Drives the global Archived chat-tool page. Sorted
   *  by `archived_at DESC, created_at ASC`. Filters: optional workspace
   *  narrowing and `since` (inclusive lower bound on archived_at, epoch ms). */
  listArchivedChannelsAggregate(opts: {
    workspaceId?: string;
    since?: number;
    forUserId?: string;
  } = {}): ArchivedAggregateRow[] {
    const where: string[] = [
      `c.kind IN ('channel', 'dm_channel')`,
      `c.archived_at IS NOT NULL`,
    ];
    const args: Array<string | number> = [];
    if (opts.workspaceId !== undefined) {
      where.push('c.workspace_id = ?');
      args.push(opts.workspaceId);
    }
    if (opts.since !== undefined) {
      where.push('c.archived_at >= ?');
      args.push(opts.since);
    }
    if (opts.forUserId !== undefined) {
      where.push(
        `EXISTS (
           SELECT 1 FROM conversation_users cu
            WHERE cu.conversation_id = c.id AND cu.user_id = ?
         )`,
      );
      args.push(opts.forUserId);
    }
    const rows = this.db
      .prepare<typeof args, ConversationRow & {
        workspace_name: string;
        workspace_archived_at: number | null;
      }>(
        `SELECT
           c.*,
           w.name AS workspace_name,
           w.archived_at AS workspace_archived_at
         FROM conversations c
         JOIN workspaces w ON w.id = c.workspace_id
         WHERE ${where.join(' AND ')}
         ORDER BY c.archived_at DESC, c.created_at ASC`,
      )
      .all(...args);
    return rows.map(r => {
      const {
        workspace_name,
        workspace_archived_at,
        ...conversation
      } = r;
      return {
        channel: assertChannelLike(conversation),
        workspace: {
          id: conversation.workspace_id,
          name: workspace_name,
          archived_at: workspace_archived_at,
        },
      };
    });
  }

  listDmChannels(): DmChannelDto[] {
    const rows = this.db
      .prepare<[], ConversationRow>(
        `SELECT * FROM conversations
         WHERE kind = 'dm_channel'
         ORDER BY created_at ASC`,
      )
      .all();
    return rows.map(rowToDmChannel);
  }

  listDmChannelForWorkspace(workspaceId: string): DmChannelDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT c.*
           FROM conversations c
           JOIN workspaces w ON w.id = c.workspace_id
           LEFT JOIN agents owner ON owner.id = w.owner_agent_id
          WHERE c.workspace_id = ?
            AND c.kind = 'dm_channel'
          ORDER BY CASE
                     WHEN c.title = 'Onboarding' THEN 0
                     WHEN owner.id IS NOT NULL AND c.title = 'dm-' || owner.name THEN 1
                     ELSE 2
                   END,
                   c.created_at ASC
          LIMIT 1`,
      )
      .get(workspaceId);
    return row ? rowToDmChannel(row) : null;
  }

  // DM collection reads, mirroring the regular-channel trichotomy
  // (`listActive` / `listArchived` / `listAll` `ChannelsForWorkspace`).
  // The DM list is its own sidebar collection: archived DMs hide from the
  // active list and surface in the DM-scoped Archived view — they are
  // never merged into the regular channel lists. Active/all keep the
  // Onboarding-first ordering; archived sorts most-recently-archived first
  // (mirrors `listArchivedChannelsForWorkspace`).
  /** Active (non-archived) DM channels for a workspace, as per-viewer list
   *  items (`WorkspaceChannelListItem`, `kind='dm_channel'`). The DM list is
   *  STRICTLY membership-filtered by `viewerUserId`, so every returned item is
   *  one the viewer belongs to → `is_member: true` unconditionally. This keeps
   *  the workspace-channels endpoint's contract uniform: every active item a
   *  user receives carries an authoritative `is_member`, DM included, so the
   *  renderer gate never falls to unknown/detail on a DM. */
  listActiveDmChannelsForViewer(
    workspaceId: string,
    viewerUserId: string,
  ): WorkspaceChannelListItem[] {
    return this.queryDmChannelsForWorkspace(workspaceId, {
      forUserId: viewerUserId,
      archived: false,
    }).map(dm => ({ ...dm, is_member: true }));
  }

  listArchivedDmChannelsForWorkspace(
    workspaceId: string,
    opts: { forUserId?: string } = {},
  ): DmChannelDto[] {
    return this.queryDmChannelsForWorkspace(workspaceId, { ...opts, archived: true });
  }

  /** All DM channels regardless of archive state — used where a caller
   *  must NOT silently skip archived DMs (agent-delete impact + cascade). */
  listAllDmChannelsForWorkspace(
    workspaceId: string,
    opts: { forUserId?: string } = {},
  ): DmChannelDto[] {
    return this.queryDmChannelsForWorkspace(workspaceId, opts);
  }

  private queryDmChannelsForWorkspace(
    workspaceId: string,
    opts: { forUserId?: string; archived?: boolean } = {},
  ): DmChannelDto[] {
    const args: Array<string> = [workspaceId];
    let userJoin = '';
    if (opts.forUserId !== undefined) {
      userJoin = `AND EXISTS (
        SELECT 1 FROM conversation_users cu
         WHERE cu.conversation_id = c.id AND cu.user_id = ?
      )`;
      args.push(opts.forUserId);
    }
    let archivedClause = '';
    if (opts.archived === true) {
      archivedClause = 'AND c.archived_at IS NOT NULL';
    } else if (opts.archived === false) {
      archivedClause = 'AND c.archived_at IS NULL';
    }
    const orderBy =
      opts.archived === true
        ? 'c.archived_at DESC, c.created_at ASC'
        : `CASE
                     WHEN c.title = 'Onboarding' THEN 0
                     WHEN owner.id IS NOT NULL AND c.title = 'dm-' || owner.name THEN 1
                     ELSE 2
                   END,
                   c.created_at ASC`;
    const rows = this.db
      .prepare<typeof args, ConversationRow>(
        `SELECT c.*
           FROM conversations c
           JOIN workspaces w ON w.id = c.workspace_id
           LEFT JOIN agents owner ON owner.id = w.owner_agent_id
          WHERE c.workspace_id = ?
            AND c.kind = 'dm_channel'
            ${userJoin}
            ${archivedClause}
          ORDER BY ${orderBy}`,
      )
      .all(...args);
    return rows.map(rowToDmChannel);
  }

  findDmChannelForAgent(
    agentId: string,
    opts: { title?: string } = {},
  ): DmChannelDto | null {
    const titleClause = opts.title ? 'AND c.title = ?' : '';
    const args = opts.title ? [agentId, opts.title] : [agentId];
    const row = this.db
      .prepare<typeof args, ConversationRow>(
        `SELECT c.*
           FROM conversations c
           JOIN conversation_agents ca ON ca.conversation_id = c.id
          WHERE c.kind = 'dm_channel'
            AND ca.agent_id = ?
            ${titleClause}
          ORDER BY c.created_at ASC
          LIMIT 1`,
      )
      .get(...args);
    return row ? rowToDmChannel(row) : null;
  }

  listDmChannelsForAgent(agentId: string): DmChannelDto[] {
    const rows = this.db
      .prepare<[string], ConversationRow>(
        `SELECT c.*
           FROM conversations c
           JOIN conversation_agents ca ON ca.conversation_id = c.id
          WHERE c.kind = 'dm_channel'
            AND ca.agent_id = ?
          ORDER BY c.created_at ASC`,
      )
      .all(agentId);
    return rows.map(rowToDmChannel);
  }

  insertChannel(params: {
    workspaceId: string;
    workspacePath: string;
    title: string;
    spawnedByAgentId?: string | null;
    /** Channel visibility; defaults to 'private'. */
    visibility?: ConversationVisibility;
  }): ChannelConversationDto {
    const row = this.insert({
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      kind: 'channel',
      title: params.title,
      spawnedByAgentId: params.spawnedByAgentId ?? null,
      visibility: params.visibility ?? 'private',
    });
    return rowToChannel(row);
  }

  insertDmChannel(params: {
    workspaceId: string;
    workspacePath: string;
    title: string;
    agentId?: string | null;
  }): DmChannelDto {
    const row = this.insert({
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      kind: 'dm_channel',
      title: params.title,
      spawnedByAgentId: null,
    });
    return rowToDmChannel(row);
  }

  setArchived(
    id: string,
    archived: boolean,
  ): ChannelConversationDto | DmChannelDto | null {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE conversations
         SET archived_at = ?, updated_at = ?
         WHERE id = ? AND kind IN ('channel', 'dm_channel')`,
      )
      .run(archived ? now : null, now, id);
    if (result.changes === 0) return null;
    const row = this.getRaw(id);
    return row ? assertChannelLike(row) : null;
  }

  /** Rename a channel-like conversation (`channel | dm_channel`). Gated to
   *  those kinds in the WHERE clause so a thread id silently matches
   *  nothing and returns null — the service layer turns that into a typed
   *  `not_renamable` / `not_found` error. */
  updateTitle(
    id: string,
    title: string,
  ): ChannelConversationDto | DmChannelDto | null {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE conversations
         SET title = ?, updated_at = ?
         WHERE id = ? AND kind IN ('channel', 'dm_channel')`,
      )
      .run(title, now, id);
    if (result.changes === 0) return null;
    const row = this.getRaw(id);
    return row ? assertChannelLike(row) : null;
  }

  close(id: string, summary: string): ConversationDto | null {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE conversations
         SET closed_at = ?, close_summary = ?, status = 'archived', updated_at = ?
         WHERE id = ? AND closed_at IS NULL`,
      )
      .run(now, summary, now, id);
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  addAgent(conversationId: string, agentId: string): ConversationAgentDto {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_agents
         (conversation_id, agent_id, cli_session_id, pid, status, joined_at)
         VALUES (?, ?, NULL, NULL, 'idle', ?)`,
      )
      .run(conversationId, agentId, now);
    const row = this.db
      .prepare<[string, string], ConversationAgentRow>(
        `SELECT * FROM conversation_agents
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .get(conversationId, agentId);
    if (!row) throw new Error('conversation_agents insert failed');
    return { ...row };
  }

  listAgents(conversationId: string): ConversationAgentDto[] {
    return this.db
      .prepare<[string], ConversationAgentRow>(
        `SELECT * FROM conversation_agents
         WHERE conversation_id = ?
         ORDER BY joined_at ASC`,
      )
      .all(conversationId)
      .map(r => ({ ...r }));
  }

  removeAgent(conversationId: string, agentId: string): void {
    this.db
      .prepare(
        `DELETE FROM conversation_agents
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .run(conversationId, agentId);
  }

  updateAgentRuntime(
    conversationId: string,
    agentId: string,
    fields: {
      status?: 'starting' | 'active' | 'idle' | 'crashed';
      pid?: number | null;
      cliSessionId?: string | null;
    },
  ): ConversationAgentDto | null {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (fields.status !== undefined) {
      sets.push('status = ?');
      values.push(fields.status);
    }
    if (fields.pid !== undefined) {
      sets.push('pid = ?');
      values.push(fields.pid);
    }
    if (fields.cliSessionId !== undefined) {
      sets.push('cli_session_id = ?');
      values.push(fields.cliSessionId);
    }
    if (sets.length === 0) return this.getAgent(conversationId, agentId);
    values.push(conversationId, agentId);
    this.db
      .prepare(
        `UPDATE conversation_agents SET ${sets.join(', ')}
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .run(...values);
    return this.getAgent(conversationId, agentId);
  }

  getAgent(conversationId: string, agentId: string): ConversationAgentDto | null {
    const row = this.db
      .prepare<[string, string], ConversationAgentRow>(
        `SELECT * FROM conversation_agents
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .get(conversationId, agentId);
    return row ? { ...row } : null;
  }

  // ── Human (user) membership — `conversation_users` (v25) ─────────
  // Mirrors `addAgent` / `listAgents` / `getAgent` etc. for users.
  // Humans don't run as processes, so this table has no
  // cli_session_id / pid / status columns — just (conversation, user,
  // joined_at). v1 has at most one human per DB; the schema is
  // multi-human ready.

  addUser(
    conversationId: string,
    userId: string,
  ): ConversationUserMemberDto {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_users
         (conversation_id, user_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(conversationId, userId, now);
    const row = this.db
      .prepare<[string, string], ConversationUserMemberRow>(
        `SELECT * FROM conversation_users
         WHERE conversation_id = ? AND user_id = ?`,
      )
      .get(conversationId, userId);
    if (!row) throw new Error('conversation_users insert failed');
    return { ...row };
  }

  listUsers(conversationId: string): ConversationUserMemberDto[] {
    return this.db
      .prepare<[string], ConversationUserMemberRow>(
        `SELECT * FROM conversation_users
         WHERE conversation_id = ?
         ORDER BY joined_at ASC`,
      )
      .all(conversationId)
      .map(r => ({ ...r }));
  }

  listUserMembers(conversationId: string): UserRow[] {
    return this.db
      .prepare<[string], UserRow>(
        `SELECT u.*
           FROM users u
           JOIN conversation_users cu ON cu.user_id = u.id
          WHERE cu.conversation_id = ?
          ORDER BY cu.joined_at ASC`,
      )
      .all(conversationId)
      .map(r => ({ ...r }));
  }

  getUser(
    conversationId: string,
    userId: string,
  ): ConversationUserMemberDto | null {
    const row = this.db
      .prepare<[string, string], ConversationUserMemberRow>(
        `SELECT * FROM conversation_users
         WHERE conversation_id = ? AND user_id = ?`,
      )
      .get(conversationId, userId);
    return row ? { ...row } : null;
  }

  removeUser(conversationId: string, userId: string): void {
    this.db
      .prepare(
        `DELETE FROM conversation_users
         WHERE conversation_id = ? AND user_id = ?`,
      )
      .run(conversationId, userId);
  }

  listLiveStatusAgents(): ConversationAgentDto[] {
    return this.db
      .prepare<[], ConversationAgentRow>(
        `SELECT * FROM conversation_agents
         WHERE status IN ('starting', 'active')`,
      )
      .all()
      .map(r => ({ ...r }));
  }

  private insert(params: {
    workspaceId: string;
    workspacePath: string;
    kind: ConversationKind;
    title: string;
    spawnedByAgentId: string | null;
    /** Defaults to the DB column default ('private') when
     *  omitted. Only 'channel' may be 'public' (the DB CHECK enforces it). */
    visibility?: ConversationVisibility;
  }): ConversationRow {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversations
         (id, workspace_id, workspace_path, kind, title, status,
          spawned_by_agent_id, closed_at, close_summary,
          created_at, updated_at, visibility)
         VALUES (?, ?, ?, ?, ?, 'idle', ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        params.workspaceId,
        params.workspacePath,
        params.kind,
        params.title,
        params.spawnedByAgentId,
        now,
        now,
        params.visibility ?? 'private',
      );
    const row = this.db
      .prepare<[string], ConversationRow>('SELECT * FROM conversations WHERE id = ?')
      .get(id);
    if (!row) throw new Error('conversation insert failed');
    return row;
  }

  private getRaw(id: string): ConversationRow | null {
    const row = this.db
      .prepare<[string], ConversationRow>('SELECT * FROM conversations WHERE id = ?')
      .get(id);
    return row ?? null;
  }
}

export interface ArchivedAggregateRow {
  channel: ChannelConversationDto | DmChannelDto;
  workspace: {
    id: string;
    name: string;
    archived_at: number | null;
  };
}

export interface RepoError extends Error {
  code: string;
}

function repoError(code: string, message: string): RepoError {
  const err = new Error(message) as RepoError;
  err.code = code;
  return err;
}
