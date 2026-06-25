// Attention bounded context (#task:1227, docs/activity-lifecycle-v1.md). The
// read-side context that projects the human's "queue waiting on me"; the
// user-facing surface is called Activity. v1 (②a) exposes the ONE write-side
// aggregate Attention owns: the per-(viewer, channel) ambient preference (the
// channel `所有消息 / 仅提及` control). The Activity list query (`listActivity`,
// ②c) will mount here too, once #1226's per-stream cursor is dogfood-stable.
//
// Auth/principal is inherited from the parent api app middleware.
import { Hono } from 'hono';
import {
  apiPaths,
  SetChannelAttentionPreferenceInputSchema,
  type ChannelAttentionPreferenceDto,
  type ListActivityDto,
} from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { ChannelAttentionPreferenceRepo } from '../repos/channel-attention-preference-repo.js';
import { getUserPrincipal, requireViewerUserId } from '../auth/principal.js';
import { canViewConversation, canViewOwnedState } from '../permissions.js';
import { listActivity } from '../read-model/activity.js';

export interface AttentionRouteDeps {
  ctx: BackendContext;
  conversations: ConversationRepo;
  channelAttentionPrefs: ChannelAttentionPreferenceRepo;
}

export function createAttentionApp(deps: AttentionRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, conversations, channelAttentionPrefs } = deps;

  // GET the viewer's effective ambient preference for one channel. The default
  // is applied server-side (§6 channel default = ambient off), so the response
  // `mode` is always resolved — the client never branches on "unset".
  app.get(apiPaths.conversationAttentionPreference(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    // Regular channel only. A DM's unread is directed-grade (always enters
    // Activity, §5.1) and a thread's ambient default is follow-driven delivery
    // — neither has a channel ambient preference. getChannel returns null
    // (→ 404) for dm_channel and thread alike; a DB trigger is the fail-loud
    // backstop against any non-route writer.
    const channel = conversations.getChannel(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const viewerUserId = requireViewerUserId(c);
    const mode = channelAttentionPrefs.getEffectiveMode(viewerUserId, channel.id);
    const dto: ChannelAttentionPreferenceDto = {
      conversation_id: channel.id,
      mode,
    };
    return c.json(dto);
  });

  // PUT the viewer's ambient preference for one channel. This is the ONLY
  // surface that writes attention state (§5.2); it never touches
  // delivery/follow. Personal state for a channel the viewer can view, so
  // membership (canViewConversation) is the gate — no owner/admin role needed.
  //
  // No invalidation event is published yet: nothing reads this preference until
  // `listActivity` (②c) lands. When it does, a viewer-scoped Activity
  // invalidation belongs here (the channel unread roll-up / sidebar badge is
  // pref-INDEPENDENT — §8 — so `unread_updated` is deliberately NOT emitted).
  app.put(apiPaths.conversationAttentionPreference(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannel(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const viewerUserId = requireViewerUserId(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = SetChannelAttentionPreferenceInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const row = channelAttentionPrefs.upsert({
      viewerUserId,
      conversationId: channel.id,
      mode: parsed.data.mode,
    });
    const dto: ChannelAttentionPreferenceDto = {
      conversation_id: row.conversation_id,
      mode: row.mode,
    };
    return c.json(dto);
  });

  // GET the viewer's Activity list (②c, §9.2 `listActivity`). Pure read-side
  // projection — directed mentions/tasks ∪ positional unread ∩ `enter()`, already
  // deduped (§7) + salience-sorted (§13.2). The Activity list is the viewer's
  // own state (like the message-unread summary), so the gate is owned-state
  // (canViewOwnedState), not a conversation membership check — the read-model
  // already scopes every row to conversations the viewer belongs to.
  app.get(apiPaths.activity, c => {
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const workspaceId = c.req.query('workspace_id') || undefined;
    const dto: ListActivityDto = listActivity(ctx, { viewerUserId, workspaceId });
    return c.json(dto);
  });

  return app;
}
