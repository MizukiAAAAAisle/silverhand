// Attention bounded context (#task:1227, docs/activity-lifecycle-v1.md). The
// read-side context that projects the human's "queue waiting on me"; the
// user-facing surface is called Activity. It exposes the TWO write-side
// aggregates Attention owns — the per-(viewer, channel) ambient TIER (`所有消息 /
// 仅提及 / 静音`) and the per-(viewer, workspace) mute SUPPRESSOR above it
// (#task:1870) — plus the tiered badge read faces. The Activity list query
// (`listActivity`) and the source-routed read elimination endpoint (`observe`)
// also mount here.
//
// Auth/principal is inherited from the parent api app middleware.
import { Hono } from 'hono';
import {
  apiPaths,
  ObserveInputSchema,
  requireWorkspacePlacement,
  SetChannelAttentionPreferenceInputSchema,
  SetWorkspaceAttentionPreferenceInputSchema,
  type AttentionBadgeRollupDto,
  type AttentionPrefChangedPayload,
  type ChannelAttentionPreferenceDto,
  type ListActivityDto,
  type ObserveDto,
  type WorkspaceAttentionModesDto,
  type WorkspaceAttentionPreferenceDto,
} from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationReadRepo } from '../repos/conversation-read-repo.js';
import type { NotificationRepo } from '../repos/notification-repo.js';
import type { ChannelAttentionPreferenceRepo } from '../repos/channel-attention-preference-repo.js';
import type { WorkspaceAttentionPreferenceRepo } from '../repos/workspace-attention-preference-repo.js';
import type { AttentionBadgeRepo } from '../repos/attention-badge-repo.js';
import { getUserPrincipal, requireViewerUserId } from '../auth/principal.js';
import {
  canViewConversation,
  canViewOwnedState,
  canViewWorkspace,
} from '../permissions.js';
import type { ActivityReadModel } from '../read-model/activity.js';
import { observe, type ObserveErrorCode } from '../application/observe.js';
import type { ObservationPersistence } from '../application/observation-ports.js';
import { publishAttentionBadgeUpdated } from '../viewer-scope.js';

export interface AttentionRouteDeps {
  ctx: BackendContext;
  /** The Activity projection, handle bound at composition time (#task:1983 W2). */
  activity: ActivityReadModel;
  conversations: ConversationRepo;
  messages: MessageRepo;
  workspaces: WorkspaceRepo;
  conversationReads: ConversationReadRepo;
  notifications: NotificationRepo;
  channelAttentionPrefs: ChannelAttentionPreferenceRepo;
  workspaceAttentionPrefs: WorkspaceAttentionPreferenceRepo;
  attentionBadges: AttentionBadgeRepo;
  /** The observation write boundary (#task:1987 E) the `observe` primitive
   *  commits through. */
  observations: ObservationPersistence;
}

/** Map a typed observe() error to an HTTP status. not-found → 404, auth → 403,
 *  contract violations (bad position / reply-as-root) → 400. */
function observeErrorStatus(code: ObserveErrorCode): 400 | 403 | 404 {
  switch (code) {
    case 'forbidden':
      return 403;
    case 'conversation_not_found':
    case 'thread_root_not_found':
      return 404;
    default:
      return 400;
  }
}

export function createAttentionApp(deps: AttentionRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const {
    ctx,
    activity,
    conversations,
    workspaces,
    channelAttentionPrefs,
    workspaceAttentionPrefs,
    attentionBadges,
  } = deps;

  /**
   * Announce a preference write to the VIEWER'S OWN sessions (#task:1870).
   *
   * Two frames, two jobs, and neither substitutes for the other:
   *   - `attention_pref_changed` is IDENTITY ONLY (which workspace, which
   *     channel or `null` for the workspace-wide write). It invalidates the read
   *     faces that are functions of the preference — the Activity list and the
   *     tiers batch. Carrying the new value here would make the event a second
   *     authority for state those endpoints own.
   *   - `attention_badge_updated` carries the ABSOLUTE new badge, because a tier
   *     flip is one of the three things that move the badge WITHOUT moving any
   *     unread cursor. The client holds the badge with no refetch, so a missing
   *     frame here is a permanently wrong number, not a transient one.
   *
   * Viewer-scoped, never broadcast: an attention preference is personal state,
   * so no other member's projection changes. The frames still have to go out —
   * the mutating tab is not the viewer's only session.
   */
  const announcePrefWrite = (
    viewerUserId: string,
    workspaceId: string,
    conversationId: string | null,
  ): void => {
    const payload: AttentionPrefChangedPayload = {
      workspace_id: workspaceId,
      conversation_id: conversationId,
    };
    ctx.events.publishToScope(
      `viewer:${viewerUserId}`,
      'attention_pref_changed',
      payload,
    );
    publishAttentionBadgeUpdated(
      ctx.events,
      attentionBadges,
      workspaceId,
      viewerUserId,
    );
  };

  // There is NO per-channel GET for the stored tier (#task:1876). The tiers
  // BATCH (`GET /api/attention/modes?workspace_id=`) is the single read face for
  // a channel's own choice: it carries `mode` (stored) beside `effective_mode`
  // (suppressor folded in), and the controls are rendered as a group, so a
  // per-channel read would be both a second carrier of the same fact and N
  // round-trips. The write is per-channel because the decision is.
  //
  // PUT the viewer's ambient TIER for one channel — one of the two surfaces that
  // write attention state (§5.2); it never touches delivery/follow. Personal
  // state for a channel the viewer can view, so membership
  // (canViewConversation) is the gate — no owner/admin role needed.
  //
  // The stored value is the channel's OWN choice and is written verbatim: the
  // workspace suppressor is folded in on READ (`effective_mode` / the badge SQL),
  // never here, so un-muting a workspace restores exactly what each channel
  // chose.
  //
  // Two viewer-scoped frames go out (see `announcePrefWrite`). This replaces the
  // original "no server event is emitted" contract: that held while the pref only
  // gated the calling viewer's Activity list, and stopped holding when the tier
  // became an input to the workspace badge (#task:1870). The raw positional
  // roll-up is still pref-INDEPENDENT (§8 — the sidebar unread count did not
  // change), which is why the badge rides its own event instead of `unread_updated`.
  app.put(apiPaths.conversationAttentionPreference(':id'), async c => {
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
    // Both announced frames are keyed on (viewer, WORKSPACE), so the workspace
    // arm is asserted rather than coerced. It is guaranteed here by the
    // `getChannel` filter above: `kind` is GENERATED from `roster_policy`, so
    // `kind='channel'` means an open roster, and the only open-roster placement
    // is `workspace` (an agent inbox is `roster_policy='fixed'` ⇒
    // `kind='dm_channel'` ⇒ already 404 above). If a later placement ever
    // carries an open roster without a workspace, this fails loud instead of
    // publishing a badge frame no client can place.
    announcePrefWrite(viewerUserId, requireWorkspacePlacement(channel), channel.id);
    return c.json(dto);
  });

  // GET the viewer's mute SUPPRESSOR for one workspace. Absence of a stored row
  // resolves to the default server-side, so the response is always an explicit
  // boolean.
  //
  // Regular workspaces only: an `agent_home` workspace is a DM, whose unread is
  // directed-grade and structurally un-mutable (a DB trigger rejects the row), so
  // the route refuses it here rather than returning a `muted: false` the client
  // could try to flip.
  app.get(apiPaths.workspaceAttentionPreference(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    if (!canViewWorkspace(ctx, getUserPrincipal(c), id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const workspace = workspaces.get(id);
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    if (workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const viewerUserId = requireViewerUserId(c);
    const dto: WorkspaceAttentionPreferenceDto = {
      workspace_id: workspace.id,
      muted: workspaceAttentionPrefs.isMuted(viewerUserId, workspace.id),
    };
    return c.json(dto);
  });

  // PUT the viewer's mute SUPPRESSOR for one workspace — the second surface that
  // writes attention state. A boolean, not a fourth tier: it suppresses every
  // channel tier in the workspace without rewriting any of them, so nothing is
  // backfilled on mute and nothing is lost on un-mute.
  app.put(apiPaths.workspaceAttentionPreference(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    if (!canViewWorkspace(ctx, getUserPrincipal(c), id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const workspace = workspaces.get(id);
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    if (workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const viewerUserId = requireViewerUserId(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = SetWorkspaceAttentionPreferenceInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const row = workspaceAttentionPrefs.upsert({
      viewerUserId,
      workspaceId: workspace.id,
      muted: parsed.data.muted,
    });
    const dto: WorkspaceAttentionPreferenceDto = {
      workspace_id: row.workspace_id,
      muted: row.muted === 1,
    };
    // `conversation_id: null` — the write is workspace-wide, so every channel's
    // effective tier in it may have changed.
    announcePrefWrite(viewerUserId, workspace.id, null);
    return c.json(dto);
  });

  // GET the viewer's tiered badge for every workspace at once — the cold-start
  // read whose absolutes the `attention_badge_updated` frames then patch. The
  // badge is the viewer's own state, so the gate is owned-state; the projection
  // already scopes every row to the viewer's memberships.
  //
  // Workspaces at 0 are ABSENT from `by_workspace` (absent ≡ 0), which is what
  // keeps the payload proportional to what is actually loud.
  //
  // `muted_workspace_ids` rides along (#task:1877) so the rail can mark a muted
  // row without a second request. It is a SIBLING of `by_workspace`, never an
  // entry in it: a muted workspace is usually at 0 and therefore absent from that
  // map. Mute stays owned by the suppressor row — this is a projection of it, so
  // the workspace-level `attention_pref_changed` invalidates this read too.
  //
  // Both members of the payload are scoped to the viewer's CURRENT memberships:
  // preference rows outlive a workspace removal on purpose (a re-join restores the
  // viewer's earlier mute), so the mute projection joins `workspace_users` itself
  // rather than trusting row existence. The route gate is owned-state and takes no
  // workspace id, which is why that predicate lives in the query.
  app.get(apiPaths.attentionBadges, c => {
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const byWorkspace = attentionBadges.badgeCountsByWorkspace(viewerUserId);
    const dto: AttentionBadgeRollupDto = {
      by_workspace: byWorkspace,
      total: Object.values(byWorkspace).reduce((sum, n) => sum + n, 0),
      muted_workspace_ids:
        workspaceAttentionPrefs.mutedWorkspaceIds(viewerUserId),
    };
    return c.json(dto);
  });

  // GET every channel tier in ONE workspace plus the workspace suppressor — the
  // batch read behind the per-channel controls. One request per workspace rather
  // than one per channel: the control list is rendered as a set, and a per-channel
  // GET would make the muted-by-workspace explanation N round-trips.
  app.get(apiPaths.attentionModes, c => {
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const workspaceId = c.req.query('workspace_id');
    if (!workspaceId) return c.json({ error: 'workspace_id required' }, 400);
    if (!canViewWorkspace(ctx, getUserPrincipal(c), workspaceId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const dto: WorkspaceAttentionModesDto = {
      workspace_id: workspaceId,
      muted: workspaceAttentionPrefs.isMuted(viewerUserId, workspaceId),
      channels: attentionBadges.channelTiersForWorkspace(viewerUserId, workspaceId),
    };
    return c.json(dto);
  });


  // GET the viewer's Activity list (②c, §9.2 `listActivity`). Pure read-side
  // projection — directed mentions ∪ positional unread ∩ `enter()`, already
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
    const dto: ListActivityDto = activity.list({ viewerUserId, workspaceId });
    return c.json(dto);
  });

  // POST the single Attention eliminate primitive.
  // Base gate = owned-state (the viewer only observes their OWN read state);
  // per-source `canViewConversation` + root validation lives in the use case
  // (the endpoint accepts arbitrary conversation ids in the body, so each stream
  // source is gated individually — any illegal source fails the whole batch).
  app.post(apiPaths.attentionObserve, async c => {
    const viewerUserId = requireViewerUserId(c);
    const principal = getUserPrincipal(c);
    if (!canViewOwnedState(ctx, principal, viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ObserveInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await observe(deps, {
      principal,
      viewerUserId,
      sources: parsed.data.sources,
    });
    if (!result.ok) {
      return c.json(
        { error: result.error.message, code: result.error.code },
        observeErrorStatus(result.error.code),
      );
    }
    const dto: ObserveDto = { changed: result.changed };
    return c.json(dto);
  });

  return app;
}
