import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
  ChildSessionLimits,
  ChannelConversationDto,
  ConversationAgentDto,
  ConversationAgentRow,
  ConversationDto,
  ConversationKind,
  ConversationRow,
  DmChannelDto,
  ThreadDto,
} from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

function rowToDto(row: ConversationRow): ConversationDto {
  return { ...row };
}

function assertChannelLike(row: ConversationRow): ChannelConversationDto | DmChannelDto {
  if (row.kind === 'dm_channel') return rowToDmChannel(row);
  return rowToChannel(row);
}

function rowToChannel(row: ConversationRow): ChannelConversationDto {
  if (row.kind !== 'channel' || row.parent_conversation_id !== null) {
    throw new Error('conversation is not a channel');
  }
  return { ...row, kind: 'channel', parent_conversation_id: null };
}

function rowToDmChannel(row: ConversationRow): DmChannelDto {
  if (row.kind !== 'dm_channel' || row.parent_conversation_id !== null) {
    throw new Error('conversation is not a dm_channel');
  }
  return { ...row, kind: 'dm_channel', parent_conversation_id: null };
}

function rowToThread(
  row: ConversationRow,
  anchorMessageId: string | null = null,
): ThreadDto {
  if (row.kind !== 'thread' || row.parent_conversation_id === null) {
    throw new Error('conversation is not a thread');
  }
  return {
    ...row,
    kind: 'thread',
    channel_id: row.parent_conversation_id,
    anchor_message_id: anchorMessageId,
  };
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

  getThread(id: string): ThreadDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE id = ? AND kind = 'thread'`,
      )
      .get(id);
    return row ? rowToThread(row, this.findThreadAnchorMessageId(row.id)) : null;
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

  listChannelsForWorkspace(workspaceId: string): ChannelConversationDto[] {
    const rows = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE workspace_id = ? AND kind = 'channel'
         ORDER BY (pinned_at IS NOT NULL) DESC,
                  pinned_at ASC,
                  created_at ASC`,
      )
      .all(workspaceId);
    return rows.map(rowToChannel);
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

  listThreadsForChannel(channelId: string): ThreadDto[] {
    const rows = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE parent_conversation_id = ? AND kind = 'thread'
         ORDER BY created_at ASC`,
      )
      .all(channelId);
    return rows.map(r => rowToThread(r, this.findThreadAnchorMessageId(r.id)));
  }

  listThreadsForWorkspace(workspaceId: string): ThreadDto[] {
    const rows = this.db
      .prepare<
        [string],
        ConversationRow & { anchor_message_id: string | null }
      >(
        `SELECT c.*,
                json_extract(m.metadata, '$.quoted_message_id') AS anchor_message_id
           FROM conversations c
           LEFT JOIN messages m
             ON m.id = (
               SELECT m2.id
                 FROM messages m2
                WHERE m2.conversation_id = c.id
                  AND m2.from_kind = 'system'
                  AND json_extract(m2.metadata, '$.subtype') = 'thread_anchor'
                ORDER BY m2.created_at ASC
                LIMIT 1
             )
          WHERE c.workspace_id = ? AND c.kind = 'thread'
          ORDER BY c.created_at ASC`,
      )
      .all(workspaceId);
    return rows.map(r => rowToThread(r, r.anchor_message_id));
  }

  listChildren(parentId: string): ThreadDto[] {
    return this.listThreadsForChannel(parentId);
  }

  countActiveChildren(parentId: string): number {
    const row = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c
         FROM conversations
         WHERE parent_conversation_id = ? AND closed_at IS NULL`,
      )
      .get(parentId);
    return row?.c ?? 0;
  }

  findOpenThreadChild(parentId: string, anchorMessageId: string): ThreadDto | null {
    const row = this.db
      .prepare<[string, string], ConversationRow>(
        `SELECT c.*
         FROM conversations c
         JOIN messages m ON m.conversation_id = c.id
         WHERE c.parent_conversation_id = ?
           AND c.closed_at IS NULL
           AND c.kind = 'thread'
           AND m.from_kind = 'system'
           AND json_extract(m.metadata, '$.subtype') = 'thread_anchor'
           AND json_extract(m.metadata, '$.quoted_message_id') = ?
         ORDER BY c.created_at DESC
         LIMIT 1`,
      )
      .get(parentId, anchorMessageId);
    return row ? rowToThread(row, anchorMessageId) : null;
  }

  listThreadSummariesForParent(
    parentId: string,
  ): Array<{ thread_id: string; anchor_message_id: string | null; reply_count: number }> {
    return this.db
      .prepare<
        [string, string],
        { thread_id: string; anchor_message_id: string | null; reply_count: number }
      >(
        `SELECT
           c.id AS thread_id,
           json_extract(anchor.metadata, '$.quoted_message_id') AS anchor_message_id,
           COALESCE(stats.reply_count, 0) AS reply_count
         FROM conversations c
         LEFT JOIN (
           SELECT
             m.conversation_id,
             SUM(CASE WHEN m.from_kind != 'system' THEN 1 ELSE 0 END) AS reply_count,
             MIN(CASE
               WHEN m.from_kind = 'system'
                AND json_extract(m.metadata, '$.subtype') = 'thread_anchor'
               THEN m.seq
               ELSE NULL
             END) AS anchor_seq
           FROM messages m
           JOIN conversations tc ON tc.id = m.conversation_id
           WHERE tc.parent_conversation_id = ?
             AND tc.kind = 'thread'
           GROUP BY m.conversation_id
         ) stats ON stats.conversation_id = c.id
         LEFT JOIN messages anchor
           ON anchor.conversation_id = c.id
          AND anchor.seq = stats.anchor_seq
         WHERE c.parent_conversation_id = ?
           AND c.kind = 'thread'
         ORDER BY c.created_at ASC`,
      )
      .all(parentId, parentId);
  }

  insertChannel(params: {
    workspaceId: string;
    workspacePath: string;
    title: string;
    spawnedByAgentId?: string | null;
  }): ChannelConversationDto {
    const row = this.insert({
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      kind: 'channel',
      title: params.title,
      parentConversationId: null,
      spawnedByAgentId: params.spawnedByAgentId ?? null,
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
      parentConversationId: null,
      spawnedByAgentId: null,
    });
    return rowToDmChannel(row);
  }

  insertThread(params: {
    channelId: string;
    title: string;
    spawnedByAgentId?: string | null;
    spawnCtx?: SpawnLimitContext;
  }): ThreadDto {
    const parent = this.getChannelLike(params.channelId);
    if (!parent) throw repoError('parent_not_found', 'parent channel not found');
    if (parent.closed_at !== null) {
      throw repoError('parent_closed', 'parent channel is closed');
    }
    if (params.spawnCtx) {
      const { limits, lastSpawnAtByAgent } = params.spawnCtx;
      if (limits.max_concurrent_per_parent !== null) {
        const active = this.countActiveChildren(parent.id);
        if (active >= limits.max_concurrent_per_parent) {
          throw repoError(
            'concurrent_limit',
            `thread limit reached: ${active}/${limits.max_concurrent_per_parent} active under this channel`,
          );
        }
      }
      if (
        limits.spawn_cooldown_seconds !== null &&
        params.spawnedByAgentId
      ) {
        const last = lastSpawnAtByAgent.get(params.spawnedByAgentId);
        if (
          last !== undefined &&
          Date.now() - last < limits.spawn_cooldown_seconds * 1000
        ) {
          throw repoError(
            'spawn_cooldown',
            `spawn cooldown active: must wait ${limits.spawn_cooldown_seconds}s between spawns`,
          );
        }
      }
    }
    const row = this.insert({
      workspaceId: parent.workspace_id,
      workspacePath: parent.workspace_path,
      kind: 'thread',
      title: params.title,
      parentConversationId: parent.id,
      spawnedByAgentId: params.spawnedByAgentId ?? null,
    });
    if (params.spawnCtx && params.spawnedByAgentId) {
      params.spawnCtx.lastSpawnAtByAgent.set(params.spawnedByAgentId, row.created_at);
    }
    return rowToThread(row);
  }

  pin(id: string): ChannelConversationDto | DmChannelDto | null {
    const conversation = this.get(id);
    if (!conversation) return null;
    if (conversation.kind === 'thread') {
      throw repoError('thread', 'only top-level channels can be pinned');
    }
    const now = Date.now();
    this.db
      .prepare(`UPDATE conversations SET pinned_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, id);
    const row = this.getRaw(id);
    return row ? assertChannelLike(row) : null;
  }

  unpin(id: string): ChannelConversationDto | DmChannelDto | null {
    const now = Date.now();
    this.db
      .prepare(`UPDATE conversations SET pinned_at = NULL, updated_at = ? WHERE id = ?`)
      .run(now, id);
    const row = this.getRaw(id);
    if (!row || row.kind === 'thread') return null;
    return assertChannelLike(row);
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
    parentConversationId: string | null;
    title: string;
    spawnedByAgentId: string | null;
  }): ConversationRow {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversations
         (id, workspace_id, workspace_path, kind, parent_conversation_id,
          title, status, spawned_by_agent_id, closed_at, close_summary,
          pinned_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        params.workspaceId,
        params.workspacePath,
        params.kind,
        params.parentConversationId,
        params.title,
        params.spawnedByAgentId,
        now,
        now,
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

  private findThreadAnchorMessageId(threadId: string): string | null {
    const row = this.db
      .prepare<[string], { anchor_message_id: string | null }>(
        `SELECT json_extract(metadata, '$.quoted_message_id') AS anchor_message_id
           FROM messages
          WHERE conversation_id = ?
            AND from_kind = 'system'
            AND json_extract(metadata, '$.subtype') = 'thread_anchor'
          ORDER BY created_at ASC
          LIMIT 1`,
      )
      .get(threadId);
    return row?.anchor_message_id ?? null;
  }
}

export interface SpawnLimitContext {
  limits: ChildSessionLimits;
  /** Last spawn timestamps per agent — maintained in-process. */
  lastSpawnAtByAgent: Map<string, number>;
}

export interface RepoError extends Error {
  code: string;
}

function repoError(code: string, message: string): RepoError {
  const err = new Error(message) as RepoError;
  err.code = code;
  return err;
}
