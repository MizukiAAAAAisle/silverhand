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
import { likeNeedle } from './sql-like.js';
import {
  streamScopePredicate,
  streamScopeParams,
  type WindowScope,
} from './message-stream-scope.js';

type SqlValue = string | number | null;

type SearchWorkspaceKind = 'regular' | 'dm';

interface ConversationSearchRow {
  conversation_id: string;
  conversation_title: string;
  conversation_kind: ConversationKind;
  channel_id: string;
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
  closed_at: number | null;
  conversation_created_at: number;
  workspace_id: string;
  workspace_name: string;
  workspace_kind: SearchWorkspaceKind;
  agent_name: string | null;
};

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
  closed_at: number | null;
  conversation_created_at: number;
}): SearchConversationRef {
  return {
    id: row.conversation_id,
    title: row.conversation_title,
    kind: row.conversation_kind,
    channel_id: row.channel_id,
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

  /** Returns matched entities plus the message-match `total` (before the
   *  result cap) and whether the returned message list was `truncated`.
   *  `total` / `truncated` describe MESSAGE matches only — the named-entity
   *  (workspace / conversation) results are discovery sugar and excluded from
   *  the count that drives the inline "N / M" counter. */
  search(
    input: SearchQueryInput,
    opts: SearchOptions = {},
  ): { results: SearchResultDto[]; total: number; truncated: boolean } {
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

    if (!hasSearchIntent) return { results: [], total: 0, truncated: false };

    const limit = input.limit;
    const results: SearchResultDto[] = [];
    // Conversation-scoped search (the header inline find) is messages-only:
    // workspace / conversation discovery results would be noise inside one
    // conversation and would also compete for the result cap.
    const includeNamedEntities =
      query.length > 0 && !hasAuthorFilter && !input.conversation_id;

    if (includeNamedEntities) {
      results.push(
        ...this.searchWorkspaces(input, query, Math.min(20, limit), opts),
        ...this.searchConversations(input, query, Math.min(30, limit), opts),
      );
    }

    const messages = this.searchMessages(input, query, limit, opts);
    results.push(...messages.results);
    return {
      results: results.slice(0, limit),
      total: messages.total,
      truncated: messages.truncated,
    };
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
    applyConversationScopeFilters(where, params, input, 'conv', 'w');
    applyTimeFilters(where, params, input, 'conv.created_at');
    applyConversationUserVisibility(where, params, opts, 'conv');
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT
            conv.id AS conversation_id,
            conv.title AS conversation_title,
            conv.kind AS conversation_kind,
            conv.id AS channel_id,
            conv.closed_at AS closed_at,
            conv.created_at AS conversation_created_at,
            w.id AS workspace_id,
            w.name AS workspace_name,
            CASE WHEN w.workspace_kind = 'agent_home' THEN 'dm' ELSE 'regular' END AS workspace_kind
           FROM conversations conv
           JOIN workspaces w ON w.id = conv.workspace_id
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
  ): { results: SearchResultDto[]; total: number; truncated: boolean } {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (query.length > 0) {
      where.push(`m.content LIKE ? ESCAPE '\\'`);
      params.push(likeNeedle(query));
    }
    applyConversationScopeFilters(where, params, input, 'conv', 'w');
    // Stream scope (#task:1334): narrow to one renderable stream via the
    // SAME predicate the message-window read-model uses, so a hit is always
    // materializable in the panel that scoped it. `all` adds no filter (the
    // historical cross-stream behaviour). The schema guarantees a
    // conversation_id accompanies any non-`all` stream, and the route has
    // already normalized a reply id to its thread root.
    const streamScope: WindowScope | null =
      input.stream === 'mainline'
        ? { mode: 'main' }
        : input.stream === 'thread' && input.thread_root_id
          ? { mode: 'cluster', threadRootId: input.thread_root_id }
          : null;
    if (streamScope) {
      where.push(streamScopePredicate('m.'));
      params.push(...streamScopeParams(streamScope));
    }
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
    // Probe one past the cap so we can report `truncated` without a second
    // COUNT query. seq_asc keeps the earliest matches; recency_desc the most
    // recent — either way prev/next spans exactly the returned set.
    params.push(limit + 1);

    const whereSql = where.length > 0 ? where.join(' AND ') : '1 = 1';
    const orderSql =
      input.order === 'seq_asc'
        ? 'ORDER BY m.seq ASC'
        : 'ORDER BY m.created_at DESC, m.seq DESC';
    const rows = this.db
      .prepare(
        `SELECT
            m.*,
            conv.title AS conversation_title,
            conv.kind AS conversation_kind,
            conv.id AS channel_id,
            conv.closed_at AS closed_at,
            conv.created_at AS conversation_created_at,
            w.id AS workspace_id,
            w.name AS workspace_name,
            CASE WHEN w.workspace_kind = 'agent_home' THEN 'dm' ELSE 'regular' END AS workspace_kind,
            a.name AS agent_name
           FROM messages m
           JOIN conversations conv ON conv.id = m.conversation_id
           JOIN workspaces w ON w.id = conv.workspace_id
           LEFT JOIN agents a ON a.id = m.from_agent_id
          WHERE ${whereSql}
          ${orderSql}
          LIMIT ?`,
      )
      .all(...params) as MessageSearchRow[];

    const truncated = rows.length > limit;
    const capped = truncated ? rows.slice(0, limit) : rows;
    return {
      results: capped.map(row => ({
        type: 'message',
        workspace: workspaceRef(row),
        conversation: conversationRef(row),
        message: messageRowToDto(row),
        agent_name: row.agent_name,
      })),
      total: capped.length,
      truncated,
    };
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
    // A thread's replies share the channel's conversation_id (thread =
    // reply-cluster, not a separate conversation), so a single equality
    // scopes the whole channel including its threads. (The prior
    // `root.id = ? OR conv.id = ?` referenced a `root` alias that no query
    // here joins — dead/broken since the reply-cluster cutover.)
    where.push(`${conversationAlias}.id = ?`);
    params.push(input.conversation_id);
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
