// Attachment upload/update route adapters shared by the public channel/thread
// routes and the internal-agent routes. Multipart request ->
// AttachmentService adapter; not a response mapper, so it lives in its own
// neutral leaf rather than routes/responses.ts.
import { type Context } from 'hono';
import { ATTACHMENT_CHANGED_EVENT, type AttachmentCreatorKind } from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import { AttachmentRejection } from '../services/attachment-service.js';

export async function uploadAttachment(
  ctx: BackendContext,
  c: Context,
  sourceConversationId: string,
  createdByKind: 'user' | 'agent',
  createdById: string,
): Promise<Response> {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (err) {
    ctx.logger.warn(
      { sourceConversationId, err },
      'api: attachment upload — multipart parse failed',
    );
    return c.json({ error: 'multipart/form-data required' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: 'file field required' }, 400);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const dto = await ctx.attachmentService.upload({
      sourceConversationId,
      filename: file.name,
      contentType: file.type || null,
      buffer,
      createdByKind,
      createdById,
    });
    return c.json(dto, 201);
  } catch (err) {
    if (err instanceof AttachmentRejection) {
      const status = err.failure.kind === 'too_large' ? 413 : 400;
      return c.json({ error: err.message, code: err.failure.kind }, status);
    }
    throw err;
  }
}

/**
 * Content update adapter (creator-only, in-place pointer-swap). The caller has
 * already resolved the row and enforced the update ACL (`canUpdateAttachment`
 * for the human route; membership + capability + creator for the agent route);
 * the service re-checks creator ownership as defense-in-depth.
 *
 * On success it emits `attachment_changed` on the channel SIDE CHANNEL — a
 * cursor-inert cache-bust that must NOT advance message seq / stream head /
 * read cursor (`docs/attachments-design.md` §4.3 freshness exclusion). The payload
 * names WHAT got fresher (`attachment_id` + new `content_revision`), not the
 * bytes; the renderer refetches the authoritative DTO/bytes off that signal.
 */
export async function updateAttachment(
  ctx: BackendContext,
  c: Context,
  attachmentId: string,
  updater: { kind: AttachmentCreatorKind; id: string },
  opts: { requireCallerChannelOf?: string } = {},
): Promise<Response> {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (err) {
    ctx.logger.warn(
      { attachmentId, err },
      'api: attachment update — multipart parse failed',
    );
    return c.json({ error: 'multipart/form-data required' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: 'file field required' }, 400);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const result = await ctx.attachmentService.update(attachmentId, buffer, updater, opts);
    if (!result.ok) {
      if (result.error === 'not_found') {
        return c.json({ error: 'attachment not found' }, 404);
      }
      return c.json({ error: 'cannot update attachment owned by another uploader' }, 403);
    }
    // Post-write cache-bust on the side channel (see the doc comment above).
    ctx.events.publishSide(result.dto.channel_id, {
      kind: ATTACHMENT_CHANGED_EVENT,
      payload: {
        attachment_id: result.dto.id,
        content_revision: result.dto.content_revision,
      },
    });
    return c.json(result.dto, 200);
  } catch (err) {
    if (err instanceof AttachmentRejection) {
      const status = err.failure.kind === 'too_large' ? 413 : 400;
      return c.json({ error: err.message, code: err.failure.kind }, status);
    }
    throw err;
  }
}
