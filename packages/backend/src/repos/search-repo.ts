import type { Database as Db } from 'better-sqlite3';
import type {
  ChannelKind,
  ChannelRow,
  MessageRow,
  SearchChannelRef,
  SearchQueryInput,
  SearchResultDto,
  SearchSessionRef,
} from '@silverhand/shared';
import { messageRowToDto } from './message-repo.js';

type SqlValue = string | number | null;

interface SessionSearchRow {
  session_id: string;
  session_title: string;
  parent_session_id: string | null;
  closed_at: number | null;
  session_created_at: number;
  channel_id: string;
  channel_name: string;
  channel_kind: ChannelKind;
  dm_agent_id: string | null;
}

type MessageSearchRow = MessageRow & {
  session_title: string;
  parent_session_id: string | null;
  closed_at: number | null;
  session_created_at: number;
  channel_id: string;
  channel_name: string;
  channel_kind: ChannelKind;
  dm_agent_id: string | null;
  agent_name: string | null;
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function likeNeedle(query: string): string {
  return `%${escapeLike(query)}%`;
}

function channelRef(row: {
  channel_id: string;
  channel_name: string;
  channel_kind: ChannelKind;
  dm_agent_id: string | null;
}): SearchChannelRef {
  return {
    id: row.channel_id,
    name: row.channel_name,
    kind: row.channel_kind,
    dm_agent_id: row.dm_agent_id,
  };
}

function sessionRef(row: {
  session_id: string;
  session_title: string;
  parent_session_id: string | null;
  closed_at: number | null;
  session_created_at: number;
}): SearchSessionRef {
  return {
    id: row.session_id,
    title: row.session_title,
    parent_session_id: row.parent_session_id,
    closed_at: row.closed_at,
    created_at: row.session_created_at,
  };
}

export class SearchRepo {
  constructor(private readonly db: Db) {}

  search(input: SearchQueryInput): SearchResultDto[] {
    const query = input.q.trim();
    const hasAuthorFilter = !!input.user_id || !!input.agent_id;
    const hasSearchIntent =
      query.length > 0 ||
      !!input.channel_id ||
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
        ...this.searchChannels(input, query, Math.min(20, limit)),
        ...this.searchSessions(input, query, Math.min(30, limit)),
      );
    }

    results.push(...this.searchMessages(input, query, limit));
    return results.slice(0, limit);
  }

  private searchChannels(
    input: SearchQueryInput,
    query: string,
    limit: number,
  ): SearchResultDto[] {
    const where: string[] = [
      `(c.name LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')`,
    ];
    const params: SqlValue[] = [likeNeedle(query), likeNeedle(query)];
    applyChannelFilters(where, params, input, 'c');
    applyTimeFilters(where, params, input, 'c.created_at');
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT *
           FROM channels c
          WHERE ${where.join(' AND ')}
          ORDER BY c.updated_at DESC
          LIMIT ?`,
      )
      .all(...params) as ChannelRow[];

    return rows.map(row => ({
      type: 'channel',
      channel: {
        id: row.id,
        name: row.name,
        kind: row.kind,
        dm_agent_id: row.dm_agent_id,
        description: row.description,
        archived_at: row.archived_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    }));
  }

  private searchSessions(
    input: SearchQueryInput,
    query: string,
    limit: number,
  ): SearchResultDto[] {
    const where: string[] = [`s.title LIKE ? ESCAPE '\\'`];
    const params: SqlValue[] = [likeNeedle(query)];
    applyChannelFilters(where, params, input, 'c');
    applyTimeFilters(where, params, input, 's.created_at');
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT
            s.id AS session_id,
            s.title AS session_title,
            s.parent_session_id AS parent_session_id,
            s.closed_at AS closed_at,
            s.created_at AS session_created_at,
            c.id AS channel_id,
            c.name AS channel_name,
            c.kind AS channel_kind,
            c.dm_agent_id AS dm_agent_id
           FROM sessions s
           JOIN channels c ON c.id = s.channel_id
          WHERE ${where.join(' AND ')}
          ORDER BY s.updated_at DESC
          LIMIT ?`,
      )
      .all(...params) as SessionSearchRow[];

    return rows.map(row => ({
      type: 'session',
      channel: channelRef(row),
      session: sessionRef(row),
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
    applyChannelFilters(where, params, input, 'c');
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
            s.title AS session_title,
            s.parent_session_id AS parent_session_id,
            s.closed_at AS closed_at,
            s.created_at AS session_created_at,
            c.id AS channel_id,
            c.name AS channel_name,
            c.kind AS channel_kind,
            c.dm_agent_id AS dm_agent_id,
            a.name AS agent_name
           FROM messages m
           JOIN sessions s ON s.id = m.session_id
           JOIN channels c ON c.id = s.channel_id
           LEFT JOIN agents a ON a.id = m.from_agent_id
          WHERE ${whereSql}
          ORDER BY m.created_at DESC, m.seq DESC
          LIMIT ?`,
      )
      .all(...params) as MessageSearchRow[];

    return rows.map(row => ({
      type: 'message',
      channel: channelRef(row),
      session: sessionRef(row),
      message: messageRowToDto(row),
      agent_name: row.agent_name,
    }));
  }
}

function applyChannelFilters(
  where: string[],
  params: SqlValue[],
  input: SearchQueryInput,
  alias: string,
): void {
  if (input.scope !== 'all') {
    where.push(`${alias}.kind = ?`);
    params.push(input.scope);
  }
  if (input.channel_id) {
    where.push(`${alias}.id = ?`);
    params.push(input.channel_id);
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
