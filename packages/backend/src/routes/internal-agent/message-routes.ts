// Agent message data-plane facet: send / stale-resolution / read-history /
// search. All hang off the calling conversation; the internal principal
// middleware (cid+aid → AgentPrincipal) authenticates before these run.
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  getAgentPrincipal,
  type AppEnv,
} from '../../auth/principal.js';
import {
  canAgentAccessWorkspace,
  canPostToConversation,
  canViewConversation,
} from '../../permissions.js';
import { timedRouteSpan } from '../../observability/route-span.js';
import { requireAgentCapability } from '../capability.js';
import { conversationMessageServiceErrorResponse } from '../responses.js';
import {
  AgentReadHistoryInputSchema,
  AgentResolveStaleMessageInputSchema,
  AgentSearchMessagesInputSchema,
  AgentSendMessageInputSchema,
  normalizeAttachmentRefs,
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_MESSAGE_CONTENT_LABEL,
  MESSAGE_SEND_MAX_BODY_BYTES,
  messageContentByteLength,
  messageContentExceedsLimit,
} from '@silverhand/shared';
import type { InternalRouteDeps } from './deps.js';
import { requireAgentConversationCapability } from './capability-scope.js';
import { resolveAgentQueryWorkspaceId } from './workspace-scope.js';
import { internalAgentRoutePaths } from './paths.js';

export function registerMessageRoutes(
  app: Hono<AppEnv>,
  deps: InternalRouteDeps,
): void {
  const { ctx, agentReads, conversations } = deps;

  // Pre-parse bound: reject oversized request bodies (declared or
  // chunked) before buffering/JSON.parse. The precise UTF-8 content
  // cap is enforced after parse.
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

  app.post(internalAgentRoutePaths.sendMessage, sendBodyLimit, async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
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
    const parsed = AgentSendMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      ctx.logger.warn(
        { conversationId: cid, agentId: aid, issues: parsed.error.issues },
        'internal: agent send-message rejected (invalid input)',
      );
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (parsed.data.target !== undefined && parsed.data.reply_to_message_id !== undefined) {
      return c.json(
        {
          error: 'target and reply_to_message_id are mutually exclusive',
          code: 'target_conflict',
        },
        400,
      );
    }
    if (messageContentExceedsLimit(parsed.data.content)) {
      return c.json(
        {
          error: `message content exceeds ${MAX_MESSAGE_CONTENT_LABEL} limit; send it as an attachment instead`,
          code: 'content_too_large',
          max_bytes: MAX_MESSAGE_CONTENT_BYTES,
          actual_bytes: messageContentByteLength(parsed.data.content),
        },
        413,
      );
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    {
      const denied = requireAgentConversationCapability(c, ctx, principal,
        'send_messages', conversations.getIdentity(principal.conversationId));
      if (denied) return denied;
    }
    if (parsed.data.stale_event_id !== undefined) {
      c.set(
        'cliStaleResolutionReason',
        parsed.data.stale_resolution_reason
        ?? (parsed.data.freshness_bypass ? 'force_send' : 'unattributed'),
      );
    }
    try {
      const result = await ctx.conversationMessageService.sendMessage({
        conversationId: principal.conversationId,
        actor: principal,
        content: parsed.data.content,
        attachmentRefs: normalizeAttachmentRefs(parsed.data.attachment_ids),
        target: parsed.data.target,
        legacyReplyToMessageId: parsed.data.reply_to_message_id,
        assertedStreamKey: parsed.data.stream_key,
        seenUpToSeq: parsed.data.seen_up_to_seq,
        staleEventId: parsed.data.stale_event_id,
        staleResolutionReason: parsed.data.stale_resolution_reason,
        freshnessBypass: parsed.data.freshness_bypass ?? false,
      });
      return c.json({
        message_id: result.committed.message.id,
        message_seq: result.committed.message.seq,
        thread_root_id: result.committed.message.thread_root_id,
        ...(result.streamHeadBeforeSend !== undefined
          ? { stream_head_before: result.streamHeadBeforeSend }
          : {}),
        // Omitted when empty (#task:2021 P4-5-b): the field is the ANSWER
        // "these references addressed nobody", so an empty array on every
        // ordinary send would be noise on the one surface an agent reads after
        // each of its own messages. The service's field is total; the wire's is
        // present only when it says something.
        ...(result.unresolvedReferences.length > 0
          ? { unresolved_references: result.unresolvedReferences }
          : {}),
      });
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(internalAgentRoutePaths.resolveStaleMessage, async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentResolveStaleMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      ctx.logger.warn(
        { conversationId: cid, agentId: aid, issues: parsed.error.issues },
        'internal: agent stale-resolution rejected (invalid input)',
      );
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    {
      const denied = requireAgentConversationCapability(c, ctx, principal,
        'send_messages', conversations.getIdentity(principal.conversationId));
      if (denied) return denied;
    }
    c.set('cliStaleResolutionReason', parsed.data.resolution_reason);
    ctx.conversationMessageService.resolveStaleMessage({
      conversationId: principal.conversationId,
      actor: principal,
      staleEventId: parsed.data.stale_event_id,
      resolutionReason: parsed.data.resolution_reason,
    });
    return c.json({ ok: true });
  });

  app.post(internalAgentRoutePaths.readHistory, async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentReadHistoryInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const sourceConversation = conversations.get(principal.conversationId);
    if (!sourceConversation) return c.json({ error: 'conversation not found' }, 404);
    const target = agentReads.resolveHistoryTarget(
      conversations,
      sourceConversation,
      principal.agentId,
      parsed.data.target,
    );
    if (!target.ok) {
      return c.json({ error: target.message, code: target.code }, target.status);
    }
    {
      // The TARGET conversation's placement governs: its workspace grant, or
      // self-authority when the target is the caller's own inbox (v71).
      const denied = requireAgentConversationCapability(c, ctx, principal,
        'read_messages', conversations.getIdentity(target.conversation.id));
      if (denied) return denied;
    }
    const result = timedRouteSpan(
      ctx,
      'agent.read_history',
      {
        sourceConversationId: principal.conversationId,
        targetConversationId: target.conversation.id,
        agentId: principal.agentId,
        limit: parsed.data.limit,
      },
      () =>
        agentReads.buildReadHistoryDto(
          target.conversation,
          parsed.data,
          target.threadRootId,
          { kind: 'agent', id: principal.agentId },
        ),
      out => ({
        messageCount: 'messages' in out ? out.messages.length : 0,
      }),
    );
    if ('error' in result) {
      return c.json({ error: result.error, code: result.code }, result.status);
    }
    return c.json(result);
  });

  app.post(internalAgentRoutePaths.searchMessages, async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentSearchMessagesInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const sourceConversation = conversations.get(principal.conversationId);
    if (!sourceConversation) return c.json({ error: 'conversation not found' }, 404);
    // Cross-workspace search is gated up-front by
    // `canAgentAccessWorkspace`. The dto builder still runs the
    // conversation_agents JOIN as the bottom guard, so unjoined
    // channels in the target workspace stay invisible.
    if (
      parsed.data.workspace_id &&
      parsed.data.workspace_id !== sourceConversation.workspace_id
    ) {
      if (
        !canAgentAccessWorkspace(
          ctx,
          principal.agentId,
          parsed.data.workspace_id,
        )
      ) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }
    {
      // Resolve WHAT the search is scoped to, and let that scope decide the
      // grant:
      //   - a conversation selector → THAT conversation governs (its workspace
      //     grant, or self-authority in the caller's own inbox);
      //   - otherwise the search is workspace-wide (explicit `workspace_id`,
      //     else the source conversation's — which is also what
      //     `current_workspace` means), and a workspace-less placement has no
      //     ambient workspace to search, so the caller must name one (v71).
      // The dto builder still bottom-guards per-conversation membership via
      // JOIN.
      const selected = parsed.data.conversation_id
        ? conversations.getIdentity(parsed.data.conversation_id)
        : null;
      if (selected) {
        const denied = requireAgentConversationCapability(c, ctx, principal,
          'read_messages', selected);
        if (denied) return denied;
      } else {
        const scope = resolveAgentQueryWorkspaceId(
          c,
          sourceConversation,
          parsed.data.workspace_id,
        );
        if (!scope.ok) return scope.response;
        const denied = requireAgentCapability(c, ctx, principal, 'read_messages',
          scope.workspaceId);
        if (denied) return denied;
      }
    }
    const result = timedRouteSpan(
      ctx,
      'agent.search_messages',
      {
        sourceConversationId: principal.conversationId,
        agentId: principal.agentId,
        currentWorkspace: parsed.data.current_workspace ?? false,
        workspaceId: parsed.data.workspace_id ?? null,
        conversationId: parsed.data.conversation_id ?? null,
        limit: parsed.data.limit,
      },
      () =>
        agentReads.buildSearchMessagesDto(
          conversations,
          sourceConversation,
          principal.agentId,
          parsed.data,
        ),
      out => ({
        hitCount: out.ok ? out.dto.hits.length : 0,
      }),
    );
    if (!result.ok) {
      return c.json({ error: result.message, code: result.code }, result.status);
    }
    return c.json(result.dto);
  });
}
