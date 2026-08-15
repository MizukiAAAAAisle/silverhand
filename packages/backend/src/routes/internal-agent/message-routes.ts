// Agent message data-plane facet: send / stale-resolution / read-history /
// search. All hang off the calling conversation; the internal principal
// middleware (cid+aid → AgentPrincipal) authenticates before these run.
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  agentPrincipalIn,
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
import { resolveDeliveryTargetForRoute } from './delivery-target.js';
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
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
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
        { agentId: aid, issues: parsed.error.issues },
        'internal: agent send-message rejected (invalid input)',
      );
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
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
    const resolved = resolveDeliveryTargetForRoute(c, deps, {
      address: parsed.data.target,
      operation: 'message_send',
      intent: 'write',
      now: Date.now(),
    });
    if (!resolved.ok) return resolved.response;
    const targetPrincipal = agentPrincipalIn(
      c,
      resolved.target.stream.conversationId,
    );
    {
      // The TARGET conversation's placement governs the capability, exactly as it
      // does on the read side: its workspace grant, self-authority for the
      // caller's own inbox, or endpoint authority for a DM. Asking it of the
      // SOURCE would grant a send into any stream to anyone who could post in
      // their own — the credential gate above is about the caller, this is about
      // where the words land.
      const denied = requireAgentConversationCapability(c, ctx, targetPrincipal,
        'send_messages',
        conversations.getIdentity(resolved.target.stream.conversationId));
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
        conversationId: targetPrincipal.conversationId,
        actor: targetPrincipal,
        content: parsed.data.content,
        attachmentRefs: normalizeAttachmentRefs(parsed.data.attachment_ids),
        destination: { kind: 'stream', stream: resolved.target.stream },
        assertedStream: parsed.data.asserted_stream,
        seenUpToSeq: parsed.data.seen_up_to_seq,
        staleEventId: parsed.data.stale_event_id,
        staleResolutionReason: parsed.data.stale_resolution_reason,
        freshnessBypass: parsed.data.freshness_bypass ?? false,
      });
      return c.json({
        message_id: result.committed.message.id,
        message_seq: result.committed.message.seq,
        // WHERE the address resolved TO — the absolute coordinate the caller can
        // cache, so a `dm:@handle` or a readable pair is spelled once and every
        // follow-up in that stream carries the id form. Total, not conditional on
        // the address having been readable: "which stream did my words land in" has
        // one answer for every send.
        conversation_id: result.targetConversationId,
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
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentResolveStaleMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      ctx.logger.warn(
        { agentId: aid, issues: parsed.error.issues },
        'internal: agent stale-resolution rejected (invalid input)',
      );
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = agentPrincipalIn(c, parsed.data.conversation_id);
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
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentReadHistoryInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    // ONE resolver for both doors (#task:2021 P4-4). The read intent differs from
    // the write only in what it refuses to do — never allocate a direct pair — and
    // that asymmetry lives inside the resolver, so this route carries no rule of
    // its own about what an address denotes.
    //
    // What this replaced is worth naming, because it was the read side's own
    // taxonomy: a missing target meant "here", `{conversation_id}` and
    // `{thread_root_id}` were separate arms, a mid-cluster id was normalized to its
    // root, and a non-participant got 403 `not_target_conversation_member` while an
    // unknown id got 404. That last pair is the reason this had to go: two statuses
    // for "unknown" and "not yours" is an existence oracle over every conversation
    // id in the installation, and the read door is the cheapest place to query it.
    // Both are now 404 `target_unresolved`, byte-identical (see the resolver's
    // "UNKNOWN AND UNAUTHORIZED ARE ONE OUTCOME"), with the branch that actually
    // fired leaving through the operator observer.
    const resolved = resolveDeliveryTargetForRoute(c, deps, {
      address: parsed.data.target,
      operation: 'message_history',
      intent: 'read',
      now: Date.now(),
    });
    if (!resolved.ok) return resolved.response;
    const targetPrincipal = agentPrincipalIn(
      c,
      resolved.target.stream.conversationId,
    );
    const targetConversation = conversations.get(
      resolved.target.stream.conversationId,
    );
    // The resolver already proved participation in this row; a miss here is the
    // row vanishing between two statements of the same request, not a caller error.
    if (!targetConversation) {
      return c.json({ error: 'conversation not found' }, 404);
    }
    {
      // The TARGET conversation's placement governs: its workspace grant, or
      // self-authority when the target is the caller's own inbox (v71).
      const denied = requireAgentConversationCapability(c, ctx, targetPrincipal,
        'read_messages', conversations.getIdentity(targetConversation.id));
      if (denied) return denied;
    }
    const result = timedRouteSpan(
      ctx,
      'agent.read_history',
      {
        runtimeConversationId: principal.conversationId,
        targetConversationId: targetConversation.id,
        agentId: principal.agentId,
        limit: parsed.data.limit,
      },
      () =>
        agentReads.buildReadHistoryDto(
          targetConversation,
          parsed.data,
          resolved.target.stream.threadRootId,
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
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentSearchMessagesInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    const sourceConversation = principal.conversationId === null
      ? null
      : conversations.get(principal.conversationId);
    if (principal.conversationId !== null && !sourceConversation) {
      return c.json({ error: 'conversation not found' }, 404);
    }
    // Cross-workspace search is gated up-front by
    // `canAgentAccessWorkspace`. The dto builder still runs the
    // conversation_agents JOIN as the bottom guard, so unjoined
    // channels in the target workspace stay invisible.
    if (
      parsed.data.workspace_id &&
      parsed.data.workspace_id !== sourceConversation?.workspace_id
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
        const explicitWorkspaceId = parsed.data.workspace_id;
        if (sourceConversation === null && explicitWorkspaceId === undefined) {
          return c.json({
            error: 'agent-scoped message search must name conversation_id or workspace_id',
            code: 'search_scope_required',
          }, 400);
        }
        const scope = sourceConversation === null
          ? { ok: true as const, workspaceId: explicitWorkspaceId! }
          : resolveAgentQueryWorkspaceId(c, sourceConversation, explicitWorkspaceId);
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
