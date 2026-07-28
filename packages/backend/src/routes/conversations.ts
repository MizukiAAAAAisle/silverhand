// This file owns the broad conversation context: conversation lifecycle /
// metadata, message send / read / window, unread, saved / search,
// threads, and per-conversation runtime control. MESSAGE is a co-located
// sub-context here (a message belongs to a conversation; every handler shares
// the same `conversations.get*` + ACL prelude) — kept visually separate by
// section banners rather than a separate routes/messages.ts.
//
// These routes are not contiguous in createApiRouter because membership and
// attachment sub-apps sit between them, so this file exports one factory per
// mount-run. Auth/principal is inherited from the parent api app middleware.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  apiPaths,
  ArchiveChannelInputSchema,
  ConversationLogDebugInputSchema,
  decodeMessageSeq,
  normalizeAttachmentRefs,
  ReactMessageInputSchema,
  SavedMessagesQueryInputSchema,
  SearchQueryInputSchema,
  UpdateChannelInputSchema,
  SendMessageInputSchema,
  TEMP_CONVERSATION_DEBUG_WINDOW_MS,
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_MESSAGE_CONTENT_LABEL,
  MESSAGE_SEND_MAX_BODY_BYTES,
  messageContentByteLength,
  messageContentExceedsLimit,
} from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { ConversationReadRepo } from '../repos/conversation-read-repo.js';
import type { SavedMessageRepo } from '../repos/saved-message-repo.js';
import type { SortRepo } from '../repos/sort-repo.js';
import type { SearchRepo } from '../repos/search-repo.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { MessageReactionRepo } from '../repos/message-reaction-repo.js';
import type { ConversationEventRepo } from '../repos/conversation-event-repo.js';
import { getUserPrincipal, requireViewerUserId } from '../auth/principal.js';
import {
  canEditAgent,
  canGovernWorkspace,
  canPostToConversation,
  canReadConversation,
  canViewConversation,
  canViewOwnedState,
  canViewWorkspace,
} from '../permissions.js';
import { timedRouteSpan } from '../observability/route-span.js';
import { AnchorMessageNotInConversationError, InvalidThreadsCursorError } from '../repos/message-repo.js';
import { addReaction, removeReaction } from '../application/react-message.js';
import { buildChannelDetailResponse } from '../application/conversation-member.js';
import { loadReactionAggregates, loadReactionDetail } from '../read-model/message-reactions.js';
import {
  channelServiceErrorResponse,
  conversationMessageServiceErrorResponse,
  placementErrorResponse,
  reactionResultResponse,
  runtimeStartErrorResponse,
} from './responses.js';
import {
  ClearSessionExitTimeoutError,
  ClearSessionInProgressError,
} from '../runtime/agent-runtime-host.js';
import { parseMessagesWindowQuery } from './message-window.js';

// ── Mount-run A: conversation read / metadata ──────────────────────────────
// message-unread (workspace / summary / channel), conversation message window,
// conversation/thread/ref identity, conversation log-debug (GET + POST). Mounted
// between the capability sub-app and the conversation-membership sub-app.
export interface ConversationReadRouteDeps {
  ctx: BackendContext;
  conversations: ConversationRepo;
  workspaces: WorkspaceRepo;
  messages: MessageRepo;
  conversationReads: ConversationReadRepo;
}

export function createConversationReadApp(
  deps: ConversationReadRouteDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, conversations, workspaces, messages, conversationReads } = deps;

  app.get('/api/workspaces/:id/message-unread', c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canViewWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const viewerUserId = requireViewerUserId(c);
    const unread = timedRouteSpan(
      ctx,
      'workspace.message_unread.counts',
      { workspaceId: workspace.id, viewerUserId },
      () =>
        conversationReads.unreadCountsByConversationForWorkspace(
          workspace.id,
          viewerUserId,
        ),
      result => ({
        conversationCount: Object.keys(result.by_conversation).length,
        total: result.total,
      }),
    );
    return c.json(unread);
  });

  app.get(apiPaths.messageUnreadSummary, c => {
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const byWorkspace = timedRouteSpan(
      ctx,
      'workspace.message_unread.summary',
      { viewerUserId },
      () => conversationReads.unreadCountsByWorkspaceSidebar(viewerUserId),
      result => ({ scopeCount: Object.keys(result).length }),
    );
    return c.json({
      by_workspace: byWorkspace,
    });
  });

  app.get('/api/channels/:id/message-unread', c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const count = timedRouteSpan(
      ctx,
      'conversation.message_unread.count',
      { conversationId: channel.id, viewerUserId },
      () =>
        conversationReads.unreadCountForConversation(
          channel.id,
          viewerUserId,
        ),
    );
    const latest = conversationReads.latestUnreadForConversation(
      channel.id,
      viewerUserId,
    );
    return c.json({
      by_conversation: { [channel.id]: count },
      latest_by_conversation: latest ? { [channel.id]: latest } : {},
      total: count,
    });
  });

  app.get(apiPaths.conversationChannelMessages(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    // PUBLIC-aware read gate: message history (incl. thread content read via
    // `thread_root_id` below) is a pure read, so a workspace member browsing a
    // public channel may fetch it without joining. `canReadConversation` widens
    // ONLY for active public regular channels + user principals; every write
    // path (post/react/save/follow) stays on strict `canViewConversation`.
    if (!canReadConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const parsed = parseMessagesWindowQuery(c);
    if (!parsed.ok) return parsed.response;
    const { limit, beforeSeq, afterSeq, aroundMessageId } = parsed;
    const requestedThreadRootId = c.req.query('thread_root_id');
    let threadRootId: string | null = null;
    if (requestedThreadRootId !== undefined) {
      if (requestedThreadRootId.length === 0) {
        return c.json(
          {
            error: 'thread_root_id must be a non-empty message id',
            code: 'invalid_thread_root_id',
          },
          400,
        );
      }
      const rootMessage = messages.getById(requestedThreadRootId);
      if (!rootMessage) {
        return c.json(
          {
            error: 'thread root message not found',
            code: 'thread_root_not_found',
          },
          404,
        );
      }
      if (rootMessage.conversation_id !== channel.id) {
        return c.json(
          {
            error: 'thread root message not found in this channel',
            code: 'thread_root_not_found',
          },
          404,
        );
      }
      threadRootId = rootMessage.thread_root_id ?? rootMessage.id;
    }
    try {
      const window = timedRouteSpan(
        ctx,
        'conversation.messages.window',
        {
          conversationId: channel.id,
          kind: channel.kind,
          limit,
          beforeSeq,
          afterSeq,
          aroundMessageId,
          threadRootId,
        },
        () => {
          const opts = { limit, beforeSeq, afterSeq, aroundMessageId };
          // Open-time snapshot (#task:1226). Capture the opened stream's head
          // as of THIS read: the backend is the single synchronous writer, so no
          // insert interleaves between the head read and the window read (they
          // share one logical snapshot), and capturing head BEFORE the window
          // means the snapshot is the open-time head — a CONCURRENT reply landing
          // after this capture gets seq > snapshot and is therefore not swallowed
          // by a later `observe()` at_seq to this value. (stream_head_seq is
          // window-independent; under v1 read-to-clear-whole-opened-thread the
          // guarantee is "no concurrent-tail swallow", NOT "covers the rendered
          // window tail" — an around-first-unread window may render less than the
          // head. See docs/thread-unread-v1.md §6/§8.) Must be captured here, in
          // the same read — not re-queried at mark-time, which is the swallow bug.
          const streamHeadSeq = messages.streamHeadLatestSeq(
            channel.id,
            threadRootId,
          );
          const window = threadRootId
            ? messages.listWindowForThreadCluster(channel.id, threadRootId, opts)
            : messages.listWindowForMainStream(channel.id, opts);
          // Enrich each message with the viewer's reaction aggregates in one
          // bulk query (no N+1, §6). Viewer = the human reading the window, so
          // `viewer_reacted` is that user's. Reactor identities stay off this
          // payload (lazy hover endpoint).
          //
          // Public-read neutralization: a non-member browsing a PUBLIC channel
          // reaches this window via `canReadConversation`, but per-viewer state
          // is not theirs to see. Reaction COUNT is a pure read fact (kept), but
          // `viewer_reacted` is a personal relation — same class as unread /
          // follow / read-state — so a non-member reads it as `false`. Passing a
          // `null` viewer makes that structural (no `(kind,id)` ever matches), so
          // even a stray reactor row for a since-removed member reads false.
          const viewerUserId = requireViewerUserId(c);
          const isMember =
            conversations.getUser(channel.id, viewerUserId) !== null;
          const aggregates = loadReactionAggregates(
            ctx,
            window.messages.map(message => message.id),
            isMember ? { kind: 'user', id: viewerUserId } : null,
          );
          const messagesWithReactions = window.messages.map(message => ({
            ...message,
            reactions: aggregates.get(message.id) ?? null,
            // `linked_task` is a conversation-visible READ projection (source↔task
            // linkage + title/status/assignee snapshot), NOT member-gated: on a
            // PUBLIC channel every reader — member or not — sees the same task
            // chip. Visibility follows channel read access (public → uniform;
            // private → members only, and a private non-member never reaches this
            // window). The member boundary is the MUTATION axis (status picker is
            // write — the renderer fail-closes it for non-members; Join is the
            // entry to the writable state) plus the cross-channel task-board
            // fanout (per-viewer, member-only) — NOT this read projection.
            // `viewer_reacted` stays neutralized above: it's a PERSONAL relation,
            // a different class.
          }));
          const rootIds = messagesWithReactions
            .filter(
              message =>
                message.thread_root_id === null && message.from_kind !== 'system',
            )
            .map(message => message.id);
          return {
            ...window,
            // DB-read decode boundary (docs/brand-typed-seq-v1.md §4.1): the
            // wire field is a MessageSeq, so brand it here at server-side DTO
            // construction. The renderer's `api<T>()` is a typed trust boundary
            // (no runtime schema-parse), so the brand MUST be minted server-side
            // — never left to a client cast.
            stream_head_seq: decodeMessageSeq(streamHeadSeq),
            messages: messagesWithReactions,
            reply_counts_by_root: messages.replyCountsByRoot(channel.id, rootIds),
            reply_summaries_by_root: messages.replyBadgeSummariesByRoot(
              channel.id,
              rootIds,
            ),
          };
        },
        result => ({
          messageCount: result.messages.length,
          replyCountRootCount: Object.keys(result.reply_counts_by_root).length,
          hasMoreBefore: result.has_more_before,
          hasMoreAfter: result.has_more_after,
        }),
      );
      return c.json(window);
    } catch (err) {
      if (err instanceof AnchorMessageNotInConversationError) {
        return c.json(
          {
            error: 'around_message_id not found in this conversation',
            code: 'message_not_found',
          },
          404,
        );
      }
      throw err;
    }
  });

  app.get(apiPaths.conversationChannel(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    // PUBLIC-aware read gate: channel identity/detail is a pure read (see the
    // messages route). A workspace member may resolve a public channel's detail
    // before joining; strict `canViewConversation` still guards every mutation.
    const principal = getUserPrincipal(c);
    if (!canReadConversation(ctx, principal, channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // Authoritative per-viewer membership + settings-modal capability carriers.
    // A public-channel non-member reads detail with `is_member: false` (renderer
    // shows Join, not the composer); the renderer must NOT reverse-infer
    // membership from the read succeeding. `can_leave` / `leave_blocked_reason`
    // / `can_update_visibility` are advisory display for the settings modal —
    // the write paths stay authoritative (§12.1#5).
    return c.json(buildChannelDetailResponse(ctx, conversations, principal, channel));
  });

  /**
   * GET /api/conversations/:id/ref
   *
   * Identity + routing metadata for any conversation (channel /
   * dm_channel) by id. Designed to back cross-workspace
   * secondary-pane resolution and the `#conv:<id>` sigil renderer (PR-3).
   *
   * Permission: `canReadConversation` — the SAME public-aware read gate as
   * channel detail + message history, deliberately not the stricter
   * `canViewConversation`. A ref is the identity of a conversation the
   * caller may already read: gating it more narrowly than the read it
   * serves made every `#conv:` chip and `?side` pane answer
   * "unauthorized" for an active public channel whose full history the
   * main pane happily renders. Net widening is exactly "active + public +
   * same workspace + not a channel member" — private, ARCHIVED public,
   * non-workspace and non-participant `dm_channel` all stay 403 (see
   * `isPublicChannelBranch`). The route is user-facing only (no
   * `/internal` twin), so agent principals never reach it — and the
   * public branch is user-only anyway. Do NOT generalise to agents
   * without a dedicated ACL helper.
   *
   * Response intentionally excludes messages and per-user unread
   * state — those go through the existing window/cursor endpoints.
   * `workspace_kind` is projected `agent_home → 'dm'` so the
   * renderer never sees a third kind.
   */
  app.get(apiPaths.conversationRef(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'conversation id required' }, 400);
    const conversation = conversations.get(id);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (!canReadConversation(ctx, getUserPrincipal(c), conversation.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const workspace = workspaces.get(conversation.workspace_id);
    if (!workspace) return c.json({ error: 'conversation not found' }, 404);

    const ref = {
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      workspace_id: conversation.workspace_id,
      // External projection: agents see `agent_home` internally; users
      // see `dm`. The renderer/UI uses regular|dm exclusively.
      workspace_kind:
        workspace.workspace_kind === 'agent_home'
          ? ('dm' as const)
          : ('regular' as const),
      workspace_path: conversation.workspace_path,
      closed_at: conversation.closed_at,
      archived_at: conversation.archived_at,
    };
    return c.json({ ref });
  });

  app.get(apiPaths.conversationLogDebug(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'conversation id required' }, 400);
    const conversation = conversations.get(id);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), conversation.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const status = ctx.logControl.getConversationDebugStatus(conversation.id);
    return c.json({
      conversationId: conversation.id,
      enabled: status.enabled,
      expiresAt: status.expiresAt,
    });
  });

  app.post(apiPaths.conversationLogDebug(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'conversation id required' }, 400);
    const conversation = conversations.get(id);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    const principal = getUserPrincipal(c);
    if (!canViewConversation(ctx, principal, conversation.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ConversationLogDebugInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    let expiresAt: number | null = null;
    if (parsed.data.enabled) {
      expiresAt = Date.now() + TEMP_CONVERSATION_DEBUG_WINDOW_MS;
      ctx.logControl.enableConversationDebug(conversation.id, expiresAt);
    } else {
      ctx.logControl.disableConversationDebug(conversation.id);
    }

    let daemonSynced = true;
    try {
      await ctx.runtimeHost.setConversationLogDebug(
        conversation.id,
        parsed.data.enabled,
        expiresAt,
      );
    } catch (err) {
      daemonSynced = false;
      ctx.logger.warn(
        { conversationId: conversation.id, err },
        'conversation log debug: daemon sync failed',
      );
    }

    ctx.logger.info(
      {
        conversationId: conversation.id,
        enabled: parsed.data.enabled,
        expiresAt,
        daemonSynced,
        actorUserId: principal.userId,
      },
      'conversation log debug window updated',
    );
    return c.json({
      conversationId: conversation.id,
      enabled: parsed.data.enabled,
      expiresAt,
      daemonSynced,
    });
  });

  return app;
}

// ── Mount-run B: conversation messaging / threads / saved-list ─────────────
// thread message window, channel/thread agents + run-states, pin / archive,
// channel/thread message send, channel threads
// summary, saved list. Mounted between the conversation-membership sub-app and
// the attachment sub-app.
export interface ConversationMessagingRouteDeps {
  ctx: BackendContext;
  conversations: ConversationRepo;
  workspaces: WorkspaceRepo;
  messages: MessageRepo;
  conversationReads: ConversationReadRepo;
  conversationEvents: ConversationEventRepo;
  saved: SavedMessageRepo;
  sort: SortRepo;
}

export function createConversationMessagingApp(
  deps: ConversationMessagingRouteDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const {
    ctx,
    conversations,
    workspaces,
    messages,
    conversationReads,
    conversationEvents,
    saved,
  } = deps;

  app.get(apiPaths.conversationThreads(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    // `getChannelLike` resolves channel / dm_channel only — a legacy
    // `kind='thread'` conversation returns null here, so this list never
    // revives a legacy thread conversation; threads are reply-clusters
    // within the channel.
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // Per-viewer unread / first-unread / follow state (#task:1226). This route is
    // already user-only (getUserPrincipal above), so a viewer user id is present.
    const viewerUserId = requireViewerUserId(c);

    let limit = 30;
    const limitRaw = c.req.query('limit');
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1) {
        return c.json({ error: 'invalid limit', code: 'invalid_limit' }, 400);
      }
      limit = Math.min(50, n);
    }
    const cursor = c.req.query('cursor') ?? null;

    try {
      const page = timedRouteSpan(
        ctx,
        'conversation.threads.list',
        { conversationId: channel.id, kind: channel.kind, limit },
        () => messages.listChannelThreads(channel.id, viewerUserId, { limit, cursor }),
        result => ({
          threadCount: result.threads.length,
          hasMore: result.next_cursor != null,
        }),
      );
      return c.json(page);
    } catch (err) {
      if (err instanceof InvalidThreadsCursorError) {
        return c.json({ error: 'invalid cursor', code: 'invalid_cursor' }, 400);
      }
      throw err;
    }
  });

  // Per-conversation per-viewer stream-unread read-model (#task:1226). The
  // SINGLE client source of truth for the reply chip + Threads list "N new" /
  // first-unread — both read this (keyed by root), so the same server-scored
  // fact never lives in two caches that drift. Unread can't be optimistically
  // derived on the client, so it lives OUTSIDE the message-window cache and is
  // settled from REST after the viewer-scoped `unread_updated` WS signal or a
  // local observe() success. Human
  // viewer-scoped; reads `thread_followers` for nothing here (display is
  // follow-agnostic) and never writes follow/delivery (attention ⊥ delivery).
  app.get(apiPaths.conversationUnread(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const viewerUserId = requireViewerUserId(c);
    const unread = timedRouteSpan(
      ctx,
      'conversation.stream_unread',
      { conversationId: channel.id, kind: channel.kind },
      () => conversationReads.streamUnreadForConversation(channel.id, viewerUserId),
      result => ({
        mainlineUnread: result.mainline.unread_count,
        threadCount: Object.keys(result.threads).length,
      }),
    );
    return c.json(unread);
  });

  app.get(apiPaths.conversationChannelAgents(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const channelAgents = timedRouteSpan(
      ctx,
      'conversation.agents.list',
      { conversationId: channel.id, kind: channel.kind },
      () => conversations.listAgents(channel.id),
      result => ({ agentCount: result.length }),
    );
    return c.json({ agents: channelAgents });
  });

  app.patch(apiPaths.channelArchive(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const conversation = conversations.get(id);
    if (!conversation) return c.json({ error: 'channel not found' }, 404);
    if (!canGovernWorkspace(ctx, getUserPrincipal(c), conversation.workspace_id, 'admin')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ArchiveChannelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    try {
      const result = await ctx.channelService.setArchived({
        channelId: id,
        archived: parsed.data.archived,
      });
      return c.json({ channel: result.channel });
    } catch (err) {
      const mapped = channelServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // Update a top-level channel's title OR visibility (EXACTLY ONE per request —
  // the schema rejects both/neither). Both mutations share the workspace `admin`
  // gate (agents fail `canGovernWorkspace`, so `public` stays human-only) and
  // the same error mapping; the service owns each write + its post-commit
  // broadcast. Splitting the dispatch here (not a combined service call) keeps
  // each mutation atomic — there is no half-committed title+visibility state.
  app.patch(apiPaths.conversationChannel(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const conversation = conversations.get(id);
    if (!conversation) return c.json({ error: 'channel not found' }, 404);
    const principal = getUserPrincipal(c);
    if (!canGovernWorkspace(ctx, principal, conversation.workspace_id, 'admin')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateChannelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    try {
      const result = parsed.data.visibility !== undefined
        ? await ctx.channelService.setChannelVisibility({
            channelId: id,
            visibility: parsed.data.visibility,
            actor: principal,
          })
        : await ctx.channelService.renameChannel({
            channelId: id,
            // `title` is present whenever `visibility` is absent (schema
            // exactly-one refinement).
            title: parsed.data.title as string,
          });
      return c.json({ channel: result.channel });
    } catch (err) {
      const mapped = channelServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.get(apiPaths.channelAgentRunStates(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const states = timedRouteSpan(
      ctx,
      'conversation.agent_run_states.snapshot',
      { conversationId: channel.id, kind: channel.kind },
      () => ctx.runtimeHost.getAgentRunStates(channel.id),
      result => ({ stateCount: result.length }),
    );
    return c.json({ states });
  });

  app.get(apiPaths.conversationAgentActivity(':id', ':aid'), c => {
    const id = c.req.param('id');
    const agentId = c.req.param('aid');
    if (!id || !agentId) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const conversation = conversations.get(id);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), conversation.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!conversations.getAgent(conversation.id, agentId)) {
      return c.json({ error: 'agent is not a member of this conversation' }, 404);
    }

    let limit = 100;
    const limitRaw = c.req.query('limit');
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1) {
        return c.json({ error: 'invalid limit', code: 'invalid_limit' }, 400);
      }
      limit = Math.min(200, n);
    }

    let beforeId: number | null = null;
    const beforeIdRaw = c.req.query('before_id');
    if (beforeIdRaw !== undefined) {
      const n = Number(beforeIdRaw);
      if (!Number.isInteger(n) || n < 1) {
        return c.json({ error: 'invalid before_id', code: 'invalid_before_id' }, 400);
      }
      beforeId = n;
    }

    const page = timedRouteSpan(
      ctx,
      'conversation.activity.list',
      { conversationId: conversation.id, agentId, limit, beforeId },
      () =>
        conversationEvents.listForConversationAgent({
          conversationId: conversation.id,
          agentId,
          limit,
          beforeId,
        }),
      result => ({
        eventCount: result.events.length,
        hasMore: result.next_before_id != null,
      }),
    );
    return c.json(page);
  });

  app.get(apiPaths.channelThreadFollowers(':id', ':rootMessageId'), c => {
    const id = c.req.param('id');
    const rootMessageId = c.req.param('rootMessageId');
    if (!id || !rootMessageId) {
      return c.json({ error: 'channel id and root message id required' }, 400);
    }
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const principal = getUserPrincipal(c);
    if (!canViewConversation(ctx, principal, channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, principal, viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const state = ctx.conversationMessageService.threadFollowerState({
        conversationId: channel.id,
        rootMessageId,
        userId: viewerUserId,
      });
      return c.json({
        thread_root_id: state.threadRootId,
        viewer_following: state.viewerFollowing,
        follower_agent_ids: state.followerAgentIds,
      });
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(apiPaths.channelThreadFollow(':id', ':rootMessageId'), c => {
    const id = c.req.param('id');
    const rootMessageId = c.req.param('rootMessageId');
    if (!id || !rootMessageId) {
      return c.json({ error: 'channel id and root message id required' }, 400);
    }
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const principal = getUserPrincipal(c);
    if (!canViewConversation(ctx, principal, channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, principal, viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const result = ctx.conversationMessageService.followHumanThread({
        conversationId: channel.id,
        rootMessageId,
        userId: viewerUserId,
      });
      return c.json({
        thread_root_id: result.threadRootId,
        changed: result.changed,
        viewer_following: true,
      });
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.delete(apiPaths.channelThreadFollow(':id', ':rootMessageId'), c => {
    const id = c.req.param('id');
    const rootMessageId = c.req.param('rootMessageId');
    if (!id || !rootMessageId) {
      return c.json({ error: 'channel id and root message id required' }, 400);
    }
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const principal = getUserPrincipal(c);
    if (!canViewConversation(ctx, principal, channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, principal, viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const result = ctx.conversationMessageService.unfollowHumanThread({
        conversationId: channel.id,
        rootMessageId,
        userId: viewerUserId,
      });
      return c.json({
        thread_root_id: result.threadRootId,
        changed: result.changed,
        viewer_following: false,
      });
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // Pre-parse bound: reject oversized request bodies (declared or
  // chunked) before buffering/JSON.parse — non-compliant clients must
  // not be able to feed a multi-MB body into the parser. The precise
  // UTF-8 content cap is enforced after parse.
  const sendBodyLimit = bodyLimit({
    maxSize: MESSAGE_SEND_MAX_BODY_BYTES,
    onError: c =>
      c.json(
        {
          error: 'request body exceeds message-send bound',
          code: 'content_too_large',
          max_body_bytes: MESSAGE_SEND_MAX_BODY_BYTES,
        },
        413,
      ),
  });

  app.post(apiPaths.channelMessages(':id'), sendBodyLimit, async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canPostToConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // `bodyLimit` signals a chunked-body overflow by erroring the wrapped
    // stream mid-read; rethrow it so the middleware's post-`next()` check
    // converts it to the 413, instead of swallowing it into `{}` → 400.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      if (err instanceof Error && err.name === 'BodyLimitError') throw err;
      body = {};
    }
    const parsed = SendMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (messageContentExceedsLimit(parsed.data.content)) {
      return c.json(
        {
          error: `message content exceeds ${MAX_MESSAGE_CONTENT_LABEL} limit`,
          code: 'content_too_large',
          max_bytes: MAX_MESSAGE_CONTENT_BYTES,
          actual_bytes: messageContentByteLength(parsed.data.content),
        },
        413,
      );
    }
    // Send-message delivery is best-effort: `sendMessage` always persists the
    // message and returns 201, while per-agent runtime fan-out is wrapped in a
    // top-level catch so transient daemon-down state does NOT bubble up as an
    // HTTP error. The message stays in `conversation_inboxes` as pending and
    // drains when the target runtime is next alive:
    //
    //   - No daemon attached → 201 success; message pending. The
    //     typed `HostWsCommandTransportError('transport_no_connection')`
    //     fires inside `deliverMessage` but is logged + swallowed by
    //     `sendMessage`'s `try/catch`. The row drains on the next
    //     live delivery to this (conversation, agent) — either a
    //     surviving runtime re-driven on WS-reconnect
    //     (`OutboundRuntimeEventFanout.replayPendingForHost`, scoped
    //     to already-alive runtimes) or the next explicit send/start
    //     to this pair (`startDeliveryBacked`). A COLD daemon reattach
    //     (no live runtime) deliberately does NOT spawn from the DB
    //     pending set — that was the boot-herd bug.
    //   - Daemon attached, runtime errors → same: 201 + logged.
    //
    // The typed `host_attach_pending` (503) surface lives on explicit lifecycle
    // routes (`/start` / `/stop` / `/clear-session` deferred), where the user is
    // explicitly asking the runtime to do something synchronously. For "send a
    // message" the persistent inbox is the recovery mechanism.
    try {
      const result = await ctx.conversationMessageService.sendMessage({
        conversationId: channel.id,
        actor: getUserPrincipal(c),
        content: parsed.data.content,
        attachmentRefs: normalizeAttachmentRefs(parsed.data.attachment_ids),
        target: parsed.data.reply_to_message_id
          ? { kind: 'thread', message_id: parsed.data.reply_to_message_id }
          : undefined,
      });
      return c.json({ message: result.message }, 201);
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.get(apiPaths.saved, c => {
    const principal = getUserPrincipal(c);
    const parsed = SavedMessagesQueryInputSchema.safeParse({
      workspace_id: c.req.query('workspace_id'),
      since: c.req.query('since'),
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (
      parsed.data.workspace_id !== undefined &&
      !canViewWorkspace(ctx, principal, parsed.data.workspace_id)
    ) {
      // Mirror archived-channels: 404 when the workspace doesn't exist, 403 when
      // the caller can't see it. The membership gate in the repo already keeps
      // saved rows from leaking, so this is API-semantic consistency (and
      // future-proofing for multi-human) rather than the security boundary.
      const exists = workspaces.get(parsed.data.workspace_id);
      return c.json(
        { error: exists ? 'forbidden' : 'workspace not found' },
        exists ? 403 : 404,
      );
    }
    return c.json({
      saved: saved.listForUser(principal.userId, {
        workspaceId: parsed.data.workspace_id,
        since: parsed.data.since,
      }),
    });
  });

  return app;
}

// ── Mount-run C: conversation runtime control ──────────────────────────────
// saved save / unsave, full-text search, thread-from-message, and per-agent
// runtime lifecycle (start / stop / clear-session for channels + threads).
// Mounted between the attachment sub-app and the agents sub-app. The lifecycle
// helpers carry typed errors whose status/code/body are owned by shared mappers
// and the runtime module's ClearSession* errors.
export interface ConversationRuntimeRouteDeps {
  ctx: BackendContext;
  conversations: ConversationRepo;
  messages: MessageRepo;
  saved: SavedMessageRepo;
  search: SearchRepo;
  agents: AgentRepo;
  reactions: MessageReactionRepo;
}

export function createConversationRuntimeApp(
  deps: ConversationRuntimeRouteDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, conversations, messages, saved, search, agents, reactions } = deps;

  app.post(apiPaths.messageSave(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'message id required' }, 400);
    const message = messages.getById(id);
    if (!message || !canViewConversation(ctx, getUserPrincipal(c), message.conversation_id)) {
      return c.json({ error: 'message not found' }, 404);
    }
    const viewerUserId = requireViewerUserId(c);
    const row = saved.save(id, viewerUserId);
    if (!row) return c.json({ error: 'message not found' }, 404);
    // Notify the resolved viewer's private scope so the saved list
    // invalidates without polling. Pre-PR1 this was 'viewer:local';
    // routes now resolve the current viewer principal.
    ctx.events.publishToScope(
      `viewer:${viewerUserId}`,
      'saved_changed',
      { message_id: id, action: 'save' },
    );
    return c.json({ saved: row }, 201);
  });

  app.delete(apiPaths.messageSave(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'message id required' }, 400);
    const message = messages.getById(id);
    if (!message || !canViewConversation(ctx, getUserPrincipal(c), message.conversation_id)) {
      return c.json({ error: 'message not found' }, 404);
    }
    const viewerUserId = requireViewerUserId(c);
    saved.remove(id, viewerUserId);
    ctx.events.publishToScope(
      `viewer:${viewerUserId}`,
      'saved_changed',
      { message_id: id, action: 'unsave' },
    );
    return c.body(null, 204);
  });

  // Message reactions (docs/reactions-design.md §5.1). Human viewer principal.
  // POST adds / DELETE removes (`{emoji}` body); GET returns the lazy reactor
  // detail for the hover tooltip. The use case owns visibility / closed /
  // system-message / emoji guards and the post-commit WS broadcast.
  app.post(apiPaths.messageReactions(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'message id required' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const parsed = ReactMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await addReaction(
      { ctx, conversations, messages, reactions },
      { principal: getUserPrincipal(c), messageId: id, emoji: parsed.data.emoji },
    );
    return reactionResultResponse(c, result);
  });

  app.delete(apiPaths.messageReactions(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'message id required' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const parsed = ReactMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await removeReaction(
      { ctx, conversations, messages, reactions },
      { principal: getUserPrincipal(c), messageId: id, emoji: parsed.data.emoji },
    );
    return reactionResultResponse(c, result);
  });

  app.get(apiPaths.messageReactions(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'message id required' }, 400);
    const message = messages.getById(id);
    if (!message || !canViewConversation(ctx, getUserPrincipal(c), message.conversation_id)) {
      return c.json({ error: 'message not found' }, 404);
    }
    return c.json({ reactions: loadReactionDetail(ctx, id) });
  });

  app.get(apiPaths.search, c => {
    const parsed = SearchQueryInputSchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams.entries()),
    );
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    // Thread-scoped search: normalize the anchor to the thread's ROOT message
    // id (a reply id resolves to its root) and confirm it belongs to the
    // scoped conversation — mirroring the message-window route so the search
    // predicate and the render window agree on the stream. The schema
    // guarantees thread scope carries both conversation_id and thread_root_id.
    if (parsed.data.stream === 'thread') {
      // Visibility gate BEFORE the existence check. The SQL main path only
      // ever returns an empty result for a conversation the viewer cannot
      // see; if we 404'd here on "root not in this conversation" while
      // returning 200-empty otherwise, an attacker passing conversation_id +
      // thread_root_id could distinguish "this message exists and belongs to
      // that conversation" from "it doesn't" — an existence/ownership oracle
      // the search path must not introduce. So: invisible conversation →
      // empty result (indistinguishable from no matches), never a 404. A bad
      // root inside a conversation the viewer CAN already see may 404 — that
      // leaks nothing new, the viewer can enumerate that conversation anyway.
      const convId = parsed.data.conversation_id;
      if (!convId || !canViewConversation(ctx, getUserPrincipal(c), convId)) {
        return c.json({ query: parsed.data, results: [], total: 0, truncated: false });
      }
      const rootMessage = parsed.data.thread_root_id
        ? messages.getById(parsed.data.thread_root_id)
        : null;
      if (
        !rootMessage ||
        rootMessage.conversation_id !== parsed.data.conversation_id
      ) {
        return c.json(
          {
            error: 'thread root message not found in this conversation',
            code: 'thread_root_not_found',
          },
          404,
        );
      }
      parsed.data.thread_root_id = rootMessage.thread_root_id ?? rootMessage.id;
    }
    // Legacy `messages.from_user_id IS NULL` rows predate the principal
    // middleware. The renderer treats them as authored by the current
    // viewer, so when the search filter targets the viewer we widen the
    // SQL to include NULLs. Done here (not in the repo) so SearchRepo
    // stays a pure SQL adapter without an implicit settings lookup.
    const viewerUserId = requireViewerUserId(c);
    const includeNullAuthor =
      parsed.data.user_id !== undefined && parsed.data.user_id === viewerUserId;
    const { results, total, truncated } = search.search(parsed.data, {
      includeNullAuthor,
      visibleUserId: viewerUserId,
    });
    return c.json({ query: parsed.data, results, total, truncated });
  });

  app.post('/api/channels/:id/agents/:aid/start', async c => {
    const id = c.req.param('id');
    const aid = c.req.param('aid');
    if (!id || !aid) return c.json({ error: 'channel id and agent id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return startConversationAgent(channel.id, aid, c);
  });

  app.post('/api/channels/:id/agents/:aid/stop', async c => {
    const id = c.req.param('id');
    const aid = c.req.param('aid');
    if (!id || !aid) return c.json({ error: 'channel id and agent id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return stopConversationAgent(channel.id, aid, c);
  });

  app.post('/api/channels/:id/agents/:aid/clear-session', async c => {
    const id = c.req.param('id');
    const aid = c.req.param('aid');
    if (!id || !aid) return c.json({ error: 'channel id and agent id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return clearConversationAgentSession(channel.id, aid, c);
  });

  async function startConversationAgent(
    conversationId: string,
    agentId: string,
    c: Context,
  ): Promise<Response> {
    if (!agents.get(agentId)) return c.json({ error: 'agent not found' }, 404);
    if (!conversations.getAgent(conversationId, agentId)) {
      return c.json({ error: 'agent is not a member of this conversation' }, 400);
    }
    if (!canPostToConversation(ctx, getUserPrincipal(c), conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!canEditAgent(ctx, getUserPrincipal(c), agentId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    ctx.logger.info(
      { conversationId, agentId },
      'api: start agent requested',
    );
    // When the workspace's daemon-host is attached, `ctx.runtimeHost.start`
    // dispatches `runtime_start` over the outbound WS like the
    // embedded path. When no daemon is attached, the outbound
    // transport throws a typed
    // `HostWsCommandTransportError('transport_no_connection')` →
    // `placementErrorResponse` → 503 `host_attach_pending`. The
    // 409 `host_runtime_disabled` would collapse both arms into "this mode
    // never runs agents", which is wrong for standalone deployments with a
    // daemon host.
    try {
      await ctx.runtimeHost.start(conversationId, agentId);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(
        { conversationId, agentId, err },
        'api: start agent failed',
      );
      const mapped = placementErrorResponse(c, err);
      if (mapped) return mapped;
      const startError = runtimeStartErrorResponse(c, err);
      if (startError) return startError;
      return c.json({ error: msg }, 400);
    }
  }

  async function stopConversationAgent(
    conversationId: string,
    agentId: string,
    c: Context,
  ): Promise<Response> {
    if (!agents.get(agentId)) return c.json({ error: 'agent not found' }, 404);
    if (!conversations.getAgent(conversationId, agentId)) {
      return c.json({ error: 'agent is not a member of this conversation' }, 400);
    }
    if (!canPostToConversation(ctx, getUserPrincipal(c), conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!canEditAgent(ctx, getUserPrincipal(c), agentId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // Soft stop was removed (#task:1558). A stale caller asking for the
    // pause semantics must fail loud — silently upgrading a "pause"
    // request to an irreversible hard kill is worse than a 4xx.
    const body = await c.req.json().catch(() => ({}));
    if (body?.mode === 'soft' || body?.directive !== undefined) {
      return c.json(
        { error: 'soft stop was removed; only hard stop is supported' },
        400,
      );
    }
    ctx.logger.info(
      { conversationId, agentId },
      'api: stop agent requested',
    );
    // Same standalone daemon-host behavior as startConversationAgent.
    try {
      await ctx.runtimeHost.stop(conversationId, agentId);
      return c.json({ ok: true });
    } catch (err) {
      const mapped = placementErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  }

  async function clearConversationAgentSession(
    conversationId: string,
    agentId: string,
    c: Context,
  ): Promise<Response> {
    if (!agents.get(agentId)) return c.json({ error: 'agent not found' }, 404);
    if (!conversations.getAgent(conversationId, agentId)) {
      return c.json({ error: 'agent is not a member of this conversation' }, 400);
    }
    const principal = getUserPrincipal(c);
    if (!canPostToConversation(ctx, principal, conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!canEditAgent(ctx, principal, agentId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    ctx.logger.info(
      { conversationId, agentId },
      'api: clear agent session requested',
    );
    // The outbound fanout's `clearSession` dispatches
    // `runtime_clear_session`, bounded-waits for the resulting
    // `runtime_exit` projection to land, then atomically clears
    // `cli_session_id` + writes the audit row in one DB tx.
    //
    // Two route-local typed errors that are NOT in the placement
    // taxonomy:
    //   - `ClearSessionExitTimeoutError` → 503
    //     `clear_session_timeout`. Daemon ACK'd
    //     `runtime_clear_session` but the resulting `runtime_exit`
    //     never landed within the bound (e.g. SIGKILL grace window
    //     stuck child). DB UNCHANGED — retry is safe.
    //   - `ClearSessionInProgressError` → 409
    //     `clear_session_in_progress`. A previous clear-session for
    //     the same (cid, aid) is still waiting on `runtime_exit`.
    //     Clear-session is a user-explicit one-shot — fail-fast
    //     beats share-waiter complexity.
    //
    // Transport-down at dispatch time still surfaces as 503
    // `host_attach_pending` via `placementErrorResponse`.
    //
    // **This IPC is local supervisor/control, not server↔daemon
    // formal semantics.**
    try {
      const result = await ctx.runtimeHost.clearSession(
        conversationId,
        agentId,
        principal.userId,
      );
      return c.json({
        ok: true,
        prev_cli_session_id: result.prevCliSessionId,
        was_running: result.wasRunning,
      });
    } catch (err) {
      if (err instanceof ClearSessionExitTimeoutError) {
        ctx.logger.warn(
          { conversationId, agentId, code: err.code },
          'api: clear agent session timed out waiting for runtime_exit projection',
        );
        return c.json({ error: err.message, code: err.code }, 503);
      }
      if (err instanceof ClearSessionInProgressError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(
        { conversationId, agentId, err },
        'api: clear agent session failed',
      );
      const mapped = placementErrorResponse(c, err);
      if (mapped) return mapped;
      return c.json({ error: msg }, 400);
    }
  }

  return app;
}
