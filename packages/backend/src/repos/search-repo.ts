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

export interface SearchOptions {
  /** When true and the input filters by `user_id`, also match rows
   *  where `messages.from_user_id IS NULL`. Routes pass true when the
   *  filter id matches the resolved viewer; pre-PR1 NULL-authored
   *  legacy messages are surfaced as "from current viewer". */
  includeNullAuthor?: boolean;
  /** User visibility bottom guard for public search routes. */
  visibleUserId?: string;
}

export class SearchRepo {
  constructor(private readonly db: Db) {}

  search(input: SearchQueryInput, opts: SearchOptions = {}): SearchResultDto[] {
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
        ...this.searchWorkspaces(input, query, Math.min(20, limit), opts),
        ...this.searchConversations(input, query, Math.min(30, limit), opts),
      );
    }

    results.push(...this.searchMessages(input, query, limit, opts));
    return results.slice(0, limit);
  }

  private searchWorkspaces(
    input: SearchQueryInput,
    query: string,
    limit: number,
    opts: SearchOptions,
  ): SearchResultDto[] {
    const where: string[] = [
      `(workspace_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`,
    ];
    const params: SqlValue[] = [likeNeedle(query), likeNeedle(query)];
    applyNamedScopeFilters(where, params, input);
    applyTimeFilters(where, params, input, 'created_at');
    if (opts.visibleUserId) {
      where.push(
        `EXISTS (
           SELECT 1
            FROM workspace_users wu
            WHERE wu.workspace_id = search_ws.workspace_id
              AND wu.user_id = ?
         )`,
      );
      params.push(opts.visibleUserId);
    }
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT *
           FROM (
             SELECT
               w.id AS workspace_id,
               w.name AS workspace_name,
               CASE WHEN w.workspace_kind = 'agent_home' THEN 'dm' ELSE 'regular' END
                 AS workspace_kind,
               w.description AS description,
               w.archived_at AS archived_at,
               w.created_at AS created_at,
               w.updated_at AS updated_at
              FROM workspaces w
             WHERE w.workspace_kind IN ('regular', 'agent_home')
           ) search_ws
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
    opts: SearchOptions,
  ): SearchResultDto[] {
    const where: string[] = [`conv.title LIKE ? ESCAPE '\\'`];
    const params: SqlValue[] = [likeNeedle(query)];
    applyConversationScopeFilters(where, params, input, 'conv', 'root', 'w');
    applyTimeFilters(where, params, input, 'conv.created_at');
    applyConversationUserVisibility(where, params, opts, 'conv');
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
            w.id AS workspace_id,
            w.name AS workspace_name,
            CASE WHEN w.workspace_kind = 'agent_home' THEN 'dm' ELSE 'regular' END AS workspace_kind
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
    opts: SearchOptions,
  ): SearchResultDto[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (query.length > 0) {
      where.push(`m.content LIKE ? ESCAPE '\\'`);
      params.push(likeNeedle(query));
    }
    applyConversationScopeFilters(where, params, input, 'conv', 'root', 'w');
    applyTimeFilters(where, params, input, 'm.created_at');
    applyConversationUserVisibility(where, params, opts, 'conv');
    if (input.user_id) {
      where.push(`m.from_kind = 'user'`);
      // Legacy NULL-authored messages are surfaced as "from current
      // viewer" (see route layer's includeNullAuthor flag).
      if (opts.includeNullAuthor) {
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
            w.id AS workspace_id,
            w.name AS workspace_name,
            CASE WHEN w.workspace_kind = 'agent_home' THEN 'dm' ELSE 'regular' END AS workspace_kind,
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

function applyConversationUserVisibility(
  where: string[],
  params: SqlValue[],
  opts: SearchOptions,
  conversationAlias: string,
): void {
  if (!opts.visibleUserId) return;
  where.push(
    `EXISTS (
       SELECT 1
         FROM conversation_users cu
        WHERE cu.conversation_id = ${conversationAlias}.id
          AND cu.user_id = ?
     )`,
  );
  params.push(opts.visibleUserId);
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
    where.push(`${workspaceAlias}.workspace_kind = 'regular'`);
  } else if (input.scope === 'dm') {
    where.push(`${workspaceAlias}.workspace_kind = 'agent_home'`);
  }
  if (input.workspace_id) {
    where.push(`${workspaceAlias}.id = ?`);
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
