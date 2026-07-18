// Agent message data-plane facet: send / stale-resolution / read-history /
// search. All hang off the calling conversation; the internal principal
// middleware (cid+aid → AgentPrincipal) authenticates before these run.
import type { Hono } from 'hono';
import {
  getAgentPrincipal,
  type AppEnv,
} from '../../auth/principal.js';
import {
  canAgentAccessWorkspace,
  canPostToConversation,
  canViewConversation,
} from '../../permissions.js';
import {
  buildAgentSearchMessagesDto,
  buildReadHistoryDto,
  resolveAgentReadHistoryTarget,
} from '../../read-model/agent-read.js';
import { timedRouteSpan } from '../../observability/route-span.js';
import { requireAgentCapability } from '../capability.js';
import { conversationMessageServiceErrorResponse } from '../responses.js';
import {
  AgentReadHistoryInputSchema,
  AgentResolveStaleMessageInputSchema,
  AgentSearchMessagesInputSchema,
  AgentSendMessageInputSchema,
  internalPaths,
  normalizeAttachmentRefs,
} from '@silverhand/shared';
import type { InternalRouteDeps } from './deps.js';

export function registerMessageRoutes(
  app: Hono<AppEnv>,
  deps: InternalRouteDeps,
): void {
  const { ctx, conversations } = deps;

  app.post(internalPaths.agentSendConversationMessage(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
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
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    {
      const denied = requireAgentCapability(c, ctx, principal, 'send_messages',
        conversations.get(principal.conversationId)?.workspace_id);
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
        message_id: result.message.id,
        message_seq: result.message.seq,
        thread_root_id: result.message.thread_root_id,
      });
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(internalPaths.agentResolveStaleMessage(':cid', ':aid'), async c => {
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
      const denied = requireAgentCapability(c, ctx, principal, 'send_messages',
        conversations.get(principal.conversationId)?.workspace_id);
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

  app.post(internalPaths.agentReadHistory(':cid', ':aid'), async c => {
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
    const target = resolveAgentReadHistoryTarget(
      ctx,
      conversations,
      sourceConversation,
      principal.agentId,
      parsed.data.target,
    );
    if (!target.ok) {
      return c.json({ error: target.message, code: target.code }, target.status);
    }
    {
      const denied = requireAgentCapability(c, ctx, principal, 'read_messages',
        target.conversation.workspace_id);
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
        buildReadHistoryDto(ctx, target.conversation, parsed.data, target.threadRootId, {
          kind: 'agent',
          id: principal.agentId,
        }),
      out => ({
        messageCount: 'messages' in out ? out.messages.length : 0,
      }),
    );
    if ('error' in result) {
      return c.json({ error: result.error, code: result.code }, result.status);
    }
    return c.json(result);
  });

  app.post(internalPaths.agentSearchMessages(':cid', ':aid'), async c => {
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
      // Resolve the workspace the search actually lands in:
      // scope='channel' → the channel's (global) workspace; else the
      // explicit workspace_id arg; else the source conversation's. The dto
      // builder still bottom-guards per-channel membership via JOIN.
      const searchWorkspaceId = parsed.data.channel_id
        ? conversations.get(parsed.data.channel_id)?.workspace_id ?? sourceConversation.workspace_id
        : parsed.data.workspace_id ?? sourceConversation.workspace_id;
      const denied = requireAgentCapability(c, ctx, principal, 'read_messages', searchWorkspaceId);
      if (denied) return denied;
    }
    const result = timedRouteSpan(
      ctx,
      'agent.search_messages',
      {
        sourceConversationId: principal.conversationId,
        agentId: principal.agentId,
        scope: parsed.data.scope,
        workspaceId: parsed.data.workspace_id ?? null,
        channelId: parsed.data.channel_id ?? null,
        limit: parsed.data.limit,
      },
      () =>
        buildAgentSearchMessagesDto(
          ctx,
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
