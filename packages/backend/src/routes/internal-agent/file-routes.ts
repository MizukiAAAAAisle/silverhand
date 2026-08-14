// Agent-initiated attachment facet (silverhand CLI → backend). Agents never
// specify channel_id; the backend derives it from the calling conversation
// (cid) so the access boundary is fixed by the agent's runtime context.
// locateForAgent additionally enforces that the requested attachment belongs
// to the same channel.
import type { Hono } from 'hono';
import {
  getAgentPrincipal,
  type AppEnv,
} from '../../auth/principal.js';
import {
  canPostToConversation,
  canViewConversation,
} from '../../permissions.js';
import { updateAttachment, uploadAttachment } from '../attachment-upload.js';
import { internalPaths } from '@silverhand/shared';
import type { InternalRouteDeps } from './deps.js';
import { requireAgentConversationCapability } from './capability-scope.js';

export function registerFileRoutes(
  app: Hono<AppEnv>,
  deps: InternalRouteDeps,
): void {
  const { ctx, agents, conversations } = deps;

  app.post(internalPaths.agentUploadAttachment(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const conversation = conversations.get(cid);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    if (!conversations.getAgent(cid, aid)) {
      return c.json({ error: 'agent is not a member of this conversation' }, 403);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    {
      const denied = requireAgentConversationCapability(c, ctx, principal,
        'upload_attachments', conversations.getIdentity(conversation.id));
      if (denied) return denied;
    }
    return uploadAttachment(
      ctx,
      c,
      principal.conversationId,
      'agent',
      principal.agentId,
    );
  });

  // PATCH — in-place content update (creator-only pointer-swap). Reuses the
  // `upload_attachments` capability (updating is a write of the same class, so
  // no new capability enum). Channel scope is enforced in the service via
  // `requireCallerChannelOf` (the caller may only touch attachments in its own
  // channel); the service also re-checks agent creator ownership.
  app.patch(
    internalPaths.agentUpdateAttachment(':cid', ':aid', ':attachmentId'),
    async c => {
      const cid = c.req.param('cid');
      const aid = c.req.param('aid');
      const attachmentId = c.req.param('attachmentId');
      if (!cid || !aid || !attachmentId) {
        return c.json(
          { error: 'conversation id, agent id, and attachment id required' },
          400,
        );
      }
      const conversation = conversations.get(cid);
      if (!conversation) return c.json({ error: 'conversation not found' }, 404);
      if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
      if (!conversations.getAgent(cid, aid)) {
        return c.json({ error: 'agent is not a member of this conversation' }, 403);
      }
      const principal = getAgentPrincipal(c);
      if (!canPostToConversation(ctx, principal, principal.conversationId)) {
        return c.json({ error: 'forbidden' }, 403);
      }
      {
        const denied = requireAgentConversationCapability(c, ctx, principal,
          'upload_attachments', conversations.getIdentity(conversation.id));
        if (denied) return denied;
      }
      return updateAttachment(
        ctx,
        c,
        attachmentId,
        { kind: 'agent', id: principal.agentId },
        { requireCallerChannelOf: principal.conversationId },
      );
    },
  );

  app.get(
    internalPaths.agentLocateAttachment(':cid', ':aid', ':attachmentId'),
    async c => {
      const cid = c.req.param('cid');
      const aid = c.req.param('aid');
      const attachmentId = c.req.param('attachmentId');
      if (!cid || !aid || !attachmentId) {
        return c.json(
          { error: 'conversation id, agent id, and attachment id required' },
          400,
        );
      }
      if (!conversations.get(cid)) return c.json({ error: 'conversation not found' }, 404);
      if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
      if (!conversations.getAgent(cid, aid)) {
        return c.json({ error: 'agent is not a member of this conversation' }, 403);
      }
      const principal = getAgentPrincipal(c);
      if (!canViewConversation(ctx, principal, principal.conversationId)) {
        return c.json({ error: 'forbidden' }, 403);
      }
      {
        const denied = requireAgentConversationCapability(c, ctx, principal,
          'read_attachments', conversations.getIdentity(principal.conversationId));
        if (denied) return denied;
      }
      // TODO(remote-blob): `locateForAgent` throws
      // `remote_locate_not_implemented` for non-local storage (s3/oss).
      // Currently unreachable (only `LocalBlobFileStorage` is wired), but
      // when remote blob storage lands this and the download route below
      // must wrap the call in a try/catch that maps the throw to a
      // download_url response instead of an uncaught 500. Audited #task:1133.
      const located = await ctx.attachmentService.locateForAgent(
        attachmentId,
        principal.conversationId,
      );
      if (!located) {
        // Either does not exist or belongs to a different channel — same
        // shape on purpose so we don't leak existence across channels.
        return c.json({ error: 'attachment not found' }, 404);
      }
      return c.json(located.locate);
    },
  );

  app.get(
    internalPaths.agentDownloadAttachment(':cid', ':aid', ':attachmentId'),
    async c => {
      const cid = c.req.param('cid');
      const aid = c.req.param('aid');
      const attachmentId = c.req.param('attachmentId');
      if (!cid || !aid || !attachmentId) {
        return c.json(
          { error: 'conversation id, agent id, and attachment id required' },
          400,
        );
      }
      if (!conversations.get(cid)) return c.json({ error: 'conversation not found' }, 404);
      if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
      if (!conversations.getAgent(cid, aid)) {
        return c.json({ error: 'agent is not a member of this conversation' }, 403);
      }
      const principal = getAgentPrincipal(c);
      if (!canViewConversation(ctx, principal, principal.conversationId)) {
        return c.json({ error: 'forbidden' }, 403);
      }
      {
        const denied = requireAgentConversationCapability(c, ctx, principal,
          'read_attachments', conversations.getIdentity(principal.conversationId));
        if (denied) return denied;
      }
      const located = await ctx.attachmentService.locateForAgent(
        attachmentId,
        principal.conversationId,
      );
      if (!located) {
        // Same not-found shape as locate: missing rows and cross-channel
        // attempts are indistinguishable.
        return c.json({ error: 'attachment not found' }, 404);
      }
      const response = await ctx.attachmentService.serveForAgentLocated(located.row);
      if (!response) return c.json({ error: 'attachment not found' }, 404);
      return response;
    },
  );
}
