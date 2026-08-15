// Agent-initiated attachment facet (silverhand CLI → backend).
//
// UPLOAD takes ONE absolute address (#task:2021 P4-4): an attachment is scoped to
// a CONVERSATION — threads inherit their parent's files — so the door is
// conversation-granular and a `/thread:` suffix is refused rather than dropped.
// The remaining three doors are OBJECT-addressed: their scope is derived from the
// attachment id, so they take no target and carry no ambient conversation
// coordinate. Missing and invisible objects share the same not-found answer.
import type { Hono } from 'hono';
import {
  agentPrincipalIn,
  getAgentPrincipal,
  getRuntimePrincipal,
  type AppEnv,
} from '../../auth/principal.js';
import {
  canPostToConversation,
  canViewConversation,
} from '../../permissions.js';
import { updateAttachment, uploadAttachment } from '../attachment-upload.js';
import type { InternalRouteDeps } from './deps.js';
import { requireAgentConversationCapability } from './capability-scope.js';
import { resolveConversationTargetForRoute } from './delivery-target.js';
import { internalAgentRoutePaths } from './paths.js';
import { mayWriteObjectInConversation } from '../../application/delivery-reach.js';

export function registerFileRoutes(
  app: Hono<AppEnv>,
  deps: InternalRouteDeps,
): void {
  const { ctx, agents, conversations } = deps;

  app.post(internalAgentRoutePaths.attachments, async c => {
    const principal = getAgentPrincipal(c);
    // The address rides in the multipart form beside the bytes, and is read
    // BEFORE them: `c.req.formData()` is cached by Hono, so `uploadAttachment`
    // below re-reads the same parsed form rather than draining the body twice.
    const form = await c.req.formData().catch(() => null);
    if (form === null) {
      return c.json({ error: 'multipart/form-data required' }, 400);
    }
    const rawTarget = form.get('target');
    // An absent field is answered by the ONE grammar authority as
    // `target_malformed`, because that is what it is — no address arrived. The CLI
    // refuses a missing `--target` locally, so this is the hand-rolled-client path
    // and does not deserve a code of its own.
    const resolved = resolveConversationTargetForRoute(c, deps, {
      address: typeof rawTarget === 'string' ? rawTarget : '',
      operation: 'file_upload',
      intent: 'write',
      now: Date.now(),
    });
    if (!resolved.ok) return resolved.response;
    const destination = resolved.target.stream.conversationId;
    const targetPrincipal = agentPrincipalIn(c, destination);
    {
      const denied = requireAgentConversationCapability(c, ctx, targetPrincipal,
        'upload_attachments', conversations.getIdentity(destination));
      if (denied) return denied;
    }
    return uploadAttachment(
      ctx,
      c,
      destination,
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
    internalAgentRoutePaths.attachment(':attachmentId'),
    async c => {
      const aid = c.req.param('aid');
      const attachmentId = c.req.param('attachmentId');
      if (!aid || !attachmentId) {
        return c.json(
          { error: 'agent id and attachment id required' },
          400,
        );
      }
      if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
      const ownerConversationId = ctx.attachmentService.conversationIdOf(attachmentId);
      if (ownerConversationId === null) {
        return c.json({ error: 'attachment not found' }, 404);
      }
      if (!mayWriteObjectInConversation(
        getRuntimePrincipal(c),
        ownerConversationId,
      )) {
        return c.json({ error: 'attachment not found' }, 404);
      }
      const principal = agentPrincipalIn(c, ownerConversationId);
      if (!canPostToConversation(ctx, principal, principal.conversationId)) {
        return c.json({ error: 'attachment not found' }, 404);
      }
      {
        const denied = requireAgentConversationCapability(c, ctx, principal,
          'upload_attachments', conversations.getIdentity(ownerConversationId));
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
    internalAgentRoutePaths.attachmentLocate(':attachmentId'),
    async c => {
      const aid = c.req.param('aid');
      const attachmentId = c.req.param('attachmentId');
      if (!aid || !attachmentId) {
        return c.json(
          { error: 'agent id and attachment id required' },
          400,
        );
      }
      if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
      const ownerConversationId = ctx.attachmentService.conversationIdOf(attachmentId);
      if (ownerConversationId === null) {
        return c.json({ error: 'attachment not found' }, 404);
      }
      const principal = agentPrincipalIn(c, ownerConversationId);
      if (!canViewConversation(ctx, principal, principal.conversationId)) {
        return c.json({ error: 'attachment not found' }, 404);
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
    internalAgentRoutePaths.attachmentDownload(':attachmentId'),
    async c => {
      const aid = c.req.param('aid');
      const attachmentId = c.req.param('attachmentId');
      if (!aid || !attachmentId) {
        return c.json(
          { error: 'agent id and attachment id required' },
          400,
        );
      }
      if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
      const ownerConversationId = ctx.attachmentService.conversationIdOf(attachmentId);
      if (ownerConversationId === null) {
        return c.json({ error: 'attachment not found' }, 404);
      }
      const principal = agentPrincipalIn(c, ownerConversationId);
      if (!canViewConversation(ctx, principal, principal.conversationId)) {
        return c.json({ error: 'attachment not found' }, 404);
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
