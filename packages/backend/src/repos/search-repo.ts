import type { Database as Db } from 'better-sqlite3';
import type {
  MessageRow,
  ConversationKind,
  SearchConversationRef,
  SearchQueryInput,
  SearchResultDto,
  SearchWorkspaceRef,
} from '@silverhand/shared';
import { messageRowToDto } from './message-repo.js';

type SqlValue = string | number | null;

type SearchWorkspaceKind = 'regular' | 'dm';

interface ConversationSearchRow {
  conversation_id: string;
  conversation_title: string;
  conversation_kind: ConversationKind;
  channel_id: string;
  thread_id: string | null;
  parent_conversation_id: string | null;
  closed_at: number | null;
  conversation_created_at: number;
  workspace_id: string;
  workspace_name: string;
  workspace_kind: SearchWorkspaceKind;
}

interface WorkspaceSearchRow {
  workspace_id: string;
  workspace_name: string;
  workspace_kind: SearchWorkspaceKind;
  description: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

type MessageSearchRow = MessageRow & {
  conversation_title: string;
  conversation_kind: ConversationKind;
  channel_id: string;
  thread_id: string | null;
  parent_conversation_id: string | null;
  closed_at: number | null;
  conversation_created_at: number;
  workspace_id: string;
  workspace_name: string;
  workspace_kind: SearchWorkspaceKind;
  agent_name: string | null;
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function likeNeedle(query: string): string {
  return `%${escapeLike(query)}%`;
}

function workspaceRef(row: {
  workspace_id: string;
  workspace_name: string;
  workspace_kind: SearchWorkspaceKind;
}): SearchWorkspaceRef {
  return {
    id: row.workspace_id,
    name: row.workspace_name,
    kind: row.workspace_kind,
  };
}

function conversationRef(row: {
  conversation_id: string;
  conversation_title: string;
  conversation_kind: ConversationKind;
  channel_id: string;
  thread_id: string | null;
  parent_conversation_id: string | null;
  closed_at: number | null;
  conversation_created_at: number;
}): SearchConversationRef {
  return {
    id: row.conversation_id,
    title: row.conversation_title,
    kind: row.conversation_kind,
    channel_id: row.channel_id,
    thread_id: row.thread_id,
    parent_conversation_id: row.parent_conversation_id,
    closed_at: row.closed_at,
    created_at: row.conversation_created_at,
  };
}

export class SearchRepo {
  constructor(private readonly db: Db) {}

  search(input: SearchQueryInput): SearchResultDto[] {
    const query = input.q.trim();
    const hasAuthorFilter = !!input.user_id || !!input.agent_id;
    const hasSearchIntent =
      query.length > 0 ||
      !!input.workspace_id ||
      !!input.conversation_id ||
      input.scope !== 'all' ||
      !!input.user_id ||
      !!input.agent_id ||
      input.from !== undefined ||
      input.to !== undefined;

    if (!hasSearchIntent) return [];

    const limit = input.limit;
    const results: SearchResultDto[] = [];
    const includeNamedEntities = query.length > 0 && !hasAuthorFilter;

    if (includeNamedEntities) {
      results.push(
        ...this.searchWorkspaces(input, query, Math.min(20, limit)),
        ...this.searchConversations(input, query, Math.min(30, limit)),
      );
    }

    results.push(...this.searchMessages(input, query, limit));
    return results.slice(0, limit);
  }

  private searchWorkspaces(
    input: SearchQueryInput,
    query: string,
    limit: number,
  ): SearchResultDto[] {
    const where: string[] = [
      `(workspace_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`,
    ];
    const params: SqlValue[] = [likeNeedle(query), likeNeedle(query)];
    applyNamedScopeFilters(where, params, input);
    applyTimeFilters(where, params, input, 'created_at');
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT *
           FROM (
             SELECT
               w.id AS workspace_id,
               w.name AS workspace_name,
               'regular' AS workspace_kind,
               w.description AS description,
               w.archived_at AS archived_at,
               w.created_at AS created_at,
               w.updated_at AS updated_at
             FROM workspaces w
             WHERE w.workspace_kind = 'regular'
             UNION ALL
             SELECT
               c.id AS workspace_id,
               c.title AS workspace_name,
               'dm' AS workspace_kind,
               NULL AS description,
               c.closed_at AS archived_at,
               c.created_at AS created_at,
               c.updated_at AS updated_at
             FROM conversations c
             WHERE c.kind = 'dm_channel'
           )
          WHERE ${where.join(' AND ')}
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(...params) as WorkspaceSearchRow[];

    return rows.map(row => ({
      type: 'workspace',
      workspace: {
        id: row.workspace_id,
        name: row.workspace_name,
        kind: row.workspace_kind,
        description: row.description,
        archived_at: row.archived_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    }));
  }

  private searchConversations(
    input: SearchQueryInput,
    query: string,
    limit: number,
  ): SearchResultDto[] {
    const where: string[] = [`conv.title LIKE ? ESCAPE '\\'`];
    const params: SqlValue[] = [likeNeedle(query)];
    applyConversationScopeFilters(where, params, input, 'conv', 'root', 'w');
    applyTimeFilters(where, params, input, 'conv.created_at');
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT
            conv.id AS conversation_id,
            conv.title AS conversation_title,
            conv.kind AS conversation_kind,
            root.id AS channel_id,
            CASE WHEN conv.kind = 'thread' THEN conv.id ELSE NULL END AS thread_id,
            conv.parent_conversation_id AS parent_conversation_id,
            conv.closed_at AS closed_at,
            conv.created_at AS conversation_created_at,
            CASE WHEN root.kind = 'dm_channel' THEN root.id ELSE w.id END AS workspace_id,
            CASE WHEN root.kind = 'dm_channel' THEN root.title ELSE w.name END AS workspace_name,
            CASE WHEN root.kind = 'dm_channel' THEN 'dm' ELSE 'regular' END AS workspace_kind
           FROM conversations conv
           JOIN workspaces w ON w.id = conv.workspace_id
           JOIN conversations root ON root.id = CASE
             WHEN conv.kind = 'thread' THEN conv.parent_conversation_id
             ELSE conv.id
           END
          WHERE ${where.join(' AND ')}
          ORDER BY conv.updated_at DESC
          LIMIT ?`,
      )
      .all(...params) as ConversationSearchRow[];

    return rows.map(row => ({
      type: 'conversation',
      workspace: workspaceRef(row),
      conversation: conversationRef(row),
    }));
  }

  private searchMessages(
    input: SearchQueryInput,
    query: string,
    limit: number,
  ): SearchResultDto[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (query.length > 0) {
      where.push(`m.content LIKE ? ESCAPE '\\'`);
      params.push(likeNeedle(query));
    }
    applyConversationScopeFilters(where, params, input, 'conv', 'root', 'w');
    applyTimeFilters(where, params, input, 'm.created_at');
    if (input.user_id) {
      where.push(`m.from_kind = 'user'`);
      if (input.user_id === 'local') {
        where.push(`(m.from_user_id = ? OR m.from_user_id IS NULL)`);
      } else {
        where.push(`m.from_user_id = ?`);
      }
      params.push(input.user_id);
    }
    if (input.agent_id) {
      where.push(`m.from_kind = 'agent'`);
      where.push(`m.from_agent_id = ?`);
      params.push(input.agent_id);
    }
    params.push(limit);

    const whereSql = where.length > 0 ? where.join(' AND ') : '1 = 1';
    const rows = this.db
      .prepare(
        `SELECT
            m.*,
            conv.title AS conversation_title,
            conv.kind AS conversation_kind,
            root.id AS channel_id,
            CASE WHEN conv.kind = 'thread' THEN conv.id ELSE NULL END AS thread_id,
            conv.parent_conversation_id AS parent_conversation_id,
            conv.closed_at AS closed_at,
            conv.created_at AS conversation_created_at,
            CASE WHEN root.kind = 'dm_channel' THEN root.id ELSE w.id END AS workspace_id,
            CASE WHEN root.kind = 'dm_channel' THEN root.title ELSE w.name END AS workspace_name,
            CASE WHEN root.kind = 'dm_channel' THEN 'dm' ELSE 'regular' END AS workspace_kind,
            a.name AS agent_name
           FROM messages m
           JOIN conversations conv ON conv.id = m.conversation_id
           JOIN workspaces w ON w.id = conv.workspace_id
           JOIN conversations root ON root.id = CASE
             WHEN conv.kind = 'thread' THEN conv.parent_conversation_id
             ELSE conv.id
           END
           LEFT JOIN agents a ON a.id = m.from_agent_id
          WHERE ${whereSql}
          ORDER BY m.created_at DESC, m.seq DESC
          LIMIT ?`,
      )
      .all(...params) as MessageSearchRow[];

    return rows.map(row => ({
      type: 'message',
      workspace: workspaceRef(row),
      conversation: conversationRef(row),
      message: messageRowToDto(row),
      agent_name: row.agent_name,
    }));
  }
}

function applyNamedScopeFilters(
  where: string[],
  params: SqlValue[],
  input: SearchQueryInput,
): void {
  if (input.scope !== 'all') {
    where.push(`workspace_kind = ?`);
    params.push(input.scope);
  }
  if (input.workspace_id) {
    where.push(`workspace_id = ?`);
    params.push(input.workspace_id);
  }
}

function applyConversationScopeFilters(
  where: string[],
  params: SqlValue[],
  input: SearchQueryInput,
  conversationAlias: string,
  rootAlias: string,
  workspaceAlias: string,
): void {
  if (input.scope === 'regular') {
    where.push(`${rootAlias}.kind = 'channel'`);
  } else if (input.scope === 'dm') {
    where.push(`${rootAlias}.kind = 'dm_channel'`);
  }
  if (input.workspace_id) {
    where.push(
      `(CASE WHEN ${rootAlias}.kind = 'dm_channel' THEN ${rootAlias}.id ELSE ${workspaceAlias}.id END) = ?`,
    );
    params.push(input.workspace_id);
  }
  if (input.conversation_id) {
    where.push(`(${rootAlias}.id = ? OR ${conversationAlias}.id = ?)`);
    params.push(input.conversation_id, input.conversation_id);
  }
}

function applyTimeFilters(
  where: string[],
  params: SqlValue[],
  input: SearchQueryInput,
  column: string,
): void {
  if (input.from !== undefined) {
    where.push(`${column} >= ?`);
    params.push(input.from);
  }
  if (input.to !== undefined) {
    where.push(`${column} <= ?`);
    params.push(input.to);
  }
}
