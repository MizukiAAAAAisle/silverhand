import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
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

  insertChannel(params: {
    workspaceId: string;
    workspacePath: string;
    title: string;
  }): ChannelConversationDto {
    const row = this.insert({
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      kind: 'channel',
      title: params.title,
      parentConversationId: null,
      spawnedByAgentId: null,
    });
    return rowToChannel(row);
  }

  insertDmChannel(params: {
    workspaceId: string;
    workspacePath: string;
    title: string;
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
  }): ThreadDto {
    const parent = this.getChannelLike(params.channelId);
    if (!parent) throw repoError('parent_not_found', 'parent channel not found');
    if (parent.closed_at !== null) {
      throw repoError('parent_closed', 'parent channel is closed');
    }
    const row = this.insert({
      workspaceId: parent.workspace_id,
      workspacePath: parent.workspace_path,
      kind: 'thread',
      title: params.title,
      parentConversationId: parent.id,
      spawnedByAgentId: params.spawnedByAgentId ?? null,
    });
    return rowToThread(row);
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

  private getChannelLike(id: string): ChannelConversationDto | DmChannelDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE id = ? AND kind IN ('channel', 'dm_channel')`,
      )
      .get(id);
    if (!row) return null;
    return row.kind === 'dm_channel' ? rowToDmChannel(row) : rowToChannel(row);
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

export interface RepoError extends Error {
  code: string;
}

function repoError(code: string, message: string): RepoError {
  const err = new Error(message) as RepoError;
  err.code = code;
  return err;
}
