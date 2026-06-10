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
import { messageRowToDto } from '../repos/message-repo.js';
import type {
  AgentListChannelsDto,
  AgentListedChannel,
  AgentReadHistoryDto,
  AgentSearchMessageHit,
  AgentSearchMessagesDto,
  MessageRef,
  MessageRow,
  MessageSenderRef,
  ReadHistoryMessage,
  ReadHistoryTarget,
  ReadHistoryTargetRef,
} from '@silverhand/shared';


const READ_HISTORY_SNIPPET_MAX_CHARS = 160;
const SEARCH_EXCERPT_CONTEXT_CHARS = 80;

type ConversationDto = NonNullable<ReturnType<ConversationRepo['get']>>;

type HistoryMessageRow = MessageRow & {
  task_assignee_name: string | null;
  sender_agent_name: string | null;
};

type AgentSearchMessageRow = HistoryMessageRow & {
  workspace_id: string;
  conversation_kind: ConversationDto['kind'];
  channel_id: string;
  thread_id: string | null;
};

type ReadHistoryTargetResult =
  | { ok: true; conversation: ConversationDto }
  | {
      ok: false;
      status: 400 | 403 | 404;
      code: string;
      message: string;
    };

export function resolveAgentReadHistoryTarget(
  conversations: ConversationRepo,
  sourceConversation: ConversationDto,
  agentId: string,
  target: ReadHistoryTarget | undefined,
): ReadHistoryTargetResult {
  const requested = target ?? 'self';
  let resolved: ConversationDto | null;
  if (requested === 'self') {
    resolved = sourceConversation;
  } else if (requested === 'parent') {
    if (!sourceConversation.parent_conversation_id) {
      return {
        ok: false,
        status: 400,
        code: 'no_parent',
        message: 'no parent channel',
      };
    }
    resolved = conversations.get(sourceConversation.parent_conversation_id);
    if (!resolved) {
      return {
        ok: false,
        status: 404,
        code: 'parent_not_found',
        message: 'parent channel not found',
      };
    }
  } else if ('thread_id' in requested) {
    const thread = conversations.getThread(requested.thread_id);
    if (!thread) {
      return {
        ok: false,
        status: 404,
        code: 'thread_not_found',
        message: 'thread not found',
      };
    }
    if (thread.parent_conversation_id !== sourceConversation.id) {
      return {
        ok: false,
        status: 400,
        code: 'thread_not_child',
        message: 'target is not a direct thread of current channel',
      };
    }
    resolved = thread;
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
      conversation.kind !== 'dm_channel' &&
      conversation.kind !== 'thread'
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
  return { ok: true, conversation: resolved };
}

function targetRef(conversation: ConversationDto): ReadHistoryTargetRef {
  return {
    conversation_id: conversation.id,
    conversation_kind: conversation.kind,
    channel_id:
      conversation.kind === 'thread'
        ? conversation.parent_conversation_id ?? conversation.id
        : conversation.id,
    thread_id: conversation.kind === 'thread' ? conversation.id : null,
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
    thread_id: target.thread_id,
    seq: row.seq,
    created_at: row.created_at,
  };
}

function senderRef(row: HistoryMessageRow): MessageSenderRef {
  return {
    kind: row.from_kind,
    agent_id: row.from_agent_id,
    user_id: row.from_user_id,
    display_name:
      row.from_kind === 'agent'
        ? row.sender_agent_name ?? row.from_agent_id
        : row.from_kind === 'user'
          ? row.from_user_id
          : null,
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
): ReadHistoryMessage {
  const dto = messageRowToDto(row, { assigneeName: row.task_assignee_name });
  return {
    message_ref: messageRef(row, target),
    sender: senderRef(row),
    snippet: snippetFor(dto.content),
    metadata: dto.metadata,
    attachments: dto.attachments,
    ...(includeContent ? { content: dto.content } : {}),
  };
}

function historySystemFilter(includeSystem: boolean): string {
  return includeSystem ? '' : `AND m.from_kind != 'system'`;
}

function historySelectSql(whereSql: string, orderSql: string, limitSql = 'LIMIT ?'): string {
  return `SELECT
            m.*,
            assignee.display_name AS task_assignee_name,
            sender.display_name AS sender_agent_name
          FROM messages m
          LEFT JOIN agents assignee ON assignee.id = m.task_assignee_agent_id
          LEFT JOIN agents sender ON sender.id = m.from_agent_id
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
): HistoryMessageRow[] {
  if (limit <= 0) return [];
  const rows = ctx.db
    .prepare<[string, number, number], HistoryMessageRow>(
      `SELECT *
         FROM (
           ${historySelectSql(
             `m.conversation_id = ?
              AND m.seq < ?
              ${historySystemFilter(includeSystem)}`,
             'ORDER BY m.seq DESC',
           )}
         )
        ORDER BY seq ASC`,
    )
    .all(conversationId, beforeSeq, limit);
  return rows;
}

function listHistoryAfter(
  ctx: BackendContext,
  conversationId: string,
  afterSeq: number,
  includeSystem: boolean,
  limit: number,
): HistoryMessageRow[] {
  if (limit <= 0) return [];
  return ctx.db
    .prepare<[string, number, number], HistoryMessageRow>(
      historySelectSql(
        `m.conversation_id = ?
         AND m.seq > ?
         ${historySystemFilter(includeSystem)}`,
        'ORDER BY m.seq ASC',
      ),
    )
    .all(conversationId, afterSeq, limit);
}

function getHistoryAnchorSeq(
  ctx: BackendContext,
  conversationId: string,
  messageId: string,
): number | null {
  const row = ctx.db
    .prepare<[string, string], { seq: number }>(
      `SELECT seq
         FROM messages
        WHERE id = ?
          AND conversation_id = ?`,
    )
    .get(messageId, conversationId);
  return row?.seq ?? null;
}

function getHistoryRowById(
  ctx: BackendContext,
  conversationId: string,
  messageId: string,
  includeSystem: boolean,
): HistoryMessageRow | null {
  const row = ctx.db
    .prepare<[string, string], HistoryMessageRow>(
      historySelectSql(
        `m.id = ?
         AND m.conversation_id = ?
         ${historySystemFilter(includeSystem)}`,
        '',
        '',
      ),
    )
    .get(messageId, conversationId);
  return row ?? null;
}

function hasHistoryBefore(
  ctx: BackendContext,
  conversationId: string,
  seq: number,
  includeSystem: boolean,
): boolean {
  return (
    ctx.db
      .prepare<[string, number], { found: 1 }>(
        `SELECT 1 AS found
           FROM messages m
          WHERE m.conversation_id = ?
            AND m.seq < ?
            ${historySystemFilter(includeSystem)}
          LIMIT 1`,
      )
      .get(conversationId, seq) !== undefined
  );
}

function hasHistoryAfter(
  ctx: BackendContext,
  conversationId: string,
  seq: number,
  includeSystem: boolean,
): boolean {
  return (
    ctx.db
      .prepare<[string, number], { found: 1 }>(
        `SELECT 1 AS found
           FROM messages m
          WHERE m.conversation_id = ?
            AND m.seq > ?
            ${historySystemFilter(includeSystem)}
          LIMIT 1`,
      )
      .get(conversationId, seq) !== undefined
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
): AgentReadHistoryDto | { error: string; code: string; status: 404 } {
  const target = targetRef(targetConversation);
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
    );
  } else if (input.after_seq !== undefined) {
    anchor = { type: 'after_seq', seq: input.after_seq };
    rows = listHistoryAfter(
      ctx,
      targetConversation.id,
      input.after_seq,
      input.include_system,
      input.limit,
    );
  } else {
    const messageId = input.around_message_id!;
    const anchorSeq = getHistoryAnchorSeq(ctx, targetConversation.id, messageId);
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
    );
    const anchorRow = getHistoryRowById(
      ctx,
      targetConversation.id,
      messageId,
      input.include_system,
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
    );
    rows = [...before, ...(anchorRow ? [anchorRow] : []), ...after];
  }

  const minSeq = rows[0]?.seq ?? null;
  const maxSeq = rows.at(-1)?.seq ?? null;
  return {
    target,
    anchor,
    limit: input.limit,
    include_content: input.include_content,
    include_system: input.include_system,
    messages: rows.map(row =>
      historyRowToMessage(row, target, input.include_content),
    ),
    has_more_before:
      minSeq === null
        ? false
        : hasHistoryBefore(
            ctx,
            targetConversation.id,
            minSeq,
            input.include_system,
          ),
    has_more_after:
      maxSeq === null
        ? false
        : hasHistoryAfter(
            ctx,
            targetConversation.id,
            maxSeq,
            input.include_system,
          ),
  };
}

export function listAgentVisibleChannels(
  ctx: BackendContext,
  workspaceId: string,
  agentId: string,
): AgentListChannelsDto {
  const rows = ctx.db
    .prepare<[string, string], ConversationDto>(
      `SELECT c.*
         FROM conversations c
         JOIN conversation_agents ca
           ON ca.conversation_id = c.id
          AND ca.agent_id = ?
        WHERE c.workspace_id = ?
          AND c.kind IN ('channel', 'dm_channel')
        ORDER BY (c.archived_at IS NOT NULL) ASC,
                 (c.pinned_at IS NOT NULL) DESC,
                 c.pinned_at DESC,
                 c.updated_at DESC`,
    )
    .all(agentId, workspaceId);
  return {
    workspace_id: workspaceId,
    channels: rows.map(
      (row): AgentListedChannel => ({
        id: row.id,
        title: row.title,
        kind: row.kind === 'dm_channel' ? 'dm_channel' : 'channel',
        archived: row.archived_at !== null,
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
    thread_id: row.thread_id,
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
    // identity. The SQL `JOIN conversation_agents` below still
    // filters child threads by per-conversation membership.
    if (!conversations.getAgent(channel.id, agentId)) {
      return {
        ok: false,
        status: 403,
        code: 'not_channel_member',
        message: 'agent is not a member of this channel',
      };
    }
    where.push(`(conv.id = ? OR conv.parent_conversation_id = ?)`);
    params.push(channel.id, channel.id);
  }

  const sqlParams: Array<string | number> = [agentId, ...params, input.limit];
  const rows = ctx.db
    .prepare<Array<string | number>, AgentSearchMessageRow>(
      `SELECT
          m.*,
          assignee.display_name AS task_assignee_name,
          sender.display_name AS sender_agent_name,
          conv.workspace_id AS workspace_id,
          conv.kind AS conversation_kind,
          CASE WHEN conv.kind = 'thread' THEN conv.parent_conversation_id ELSE conv.id END
            AS channel_id,
          CASE WHEN conv.kind = 'thread' THEN conv.id ELSE NULL END AS thread_id
         FROM messages m
         JOIN conversations conv ON conv.id = m.conversation_id
         JOIN conversation_agents ca
           ON ca.conversation_id = conv.id
          AND ca.agent_id = ?
         LEFT JOIN agents assignee ON assignee.id = m.task_assignee_agent_id
         LEFT JOIN agents sender ON sender.id = m.from_agent_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.created_at DESC, m.seq DESC
        LIMIT ?`,
    )
    .all(...sqlParams);

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
          sender: senderRef(row),
          excerpt: excerpt.excerpt,
          match_offset: excerpt.match_offset,
        };
      }),
    },
  };
}
