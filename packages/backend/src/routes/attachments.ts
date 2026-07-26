// Public attachment routes: channel upload, channel list, attachment download,
// and attachment delete. Upload goes via channel context so the server resolves
// the access boundary; clients never specify channel_id directly. Download is
// by id — auth is bearer (renderer) or v1-permissive (TODO when DM membership
// is enforceable per blob).
//
// `uploadAttachment` stays in the neutral leaf `./attachment-upload.js` — it is
// SHARED with `routes/internal-agent.ts` (the internal upload route). Folding it
// here would invert the boundary (internal-agent depending on the public
// attachment router); both contexts import the same leaf instead.
import { Hono } from 'hono';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type {
  AttachmentRepo,
  AttachmentSenderFilter,
} from '../repos/attachment-repo.js';
import {
  InvalidAttachmentListCursorError,
  decodeAttachmentListCursor,
  encodeAttachmentListCursor,
} from '../repos/attachment-repo.js';
import type { AttachmentListPage, AttachmentSenderFacets } from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { getUserPrincipal, requireViewerUserId } from '../auth/principal.js';
import {
  canDeleteAttachment,
  canPostToConversation,
  canViewAttachment,
  canViewConversation,
} from '../permissions.js';
import { uploadAttachment } from './attachment-upload.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIST_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, n);
}

// ── List filters ───────────────────────────────────────────────────────────
//
// Two axes, both validated strictly at the wire edge (missing/extra/unknown →
// 400, never silent-ignore) so the repo can trust the shape:
//   - sender: a discriminated identity. `sender_kind=user|agent` REQUIRES a
//     non-empty (non-whitespace) `sender_id`; `sender_kind=system` REQUIRES its
//     absence; a bare `sender_id` without `sender_kind` is rejected. Rejecting
//     a malformed filter beats quietly serving the unfiltered list under a
//     filtered UI.
//   - time: a half-open `[since, until)` window. Each bound, when present, is a
//     finite non-negative integer epoch-ms, and `since < until` strictly.

const INVALID_EPOCH = Symbol('invalid_epoch');

/** Parse an epoch-ms query param: absent → null, digits-only non-negative safe
 *  integer → the number, anything else (sign, decimal, whitespace, overflow) →
 *  the INVALID sentinel so the caller can 400. */
function parseEpochMs(
  raw: string | undefined,
): number | null | typeof INVALID_EPOCH {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) return INVALID_EPOCH;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : INVALID_EPOCH;
}

interface ParsedListFilters {
  sender: AttachmentSenderFilter | null;
  since: number | null;
  until: number | null;
}

type ListFilterResult =
  | { ok: true; value: ParsedListFilters }
  | { ok: false; error: string };

function parseListFilters(q: {
  senderKind: string | undefined;
  senderId: string | undefined;
  since: string | undefined;
  until: string | undefined;
}): ListFilterResult {
  let sender: AttachmentSenderFilter | null = null;
  if (q.senderKind !== undefined) {
    if (
      q.senderKind !== 'user' &&
      q.senderKind !== 'agent' &&
      q.senderKind !== 'system'
    ) {
      return { ok: false, error: 'sender_kind must be user, agent, or system' };
    }
    if (q.senderKind === 'system') {
      if (q.senderId !== undefined) {
        return { ok: false, error: 'sender_id must be omitted when sender_kind=system' };
      }
      sender = { kind: 'system', id: null };
    } else {
      if (q.senderId === undefined || q.senderId.trim().length === 0) {
        return { ok: false, error: `sender_id is required when sender_kind=${q.senderKind}` };
      }
      sender = { kind: q.senderKind, id: q.senderId };
    }
  } else if (q.senderId !== undefined) {
    return { ok: false, error: 'sender_id requires sender_kind' };
  }

  const since = parseEpochMs(q.since);
  if (since === INVALID_EPOCH) {
    return { ok: false, error: 'since must be a non-negative integer epoch-ms' };
  }
  const until = parseEpochMs(q.until);
  if (until === INVALID_EPOCH) {
    return { ok: false, error: 'until must be a non-negative integer epoch-ms' };
  }
  if (since !== null && until !== null && since >= until) {
    return { ok: false, error: 'since must be strictly less than until' };
  }
  return { ok: true, value: { sender, since, until } };
}

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

  // GET /api/channels/:id/attachments — channel Attachments panel data source
  // (#task:1481). Scope is persisted-message references (orphans excluded),
  // deduped by attachment id with the earliest reference selected
  // deterministically; keyset paginated by `(appeared_at, attachment_id)`.
  // Route resolver uses `getChannelLike` so DM channels resolve as well —
  // `getChannel` would 404 them. View-gate is `canViewConversation`, shared
  // with attachment download and other channel view surfaces.
  app.get(apiPaths.channelAttachments(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    // Enforced viewer required even though the read is not scoped further —
    // the auth middleware upstream rejects a missing viewer, but we still
    // demand the assertion so this route can never accidentally serve a
    // principal-less request if middleware wiring changes.
    requireViewerUserId(c);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const limit = parseLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    let cursor: ReturnType<typeof decodeAttachmentListCursor> | null = null;
    if (cursorRaw) {
      try {
        cursor = decodeAttachmentListCursor(cursorRaw);
      } catch (err) {
        if (err instanceof InvalidAttachmentListCursorError) {
          return c.json({ error: 'invalid cursor', code: 'invalid_cursor' }, 400);
        }
        throw err;
      }
    }
    const filters = parseListFilters({
      senderKind: c.req.query('sender_kind'),
      senderId: c.req.query('sender_id'),
      since: c.req.query('since'),
      until: c.req.query('until'),
    });
    if (!filters.ok) {
      return c.json({ error: filters.error, code: 'invalid_filter' }, 400);
    }
    const page = attachments.listChannelReferences(channel.id, {
      limit,
      cursor,
      sender: filters.value.sender,
      since: filters.value.since,
      until: filters.value.until,
    });
    const response: AttachmentListPage = {
      items: page.items,
      next_cursor:
        page.next_cursor === null
          ? null
          : encodeAttachmentListCursor(page.next_cursor),
    };
    return c.json(response, 200);
  });

  // GET /api/channels/:id/attachments/senders — distinct canonical-source
  // actors for the Attachments panel's sender filter. Same view gate as the
  // list; identity-only facets over the SAME dedup set the list filters
  // (canonical rows), so the dropdown never offers a sender that yields zero
  // rows. Time-independent by design (see the DTO doc).
  app.get(apiPaths.channelAttachmentSenders(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    requireViewerUserId(c);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const response: AttachmentSenderFacets = {
      senders: attachments.listChannelSenderFacets(channel.id),
    };
    return c.json(response, 200);
  });

  app.get(apiPaths.attachment(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'attachment id required' }, 400);
    requireViewerUserId(c);
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
