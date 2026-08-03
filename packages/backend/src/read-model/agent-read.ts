// Agent read-model (#task:980 routes.ts vertical CQRS read-side split — DDD
// boundary refactor; no new feature / UI / behavior change). The read-side
// query + projection logic for the agent-facing read endpoints
// (read-history / list-channels / search-messages) lives here instead of
// inline in routes.ts: raw SQL string building, row→DTO assembly, anchored
// pagination, visibility filtering, and search excerpting. Moved verbatim from
// createApiRouter's module scope — same SQL, same DTO shapes, same behavior;
// the route handlers now call the four exported entrypoints.
//
// Kept OUT of this module (per #task:980 scope): parseLimit/parseBeforeSeq
// (query parsing), buildAgentListWorkspacesDto + failedOutcome (workspace
// registry / data-plane resolution), publishUnreadUpdated (unread). They stay
// in routes.ts. Dependency direction is one-way: routes.ts → read-model.
//
// Public entrypoints (called by routes.ts): resolveAgentReadHistoryTarget,
// buildReadHistoryDto, listAgentVisibleChannels, buildAgentSearchMessagesDto.
// Everything else (refs, LIKE escaping, snippet, history SQL helpers) is
// module-private.
import type { BackendContext } from '../context.js';
import { ConversationRepo } from '../repos/conversation-repo.js';
import { loadMessageAuthors } from '../repos/message-author.js';
import {
  LINKED_TASK_JOINS,
  LINKED_TASK_SELECT,
  linkedTaskFromRow,
  messageRowToDto,
  type LinkedTaskProjectionRow,
} from '../repos/message-repo.js';
import {
  loadReactionAggregates,
  type ReactionViewer,
} from './message-reactions.js';
import { senderRefFromAuthor } from '@silverhand/shared';
import type {
  AgentListChannelsDto,
  AgentListedChannel,
  AgentReadHistoryDto,
  AgentSearchMessageHit,
  AgentSearchMessagesDto,
  MessageAuthorDto,
  MessageRef,
  MessageRow,
  ReactionAggregateDto,
  ReadHistoryMessage,
  ReadHistoryTarget,
  ReadHistoryTargetRef,
} from '@silverhand/shared';


const READ_HISTORY_SNIPPET_MAX_CHARS = 160;
const SEARCH_EXCERPT_CONTEXT_CHARS = 80;

type ConversationDto = NonNullable<ReturnType<ConversationRepo['get']>>;

type HistoryMessageRow = MessageRow & LinkedTaskProjectionRow;

type AgentSearchMessageRow = HistoryMessageRow & {
  workspace_id: string;
  conversation_kind: ConversationDto['kind'];
  channel_id: string;
};

type ReadHistoryTargetResult =
  | { ok: true; conversation: ConversationDto; threadRootId: string | null }
  | {
      ok: false;
      status: 400 | 403 | 404;
      code: string;
      message: string;
    };

/** Minimal cluster-root lookup for the `{ thread_root_id }` read
 *  form. Returns just the routing fields (no DTO assembly) for a
 *  message id, or `null` when no such message exists. */
function lookupClusterRootMessage(
  ctx: BackendContext,
  messageId: string,
): { id: string; conversation_id: string; thread_root_id: string | null } | null {
  const row = ctx.db
    .prepare<[string], { id: string; conversation_id: string; thread_root_id: string | null }>(
      `SELECT id, conversation_id, thread_root_id FROM messages WHERE id = ?`,
    )
    .get(messageId);
  return row ?? null;
}

export function resolveAgentReadHistoryTarget(
  ctx: BackendContext,
  conversations: ConversationRepo,
  sourceConversation: ConversationDto,
  agentId: string,
  target: ReadHistoryTarget | undefined,
): ReadHistoryTargetResult {
  const requested = target ?? 'self';
  let resolved: ConversationDto | null;
  // Non-null only for the `{ thread_root_id }` reply-cluster form;
  // carries the canonical cluster root id downstream so the DTO
  // builder can scope the listing to root + its replies.
  let threadRootId: string | null = null;
  if (requested === 'self') {
    resolved = sourceConversation;
  } else if ('thread_root_id' in requested) {
    // Reply-cluster read: the value is a *message id*. The cluster
    // lives inside the root message's channel; normalize a reply to
    // its canonical root (symmetry with send-side resolveThreadRoot)
    // so `thread:<reply_id>` reads the whole cluster, not nothing.
    const rootMsg = lookupClusterRootMessage(ctx, requested.thread_root_id);
    if (!rootMsg) {
      return {
        ok: false,
        status: 404,
        code: 'thread_root_not_found',
        message: 'thread root message not found',
      };
    }
    const conversation = conversations.get(rootMsg.conversation_id);
    if (!conversation) {
      return {
        ok: false,
        status: 404,
        code: 'conversation_not_found',
        message: 'conversation not found',
      };
    }
    // Reply clusters are a channel concept. An old isolated-thread
    // conversation does not host clusters — read it via
    // `{ conversation_id }` instead.
    if (conversation.kind !== 'channel' && conversation.kind !== 'dm_channel') {
      return {
        ok: false,
        status: 400,
        code: 'thread_root_not_in_channel',
        message: 'thread root message is not in a channel',
      };
    }
    resolved = conversation;
    threadRootId = rootMsg.thread_root_id ?? rootMsg.id;
  } else {
    // Cross-conversation read by id. The agent must be in
    // `conversation_agents` for the target — workspace-level
    // membership alone is not enough; channel/thread membership is
    // the bottom guard. The check below covers it uniformly.
    const conversation = conversations.get(requested.conversation_id);
    if (!conversation) {
      return {
        ok: false,
        status: 404,
        code: 'conversation_not_found',
        message: 'conversation not found',
      };
    }
    if (
      conversation.kind !== 'channel' &&
      conversation.kind !== 'dm_channel'
    ) {
      return {
        ok: false,
        status: 400,
        code: 'unsupported_conversation_kind',
        message: 'target conversation kind is not readable',
      };
    }
    resolved = conversation;
  }

  if (!conversations.getAgent(resolved.id, agentId)) {
    return {
      ok: false,
      status: 403,
      code: 'not_target_conversation_member',
      message: 'agent is not a member of target conversation',
    };
  }
  return { ok: true, conversation: resolved, threadRootId };
}

function targetRef(
  conversation: ConversationDto,
  threadRootId: string | null,
): ReadHistoryTargetRef {
  return {
    conversation_id: conversation.id,
    conversation_kind: conversation.kind,
    channel_id: conversation.id,
    thread_root_id: threadRootId,
    workspace_id: conversation.workspace_id,
    title: conversation.title,
  };
}

function messageRef(row: MessageRow, target: ReadHistoryTargetRef): MessageRef {
  return {
    id: row.id,
    workspace_id: target.workspace_id,
    conversation_id: target.conversation_id,
    conversation_kind: target.conversation_kind,
    channel_id: target.channel_id,
    seq: row.seq,
    created_at: row.created_at,
  };
}

function snippetFor(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= READ_HISTORY_SNIPPET_MAX_CHARS) return compact;
  return `${compact.slice(0, READ_HISTORY_SNIPPET_MAX_CHARS - 1)}…`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function likeNeedle(query: string): string {
  return `%${escapeLike(query)}%`;
}

function historyRowToMessage(
  row: HistoryMessageRow,
  target: ReadHistoryTargetRef,
  includeContent: boolean,
  reactions: ReactionAggregateDto[] | null,
  author: MessageAuthorDto | null,
): ReadHistoryMessage {
  // Agent-facing authorship rides the SAME server-authoritative resolver as the
  // renderer (`loadMessageAuthors` → `resolveMessageAuthor`); `senderRefFromAuthor`
  // then takes a PURE, no-re-judgement thin projection of that result — no
  // avatar_url/runtime (renderer-only presentation fields that would be a
  // per-row token tax on this stdout surface, up to 100 rows/read). `sender` is
  // null iff the author is null (from_kind='system'). The MessageDto built here
  // is used only for content/metadata/attachments, so its `author` stays null.
  const dto = messageRowToDto(row, {
    author: null,
    linkedTask: linkedTaskFromRow(row),
  });
  return {
    message_ref: messageRef(row, target),
    sender: senderRefFromAuthor(author),
    snippet: snippetFor(dto.content),
    metadata: dto.metadata,
    attachments: dto.attachments,
    reactions,
    ...(includeContent ? { content: dto.content } : {}),
  };
}

function historySystemFilter(includeSystem: boolean): string {
  return includeSystem ? '' : `AND m.from_kind != 'system'`;
}

/** Reply-cluster scope (`docs/thread-reply-cluster-v1.md` §6): when
 *  `threadRootId` is set, restrict a listing to the cluster — the
 *  root message itself (`id = root`) plus every reply
 *  (`thread_root_id = root`). Empty string when null, so every
 *  non-thread read form scopes to the whole conversation unchanged.
 *  `col` is the table alias used by the caller's query (`''` for the
 *  bare-`messages` anchor query). */
function threadScopeClause(threadRootId: string | null, col = 'm'): string {
  if (!threadRootId) return '';
  const prefix = col ? `${col}.` : '';
  return `AND (${prefix}id = ? OR ${prefix}thread_root_id = ?)`;
}

function threadScopeParams(threadRootId: string | null): string[] {
  return threadRootId ? [threadRootId, threadRootId] : [];
}

function historySelectSql(whereSql: string, orderSql: string, limitSql = 'LIMIT ?'): string {
  return `SELECT
            m.*,
            ${LINKED_TASK_SELECT}
          FROM messages m
          ${LINKED_TASK_JOINS}
         WHERE ${whereSql}
         ${orderSql}
         ${limitSql}`;
}

function listHistoryBefore(
  ctx: BackendContext,
  conversationId: string,
  beforeSeq: number,
  includeSystem: boolean,
  limit: number,
  threadRootId: string | null,
): HistoryMessageRow[] {
  if (limit <= 0) return [];
  const rows = ctx.db
    .prepare<(string | number)[], HistoryMessageRow>(
      `SELECT *
         FROM (
           ${historySelectSql(
             `m.conversation_id = ?
              AND m.seq < ?
              ${historySystemFilter(includeSystem)}
              ${threadScopeClause(threadRootId)}`,
             'ORDER BY m.seq DESC',
           )}
         )
        ORDER BY seq ASC`,
    )
    .all(conversationId, beforeSeq, ...threadScopeParams(threadRootId), limit);
  return rows;
}

function listHistoryHead(
  ctx: BackendContext,
  conversationId: string,
  includeSystem: boolean,
  limit: number,
  threadRootId: string | null,
): HistoryMessageRow[] {
  if (limit <= 0) return [];
  return ctx.db
    .prepare<(string | number)[], HistoryMessageRow>(
      `SELECT *
         FROM (
           ${historySelectSql(
             `m.conversation_id = ?
              ${historySystemFilter(includeSystem)}
              ${threadScopeClause(threadRootId)}`,
             'ORDER BY m.seq DESC',
           )}
         )
        ORDER BY seq ASC`,
    )
    .all(conversationId, ...threadScopeParams(threadRootId), limit);
}

function listHistoryAfter(
  ctx: BackendContext,
  conversationId: string,
  afterSeq: number,
  includeSystem: boolean,
  limit: number,
  threadRootId: string | null,
): HistoryMessageRow[] {
  if (limit <= 0) return [];
  return ctx.db
    .prepare<(string | number)[], HistoryMessageRow>(
      historySelectSql(
        `m.conversation_id = ?
         AND m.seq > ?
         ${historySystemFilter(includeSystem)}
         ${threadScopeClause(threadRootId)}`,
        'ORDER BY m.seq ASC',
      ),
    )
    .all(conversationId, afterSeq, ...threadScopeParams(threadRootId), limit);
}

function getHistoryAnchorSeq(
  ctx: BackendContext,
  conversationId: string,
  messageId: string,
  threadRootId: string | null,
): number | null {
  const row = ctx.db
    .prepare<(string | number)[], { seq: number }>(
      `SELECT seq
         FROM messages
        WHERE id = ?
          AND conversation_id = ?
          ${threadScopeClause(threadRootId, '')}`,
    )
    .get(messageId, conversationId, ...threadScopeParams(threadRootId));
  return row?.seq ?? null;
}

function getHistoryRowById(
  ctx: BackendContext,
  conversationId: string,
  messageId: string,
  includeSystem: boolean,
  threadRootId: string | null,
): HistoryMessageRow | null {
  const row = ctx.db
    .prepare<(string | number)[], HistoryMessageRow>(
      historySelectSql(
        `m.id = ?
         AND m.conversation_id = ?
         ${historySystemFilter(includeSystem)}
         ${threadScopeClause(threadRootId)}`,
        '',
        '',
      ),
    )
    .get(messageId, conversationId, ...threadScopeParams(threadRootId));
  return row ?? null;
}

function hasHistoryBefore(
  ctx: BackendContext,
  conversationId: string,
  seq: number,
  includeSystem: boolean,
  threadRootId: string | null,
): boolean {
  return (
    ctx.db
      .prepare<(string | number)[], { found: 1 }>(
        `SELECT 1 AS found
           FROM messages m
          WHERE m.conversation_id = ?
            AND m.seq < ?
            ${historySystemFilter(includeSystem)}
            ${threadScopeClause(threadRootId)}
          LIMIT 1`,
      )
      .get(conversationId, seq, ...threadScopeParams(threadRootId)) !== undefined
  );
}

function hasHistoryAfter(
  ctx: BackendContext,
  conversationId: string,
  seq: number,
  includeSystem: boolean,
  threadRootId: string | null,
): boolean {
  return (
    ctx.db
      .prepare<(string | number)[], { found: 1 }>(
        `SELECT 1 AS found
           FROM messages m
          WHERE m.conversation_id = ?
            AND m.seq > ?
            ${historySystemFilter(includeSystem)}
            ${threadScopeClause(threadRootId)}
          LIMIT 1`,
      )
      .get(conversationId, seq, ...threadScopeParams(threadRootId)) !== undefined
  );
}

export function buildReadHistoryDto(
  ctx: BackendContext,
  targetConversation: ConversationDto,
  input: {
    before_seq?: number;
    after_seq?: number;
    around_message_id?: string;
    include_content: boolean;
    include_system: boolean;
    limit: number;
  },
  threadRootId: string | null = null,
  viewer: ReactionViewer = null,
): AgentReadHistoryDto | { error: string; code: string; status: 404 } {
  const target = targetRef(targetConversation, threadRootId);
  let rows: HistoryMessageRow[];
  let anchor: AgentReadHistoryDto['anchor'];

  if (input.before_seq !== undefined) {
    anchor = { type: 'before_seq', seq: input.before_seq };
    rows = listHistoryBefore(
      ctx,
      targetConversation.id,
      input.before_seq,
      input.include_system,
      input.limit,
      threadRootId,
    );
  } else if (input.after_seq !== undefined) {
    anchor = { type: 'after_seq', seq: input.after_seq };
    rows = listHistoryAfter(
      ctx,
      targetConversation.id,
      input.after_seq,
      input.include_system,
      input.limit,
      threadRootId,
    );
  } else if (input.around_message_id !== undefined) {
    const messageId = input.around_message_id;
    const anchorSeq = getHistoryAnchorSeq(
      ctx,
      targetConversation.id,
      messageId,
      threadRootId,
    );
    if (anchorSeq === null) {
      return {
        error: 'message not found',
        code: 'message_not_found',
        status: 404,
      };
    }
    anchor = { type: 'around_message_id', message_id: messageId };
    const beforeCount = Math.floor((input.limit - 1) / 2);
    const before = listHistoryBefore(
      ctx,
      targetConversation.id,
      anchorSeq,
      input.include_system,
      beforeCount,
      threadRootId,
    );
    const anchorRow = getHistoryRowById(
      ctx,
      targetConversation.id,
      messageId,
      input.include_system,
      threadRootId,
    );
    const afterLimit = Math.max(
      0,
      input.limit - before.length - (anchorRow ? 1 : 0),
    );
    const after = listHistoryAfter(
      ctx,
      targetConversation.id,
      anchorSeq,
      input.include_system,
      afterLimit,
      threadRootId,
    );
    rows = [...before, ...(anchorRow ? [anchorRow] : []), ...after];
  } else {
    anchor = { type: 'head' };
    rows = listHistoryHead(
      ctx,
      targetConversation.id,
      input.include_system,
      input.limit,
      threadRootId,
    );
  }

  const minSeq = rows[0]?.seq ?? null;
  const maxSeq = rows.at(-1)?.seq ?? null;
  // One bulk reaction-aggregate query for the whole window (no N+1), scoped
  // to the calling agent so `viewer_reacted` is the agent's own. Absence in
  // the map → `reactions: null` on that message. Serves the reply-cluster
  // pull form too, since the rows already carry cluster scoping (§12.C).
  const aggregates = loadReactionAggregates(
    ctx,
    rows.map(row => row.id),
    viewer,
  );
  // One batch author-resolve for the whole window (two queries, no N+1) via the
  // single server-authoritative resolver; each row's thin sender projection is
  // taken from this map (system rows resolve to null → sender null).
  const authors = loadMessageAuthors(ctx.db, rows);
  return {
    target,
    anchor,
    limit: input.limit,
    include_content: input.include_content,
    include_system: input.include_system,
    messages: rows.map(row =>
      historyRowToMessage(
        row,
        target,
        input.include_content,
        aggregates.get(row.id) ?? null,
        authors.get(row) ?? null,
      ),
    ),
    has_more_before:
      minSeq === null
        ? false
        : hasHistoryBefore(
            ctx,
            targetConversation.id,
            minSeq,
            input.include_system,
            threadRootId,
          ),
    has_more_after:
      maxSeq === null
        ? false
        : hasHistoryAfter(
            ctx,
            targetConversation.id,
            maxSeq,
            input.include_system,
            threadRootId,
          ),
  };
}

export function listAgentVisibleChannels(
  ctx: BackendContext,
  workspaceId: string,
  agentId: string,
): AgentListChannelsDto {
  // The result is one explicit union of two arms, mirroring the discovery
  // predicate of the human-side `listActiveChannelsForViewer`:
  //   - member arm: conversations the agent has joined — any visibility,
  //     `channel` or `dm_channel`, archived included (sorted last).
  //   - discovery arm: active PUBLIC regular channels the agent has NOT joined
  //     — the browse surface. DMs are never discoverable; archived public
  //     channels have no discovery arm (frozen), matching the human side.
  // Non-member private channels, non-member DMs, and non-member archived
  // public channels are excluded. `is_member` is computed independently from
  // the membership relation (one `EXISTS`), never inferred from which arm a
  // row matched — so a joined public channel is `is_member: true`, not falsely
  // demoted by matching the public predicate first. Discovery grants nothing
  // beyond listing: no roster, messages, unread, search, delivery, restore, or
  // write, and no implicit join.
  const rows = ctx.db
    .prepare<[string, string, string], ConversationDto & { is_member: number }>(
      `SELECT c.*,
              EXISTS (
                SELECT 1 FROM conversation_agents ca
                 WHERE ca.conversation_id = c.id AND ca.agent_id = ?
              ) AS is_member
         FROM conversations c
        WHERE c.workspace_id = ?
          AND (
            (
              c.kind IN ('channel', 'dm_channel')
              AND EXISTS (
                SELECT 1 FROM conversation_agents ca2
                 WHERE ca2.conversation_id = c.id AND ca2.agent_id = ?
              )
            )
            OR (
              c.kind = 'channel'
              AND c.visibility = 'public'
              AND c.archived_at IS NULL
            )
          )
        ORDER BY (c.archived_at IS NOT NULL) ASC,
                 c.updated_at DESC`,
    )
    .all(agentId, workspaceId, agentId);
  return {
    workspace_id: workspaceId,
    channels: rows.map(
      (row): AgentListedChannel => ({
        id: row.id,
        title: row.title,
        kind: row.kind === 'dm_channel' ? 'dm_channel' : 'channel',
        visibility: row.visibility,
        archived: row.archived_at !== null,
        is_member: row.is_member === 1,
        updated_at: row.updated_at,
      }),
    ),
  };
}

function searchMessageRef(row: AgentSearchMessageRow): MessageRef {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    conversation_id: row.conversation_id,
    conversation_kind: row.conversation_kind,
    channel_id: row.channel_id,
    seq: row.seq,
    created_at: row.created_at,
  };
}

function searchExcerptFor(
  content: string,
  query: string,
): { excerpt: string; match_offset: number } {
  const compact = content.replace(/\s+/g, ' ').trim();
  const lower = compact.toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  const matchStart = lower.indexOf(lowerQuery);
  if (matchStart < 0) {
    const excerpt = compact.slice(0, SEARCH_EXCERPT_CONTEXT_CHARS * 2);
    return { excerpt, match_offset: 0 };
  }
  const start = Math.max(0, matchStart - SEARCH_EXCERPT_CONTEXT_CHARS);
  const end = Math.min(
    compact.length,
    matchStart + query.length + SEARCH_EXCERPT_CONTEXT_CHARS,
  );
  const prefix = start > 0 ? '...' : '';
  const suffix = end < compact.length ? '...' : '';
  return {
    excerpt: `${prefix}${compact.slice(start, end)}${suffix}`,
    match_offset: matchStart - start + prefix.length,
  };
}

type SearchMessagesResult =
  | { ok: true; dto: AgentSearchMessagesDto }
  | {
      ok: false;
      status: 400 | 403 | 404;
      code: string;
      message: string;
    };

export function buildAgentSearchMessagesDto(
  ctx: BackendContext,
  conversations: ConversationRepo,
  sourceConversation: ConversationDto,
  agentId: string,
  input: {
    q: string;
    scope: 'current' | 'workspace' | 'channel';
    workspace_id?: string;
    channel_id?: string;
    include_system: boolean;
    limit: number;
  },
): SearchMessagesResult {
  const where: string[] = [`m.content LIKE ? ESCAPE '\\'`];
  const params: Array<string | number> = [likeNeedle(input.q)];
  let channelId: string | null = null;
  let workspaceId: string | null = null;

  if (!input.include_system) {
    where.push(`m.from_kind != 'system'`);
  }

  if (input.scope === 'current') {
    where.push(`conv.id = ?`);
    params.push(sourceConversation.id);
  } else if (input.scope === 'workspace') {
    // Cross-workspace handled by the route before we get here:
    // `canAgentAccessWorkspace` already gated `input.workspace_id`
    // when it differs from `sourceConversation.workspace_id`. Here we
    // just pick the SQL filter; the conversation_agents JOIN below
    // remains the bottom guard so unjoined channels in the target
    // workspace stay invisible.
    workspaceId = input.workspace_id ?? sourceConversation.workspace_id;
    where.push(`conv.workspace_id = ?`);
    params.push(workspaceId);
  } else {
    channelId = input.channel_id ?? null;
    if (!channelId) {
      return {
        ok: false,
        status: 400,
        code: 'channel_id_required',
        message: 'channel_id is required for channel scope',
      };
    }
    const channel = conversations.getChannelLike(channelId);
    if (!channel) {
      return {
        ok: false,
        status: 404,
        code: 'channel_not_found',
        message: 'channel not found',
      };
    }
    // channel_id is globally unique. PR-B made list_channels return
    // channels from any workspace the agent has access to, so the
    // bottom guard is conversation-membership, not source-workspace
    // identity.
    if (!conversations.getAgent(channel.id, agentId)) {
      return {
        ok: false,
        status: 403,
        code: 'not_channel_member',
        message: 'agent is not a member of this channel',
      };
    }
    where.push(`conv.id = ?`);
    params.push(channel.id);
  }

  const sqlParams: Array<string | number> = [agentId, ...params, input.limit];
  const rows = ctx.db
    .prepare<Array<string | number>, AgentSearchMessageRow>(
      `SELECT
          m.*,
          ${LINKED_TASK_SELECT},
          conv.workspace_id AS workspace_id,
          conv.kind AS conversation_kind,
          conv.id AS channel_id
         FROM messages m
         JOIN conversations conv ON conv.id = m.conversation_id
         JOIN conversation_agents ca
           ON ca.conversation_id = conv.id
          AND ca.agent_id = ?
         ${LINKED_TASK_JOINS}
        WHERE ${where.join(' AND ')}
        ORDER BY m.created_at DESC, m.seq DESC
        LIMIT ?`,
    )
    .all(...sqlParams);

  const authors = loadMessageAuthors(ctx.db, rows);
  return {
    ok: true,
    dto: {
      query: input.q,
      scope: input.scope,
      workspace_id: workspaceId,
      channel_id: channelId,
      include_system: input.include_system,
      limit: input.limit,
      hits: rows.map((row): AgentSearchMessageHit => {
        const excerpt = searchExcerptFor(row.content, input.q);
        return {
          message_ref: searchMessageRef(row),
          sender: senderRefFromAuthor(authors.get(row) ?? null),
          excerpt: excerpt.excerpt,
          match_offset: excerpt.match_offset,
        };
      }),
    },
  };
}
