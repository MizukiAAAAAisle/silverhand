// Public attachment routes: channel upload, attachment download, and
// attachment delete. Upload goes via channel context so the server
// resolves the access boundary; clients never specify channel_id directly.
// Download is by id — auth is bearer (renderer) or v1-permissive (TODO when DM
// membership is enforceable per blob).
//
// `uploadAttachment` stays in the neutral leaf `./attachment-upload.js` — it is
// SHARED with `routes/internal-agent.ts` (the internal upload route). Folding it
// here would invert the boundary (internal-agent depending on the public
// attachment router); both contexts import the same leaf instead.
import { Hono } from 'hono';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { AttachmentRepo } from '../repos/attachment-repo.js';
import { apiPaths } from '@silverhand/shared';
import { getUserPrincipal, requireViewerUserId } from '../auth/principal.js';
import {
  canDeleteAttachment,
  canPostToConversation,
  canViewAttachment,
} from '../permissions.js';
import { uploadAttachment } from './attachment-upload.js';

export interface AttachmentsRouteDeps {
  ctx: BackendContext;
  conversations: ConversationRepo;
  attachments: AttachmentRepo;
}

export function createAttachmentsApp(deps: AttachmentsRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, conversations, attachments } = deps;

  app.post(apiPaths.channelAttachments(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const viewerUserId = requireViewerUserId(c);
    if (!canPostToConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return uploadAttachment(ctx, c, channel.id, 'user', viewerUserId);
  });

  app.get(apiPaths.attachment(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'attachment id required' }, 400);
    const viewerUserId = requireViewerUserId(c);
    const principal = getUserPrincipal(c);
    const response = await ctx.attachmentService.serveForViewer(id, row =>
      canViewAttachment(ctx, principal, row),
    );
    if (!response) return c.json({ error: 'attachment not found' }, 404);
    return response;
  });

  app.delete(apiPaths.attachment(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'attachment id required' }, 400);
    const viewerUserId = requireViewerUserId(c);
    const attachment = attachments.getById(id);
    if (!attachment) return c.json({ error: 'attachment not found' }, 404);
    if (!canDeleteAttachment(ctx, getUserPrincipal(c), attachment)) {
      return c.json({ error: 'cannot delete attachment owned by another uploader' }, 403);
    }
    const result = await ctx.attachmentService.deleteOrphan(id, {
      kind: 'user',
      userId: viewerUserId,
    });
    if (result.ok) return c.body(null, 204);
    if (result.error === 'not_found') {
      return c.json({ error: 'attachment not found' }, 404);
    }
    if (result.error === 'forbidden') {
      return c.json({ error: 'cannot delete attachment owned by another uploader' }, 403);
    }
    // 'in_use' — at least one persisted message still references this id.
    return c.json(
      { error: 'attachment is referenced by a message and cannot be deleted' },
      409,
    );
  });

  return app;
}
