import type { Database as Db } from 'better-sqlite3';
import type {
  MessageRow,
  ConversationPlacementKind,
  ConversationRosterPolicy,
  SearchConversationRef,
  SearchQueryInput,
  SearchResultDto,
  SearchWorkspaceRef,
} from '@silverhand/shared';
import { messageRowToDto } from './message-repo.js';
import { loadMessageAuthors } from './message-author.js';
import { likeNeedle } from './sql-like.js';
import { workspacePlaced, userParticipates } from './conversation-placement-sql.js';
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
  conversation_placement_kind: ConversationPlacementKind;
  conversation_roster_policy: ConversationRosterPolicy;
  channel_id: string;
  closed_at: number | null;
  conversation_created_at: number;
  // NULLABLE since #task:2053: a `direct_pair` conversation has no workspace, so
  // the LEFT JOIN yields NULL workspace columns. `conversationRef` reconciles
  // this null against `placement_kind` and builds the discriminated `direct_pair`
  // arm, which has no `workspace` field at all (no nullable sibling on the wire).
  workspace_id: string | null;
  workspace_name: string | null;
  workspace_kind: SearchWorkspaceKind | null;
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
  conversation_placement_kind: ConversationPlacementKind;
  conversation_roster_policy: ConversationRosterPolicy;
  channel_id: string;
  closed_at: number | null;
  conversation_created_at: number;
  workspace_id: string | null;
  workspace_name: string | null;
  workspace_kind: SearchWorkspaceKind | null;
  agent_name: string | null;
};

/** The workspace ref for a result row, or `null` when the conversation is
 *  workspace-less (a `direct_pair`). Null is keyed on `workspace_id` — the LEFT
 *  JOIN's only NULL-producing column — so the ref exists exactly when a
 *  workspace coordinate resolved. `conversationRef` then selects the shared
 *  discriminated arm by `placement_kind` (#task:2053-C): the workspace ref lives
 *  INSIDE the `workspace` arm as a compiler-enforced type fact — there is no
 *  runtime superRefine and no nullable sibling to reconcile. */
function workspaceRefOrNull(row: {
  workspace_id: string | null;
  workspace_name: string | null;
  workspace_kind: SearchWorkspaceKind | null;
}): SearchWorkspaceRef | null {
  if (row.workspace_id === null) return null;
  return {
    id: row.workspace_id,
    name: row.workspace_name as string,
    kind: row.workspace_kind as SearchWorkspaceKind,
  };
}

function conversationRef(row: {
  conversation_id: string;
  conversation_title: string;
  conversation_placement_kind: ConversationPlacementKind;
  conversation_roster_policy: ConversationRosterPolicy;
  channel_id: string;
  closed_at: number | null;
  conversation_created_at: number;
  workspace_id: string | null;
  workspace_name: string | null;
  workspace_kind: SearchWorkspaceKind | null;
}): SearchConversationRef {
  const base = {
    id: row.conversation_id,
    title: row.conversation_title,
    roster_policy: row.conversation_roster_policy,
    channel_id: row.channel_id,
    closed_at: row.closed_at,
    created_at: row.conversation_created_at,
  };
  if (row.conversation_placement_kind === 'direct_pair') {
    return { ...base, placement_kind: 'direct_pair' };
  }
  // #task:2053-C — fail closed, NO `else → workspace`. The producer whitelist
  // (`applyConversationScopeFilters`) admits only `workspace` | `direct_pair`,
  // and a workspace-placed row always resolves its workspace coordinate through
  // the LEFT JOIN. A row that is neither a pair nor a workspace-with-workspace
  // is a projection bug, not a renderable result — refuse it loudly rather than
  // mislabel it as workspace-placed and emit a ref the discriminated schema
  // cannot describe.
  const workspace = workspaceRefOrNull(row);
  if (row.conversation_placement_kind !== 'workspace' || workspace === null) {
    throw new Error(
      `search: unrenderable placement '${row.conversation_placement_kind}' (workspace ${workspace === null ? 'missing' : 'present'})`,
    );
  }
  return { ...base, placement_kind: 'workspace', workspace };
}

export class SearchRepo {
  constructor(private readonly db: Db) {}

  /** Returns matched entities plus the message-match `total` (before the
   *  result cap) and whether the returned message list was `truncated`.
   *  `total` / `truncated` describe MESSAGE matches only — the named-entity
   *  (workspace / conversation) results are discovery sugar and excluded from
   *  the count that drives the inline "N / M" counter.
   *
   *  `viewerUserId` is REQUIRED (#task:2053-B①): search is a content read face,
   *  and every population arm rests on it (workspace discovery on
   *  `workspace_users`, conversation/message arms on `userParticipates`). It was
   *  previously an OPTIONAL options-bag field (`visibleUserId`) that defaulted to
   *  "no filter", which put the exclusion of workspace-less placements on a
   *  coordinate-lookup side effect a caller could silently drop. As a required
   *  parameter, under-supplying the viewer fails to compile rather than opening
   *  the face at runtime. That bag is now gone entirely (#task:2061 removed its
   *  last field, `includeNullAuthor`): every search input arrives through
   *  `SearchQueryInput`, so there is no second, caller-shaped channel that can
   *  change which rows match. */
  search(
    input: SearchQueryInput,
    viewerUserId: string,
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
        ...this.searchWorkspaces(input, query, Math.min(20, limit), viewerUserId),
        ...this.searchConversations(
          input,
          query,
          Math.min(30, limit),
          viewerUserId,
        ),
      );
    }

    const messages = this.searchMessages(input, query, limit, viewerUserId);
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
    viewerUserId: string,
  ): SearchResultDto[] {
    const where: string[] = [
      `(workspace_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`,
    ];
    const params: SqlValue[] = [likeNeedle(query), likeNeedle(query)];
    applyNamedScopeFilters(where, params, input);
    applyTimeFilters(where, params, input, 'created_at');
    // The workspace-DISCOVERY gate is workspace MEMBERSHIP, not conversation
    // participation (#task:2053, Paul boundary-1): `userParticipates` is
    // meaningless for a workspace row. Always applied now that the viewer is
    // required.
    where.push(
      `EXISTS (
         SELECT 1
          FROM workspace_users wu
          WHERE wu.workspace_id = search_ws.workspace_id
            AND wu.user_id = ?
       )`,
    );
    params.push(viewerUserId);
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
    viewerUserId: string,
  ): SearchResultDto[] {
    const where: string[] = [`conv.title LIKE ? ESCAPE '\\'`];
    const params: SqlValue[] = [likeNeedle(query)];
    applyConversationScopeFilters(where, params, input, 'conv', 'w');
    applyTimeFilters(where, params, input, 'conv.created_at');
    applyUserParticipation(where, params, viewerUserId, 'conv');
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT
            conv.id AS conversation_id,
            conv.title AS conversation_title,
            conv.placement_kind AS conversation_placement_kind,
            conv.roster_policy AS conversation_roster_policy,
            conv.id AS channel_id,
            conv.closed_at AS closed_at,
            conv.created_at AS conversation_created_at,
            w.id AS workspace_id,
            w.name AS workspace_name,
            CASE
              WHEN w.id IS NULL THEN NULL
              WHEN w.workspace_kind = 'agent_home' THEN 'dm'
              ELSE 'regular'
            END AS workspace_kind
           FROM conversations conv
           LEFT JOIN workspaces w ON w.id = conv.workspace_id
          WHERE ${where.join(' AND ')}
          ORDER BY conv.updated_at DESC
          LIMIT ?`,
      )
      .all(...params) as ConversationSearchRow[];

    return rows.map(row => ({
      type: 'conversation',
      conversation: conversationRef(row),
    }));
  }

  private searchMessages(
    input: SearchQueryInput,
    query: string,
    limit: number,
    viewerUserId: string,
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
    applyUserParticipation(where, params, viewerUserId, 'conv');
    // Sender narrowing matches the STABLE send-time snapshot
    // (`m.from_kind` + `m.author_id`), NOT the live FK
    // (`from_user_id` / `from_agent_id`), which `ON DELETE SET NULL` clears when
    // the actor is hard-deleted — an FK predicate silently drops every message
    // from a since-deleted sender. For an actor that still exists the two keys
    // are row-equivalent (v63 backfilled `author_id = from_*_id`, and every
    // insert since writes the same id into both), so this is free on active
    // senders and only differs where it matters. Same key as the saved list
    // (#task:2059) and as distinct-replier grouping (#task:1791) — one author
    // identity rule across every face that filters or groups by sender
    // (#task:2061).
    //
    // A row with neither FK nor snapshot (`author_id IS NULL` → `unresolved`)
    // has no nameable identity, so `= ?` with a non-null parameter matches it
    // under NO sender. That is deliberate: this arm used to widen to
    // `from_user_id IS NULL` whenever the filter id equalled the viewer, which
    // attributed every legacy anonymous row to whoever was searching — the same
    // rows counted for two different humans, so per-sender results summed past
    // `total`, while the renderer had always drawn them as "Unknown user".
    // The two arms stay independent `if`s (not `else if`): the schema refine
    // makes them mutually exclusive, and if a caller ever broke that the
    // conjunction yields nothing rather than silently preferring one axis.
    if (input.user_id) {
      where.push(`m.from_kind = 'user'`);
      where.push(`m.author_id = ?`);
      params.push(input.user_id);
    }
    if (input.agent_id) {
      where.push(`m.from_kind = 'agent'`);
      where.push(`m.author_id = ?`);
      params.push(input.agent_id);
    }
    const whereSql = where.length > 0 ? where.join(' AND ') : '1 = 1';
    // `total` is the true message-match count over the SAME WHERE, so the
    // inline counter and the future advanced panel can show "2 / 7" honestly
    // and `truncated` (total > limit) means "there are matches past the cap".
    // The COUNT is a deliberate second query: this is a user-initiated search,
    // not a hot path, and an honest count that matches the field name beats
    // saving one scan. It is built from the SAME `messageSearchFrom` FROM/WHERE
    // constructor as the row query (#task:2053-D): a future filter added to one
    // cannot silently skip the other, and the workspaces join is a LEFT join
    // (not INNER) in BOTH, so a `direct_pair` hit is counted, not dropped —
    // otherwise `total`/`truncated` would undercount pairs and the "N / M"
    // counter would lie. (The agents join is additive/LEFT and never filters,
    // so only the row query carries it, for `agent_name`.)
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n ${messageSearchFrom(whereSql, false)}`,
        )
        .get(...params) as { n: number }
    ).n;

    // seq_asc keeps the earliest matches; recency_desc the most recent —
    // either way prev/next spans exactly the returned set.
    const orderSql =
      input.order === 'seq_asc'
        ? 'ORDER BY m.seq ASC'
        : 'ORDER BY m.created_at DESC, m.seq DESC';
    const rows = this.db
      .prepare(
        `SELECT
            m.*,
            conv.title AS conversation_title,
            conv.placement_kind AS conversation_placement_kind,
            conv.roster_policy AS conversation_roster_policy,
            conv.id AS channel_id,
            conv.closed_at AS closed_at,
            conv.created_at AS conversation_created_at,
            w.id AS workspace_id,
            w.name AS workspace_name,
            CASE
              WHEN w.id IS NULL THEN NULL
              WHEN w.workspace_kind = 'agent_home' THEN 'dm'
              ELSE 'regular'
            END AS workspace_kind,
            a.name AS agent_name
           ${messageSearchFrom(whereSql, true)}
          ${orderSql}
          LIMIT ?`,
      )
      .all(...params, limit) as MessageSearchRow[];

    const authors = loadMessageAuthors(this.db, rows);
    return {
      results: rows.map(row => ({
        type: 'message',
        conversation: conversationRef(row),
        message: messageRowToDto(row, { author: authors.get(row) ?? null }),
        agent_name: row.agent_name,
      })),
      total,
      truncated: total > limit,
    };
  }
}

/** THE single FROM/WHERE construction path for message search (#task:2053-D):
 *  the row query and the `total` COUNT both build on this, so a filter added to
 *  one is added to both and cannot drift. The `workspaces` join is LEFT (not
 *  INNER) — a `direct_pair` message has no workspace, and an INNER join here
 *  would silently drop it from BOTH the page and the count. `agent_name` is the
 *  only reason the row query needs `agents`; that join is additive and never
 *  filters, so the COUNT omits it via `withAgentJoin=false`. */
function messageSearchFrom(whereSql: string, withAgentJoin: boolean): string {
  return `FROM messages m
           JOIN conversations conv ON conv.id = m.conversation_id
           LEFT JOIN workspaces w ON w.id = conv.workspace_id
           ${withAgentJoin ? 'LEFT JOIN agents a ON a.id = m.from_agent_id' : ''}
          WHERE ${whereSql}`;
}

/** The viewer-participation bottom guard for the conversation/message arms
 *  (#task:2053-A/B①): the ONE participation authority (`userParticipates`)
 *  rather than a search-local bare `EXISTS(conversation_users)`. Its workspace
 *  arm is `seat ∧ workspace membership` (stricter than a bare seat), and its
 *  `direct_pair` arm admits a human endpoint — which is how a workspace-less DM
 *  becomes searchable. Always applied (viewer is required). */
function applyUserParticipation(
  where: string[],
  params: SqlValue[],
  viewerUserId: string,
  conversationAlias: string,
): void {
  const fragment = userParticipates(conversationAlias, viewerUserId);
  where.push(fragment.sql);
  params.push(...fragment.params);
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
  // #task:2053-B② — POSITIVE WHITELIST, not a `workspacePlaced` hard predicate.
  // Search's domain is workspace channels PLUS workspace-less human↔agent
  // DirectPairs; both placements are named here as a DECISION IN THE QUERY TEXT.
  // `agent_inbox` (no human participant) and any FUTURE placement kind default
  // OUT — so widening search to a new placement is a deliberate edit here, never
  // an accident of `userParticipates` happening to grow a matching arm. The
  // visibility bottom guard (`userParticipates`) is a SECOND, independent gate;
  // this one bounds the SET OF PLACEMENTS search covers at all.
  where.push(
    `${conversationAlias}.placement_kind IN ('workspace', 'direct_pair')`,
  );
  // #task:2053-E — scope tokens `regular`/`dm` are WORKSPACE-KIND filters, and
  // `dm` STILL MEANS the agent_home workspace kind, NOT a DirectPair. Each
  // carries an EXPLICIT `placement_kind = 'workspace'` conjunct (via
  // `workspacePlaced`) so a `direct_pair` leaves these two tokens by a WRITTEN
  // decision, not by the incidental fact that its NULL `workspace_kind` compares
  // unequal to both literals after the LEFT join. A pair therefore appears only
  // under `scope = 'all'`. Re-partitioning this wire enum into
  // `workspace | agent_space | direct_messages` is a shiki-level decision (it
  // needs a token→population truth table + renderer copy) and is deliberately
  // NOT in this ticket.
  if (input.scope === 'regular') {
    where.push(
      `${workspacePlaced(conversationAlias)} AND ${workspaceAlias}.workspace_kind = 'regular'`,
    );
  } else if (input.scope === 'dm') {
    where.push(
      `${workspacePlaced(conversationAlias)} AND ${workspaceAlias}.workspace_kind = 'agent_home'`,
    );
  }
  if (input.workspace_id) {
    // #task:2053-N1 — a COORDINATE filter, unlike the E scope-token KIND filters
    // above, needs NO `placement_kind = 'workspace'` conjunct: positive equality
    // on `${workspaceAlias}.id` is self-excluding for a `direct_pair` — after the
    // LEFT join its workspace id is NULL, and `NULL = ?` is never true. The
    // exclusion is unambiguous positive-coordinate semantics, not the NULL
    // coincidence the KIND tokens had to guard against with an explicit conjunct.
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
