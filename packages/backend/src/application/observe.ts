import {
  requireWorkspacePlacement,
  type ObserveSource,
  type UnreadUpdatedBadgePayload,
} from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { Principal } from '../auth/principal.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { ConversationReadRepo } from '../repos/conversation-read-repo.js';
import type { AttentionBadgeRepo } from '../repos/attention-badge-repo.js';
import { canViewConversation } from '../permissions.js';
import { publishDirectPairsChangedToViewer } from './direct-pairs-changed.js';
import {
  publishAttentionBadgeUpdated,
  publishUnreadUpdatedToViewer,
} from '../viewer-scope.js';
import type { ObservationPersistence } from './observation-ports.js';
import { type PostCommitEffect, runPostCommitEffects } from './post-commit.js';

/**
 * observe() — the SINGLE Attention eliminate primitive. Every read-cleared
 * Activity item (and, before
 * its retirement in #task:1232, the legacy channel mark-read route) collapses
 * here; the write is delegated back to the source aggregate (the per-stream
 * cursor `conversation_reads`, or `notifications.read_at`). Attention owns NO
 * read state of its own.
 *
 * The load-bearing invariants live in what this use case does and does NOT do:
 *   - CURSOR is written through exactly ONE path: `observe(stream)` → this
 *     use case (read_at still has two legit writers: the overlap below + the
 *     notification surface). There is no second cursor writer.
 *   - A `stream` position is a TYPED variant — an `at_seq` pins a client-
 *     observed seq; `stream_head` resolves the current head server-side. The
 *     §9.10 tail-swallow guard is on the CALLER-INTENT axis (an AUTO open/live
 *     path must pin `at_seq`), NOT the stream shape — so `stream_head` is legal
 *     for an explicit clear of ANY stream, thread included. That discipline
 *     lives at the AUTO callers (the renderer's typed source builders, which
 *     structurally cannot emit `thread + stream_head`), not here — the backend
 *     sees only one request and cannot tell caller intent apart.
 *   - overlap (§3): a positional clear folds in the directed clear — advancing
 *     a stream cursor to N also marks `seq <= N` `mention_self` notifications in
 *     that stream read, IN THE SAME TRANSACTION, so the non-derived `/n/unread`
 *     badge never lingers as a second truth. The reverse is NOT symmetric: a
 *     `notification` clear never reverse-advances a cursor.
 *   - per-source auth (§6.1): the endpoint accepts arbitrary conversation ids,
 *     so every `stream` source is gated by `canViewConversation` + root
 *     validation. Any illegal source fails the WHOLE batch — never partial.
 *   - one transaction (§6.2) over the whole batch — since #task:1987 E the
 *     viewer-keyed `ObservationUnitOfWork`, so the batch cannot half-apply the
 *     overlap and the use case cannot write a cursor outside it (or write another
 *     viewer's read state at all); coalesced `unread_updated` post-commit
 *     (per-conversation message-variant + at-most-one badge-variant, §4), only
 *     when something actually changed.
 */
export type ObserveErrorCode =
  | 'forbidden'
  | 'conversation_not_found'
  | 'thread_root_not_found'
  | 'thread_root_is_reply'
  | 'position_future';

export type ObserveError = { code: ObserveErrorCode; message: string };

export type ObserveResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: ObserveError };

export type ObserveDeps = {
  ctx: BackendContext;
  conversations: ConversationRepo;
  messages: MessageRepo;
  conversationReads: ConversationReadRepo;
  /** Tiered-badge projection (#task:1870). Reading is one of the three sources
   *  that move the badge, and a `notification` clear moves it WITHOUT moving any
   *  cursor — see the directed-only emit below. */
  attentionBadges: AttentionBadgeRepo;
  /** The observation write boundary (#task:1987 E). The use case holds NO
   *  transaction capability and no notification repo of its own: every cursor /
   *  `read_at` write happens through the viewer-bound scope below. */
  observations: ObservationPersistence;
};

export type ObserveInput = {
  principal: Principal;
  /** The resolved viewer (cursor / notification rows are keyed by this). */
  viewerUserId: string;
  sources: ObserveSource[];
};

/** A `stream` source after validation: the cursor target seq is resolved and
 *  the root/visibility checks have passed. */
type ResolvedStream = {
  kind: 'stream';
  conversationId: string;
  threadRootId: string | null;
  targetSeq: number;
};
type ResolvedNotification = { kind: 'notification'; notificationId: string };
type ResolvedSource = ResolvedStream | ResolvedNotification;

/**
 * Validate + resolve ONE source (no writes). Carries the per-stream read
 * resolution with the same friendly errors the retired channel mark-read route
 * (#task:1232) used to return:
 *   - channel-like visibility (`canViewConversation`);
 *   - root message exists / belongs to this conversation / is a root not a
 *     reply (`thread_root_not_found` / `thread_root_is_reply`);
 *   - position → seq: `stream_head` resolves the current head of ANY stream
 *     (mainline or thread); an `at_seq` past the stream head is rejected
 *     (`position_future`). The AUTO-caller guard (open/live must pin `at_seq`)
 *     lives at the caller (renderer typed builders), NOT here (§9.10 is on the
 *     caller-intent axis, not the stream shape).
 */
function resolveSource(
  deps: ObserveDeps,
  input: ObserveInput,
  source: ObserveSource,
): { ok: true; resolved: ResolvedNotification }
  | { ok: true; resolved: ResolvedStream }
  | { ok: false; error: ObserveError } {
  if (source.kind === 'notification') {
    // By-id, user-scoped at write time (`markRead(id, viewer)`). A missing /
    // already-read / not-yours notification is an idempotent no-op, not an
    // error, so there is nothing to pre-validate here.
    return {
      ok: true,
      resolved: { kind: 'notification', notificationId: source.notification_id },
    };
  }

  const { conversation_id: conversationId, thread_root_id: threadRootId } = source;

  // Channel-like only: a `stream` source's conversation id is always the
  // channel/dm_channel; a legacy `kind='thread'` conversation is not a stream
  // root here (the reply-cluster is addressed via `thread_root_id`).
  const channel = deps.conversations.getChannelLike(conversationId);
  if (!channel) {
    return {
      ok: false,
      error: { code: 'conversation_not_found', message: 'conversation not found' },
    };
  }
  if (!canViewConversation(deps.ctx, input.principal, channel.id)) {
    return {
      ok: false,
      error: { code: 'forbidden', message: 'cannot observe this conversation' },
    };
  }

  if (threadRootId !== null) {
    const rootMessage = deps.messages.getById(threadRootId);
    if (!rootMessage || rootMessage.conversation_id !== conversationId) {
      return {
        ok: false,
        error: {
          code: 'thread_root_not_found',
          message: 'thread root message not found in this channel',
        },
      };
    }
    if (rootMessage.thread_root_id !== null) {
      return {
        ok: false,
        error: {
          code: 'thread_root_is_reply',
          message: 'thread_root_id must be a root message, not a reply',
        },
      };
    }
  }

  const streamHead = deps.messages.streamHeadLatestSeq(conversationId, threadRootId);
  let targetSeq: number;
  if (source.position.kind === 'at_seq') {
    if (source.position.seq > streamHead) {
      return {
        ok: false,
        error: {
          code: 'position_future',
          message: 'position seq is beyond the current stream head',
        },
      };
    }
    targetSeq = source.position.seq;
  } else {
    // stream_head: server-resolved current head of THIS stream — mainline OR
    // thread. Legit only for an EXPLICIT clear (channel/thread open + Mark-all +
    // ambient hover-✓), which knowingly swallows the concurrent tail. The
    // §9.10 tail-swallow guard is on the CALLER-INTENT axis, not the stream
    // shape: an AUTO path (ThreadPanel open-time / visible-live) must pin an
    // `at_seq`, and that discipline is enforced at those callers — the renderer's
    // typed source builders structurally cannot emit `thread + stream_head` — NOT
    // by banning thread + stream_head here, which would make an Activity
    // followed-thread unread item impossible to hover-✓ / Mark-all.
    targetSeq = streamHead;
  }

  return {
    ok: true,
    resolved: { kind: 'stream', conversationId, threadRootId, targetSeq },
  };
}

export async function observe(
  deps: ObserveDeps,
  input: ObserveInput,
): Promise<ObserveResult> {
  // Phase 1 — validate + resolve EVERY source before any write (fail-fast). An
  // illegal source aborts the whole request; no partial clear (§6.1).
  const resolved: ResolvedSource[] = [];
  for (const source of input.sources) {
    const r = resolveSource(deps, input, source);
    if (!r.ok) return r;
    resolved.push(r.resolved);
  }

  // Phase 2 — ONE transaction over the whole batch (§6.2), through the
  // viewer-bound observation scope (#task:1987 E): the use case holds no
  // transaction and no way to write another viewer's read state. We track WHAT
  // changed, not just whether: the renderer discriminates `unread_updated` by
  // payload shape — a body WITH `conversation_id` refreshes the cursor / chip /
  // message-unread read-models, a body WITHOUT it refreshes the notification
  // badge. So a stream change must emit a per-conversation message-variant, and
  // any `read_at` change must emit a badge-variant; an empty coalesced event
  // would leave the cursor read-models stale.
  const outcome = deps.observations.uow.atomicallyForViewer(
    { viewerUserId: input.viewerUserId },
    tx => {
      const changedConversations = new Set<string>();
      let notificationChanged = false;
      // Workspaces whose TIERED badge (#task:1870) moved through a directed clear
      // ONLY — a `notification` source flips `read_at` without touching any
      // cursor, so no per-conversation frame would carry the new badge. Streams are
      // absent from this set on purpose: their workspace is already covered by the
      // co-emitting per-conversation seam.
      const directedOnlyBadgeWorkspaces = new Set<string>();
      // The notification ids this batch flipped unread→read. Carried out to the
      // badge-variant event so the OS-notification-dismiss projection (#task:1431)
      // can `.close()` exactly these — the client never re-derives read state.
      const dismissedNotificationIds: string[] = [];
      for (const r of resolved) {
        if (r.kind === 'stream') {
          const stream = {
            conversationId: r.conversationId,
            threadRootId: r.threadRootId,
            targetSeq: r.targetSeq,
          };
          if (tx.viewer.advanceStreamCursor(stream)) {
            changedConversations.add(r.conversationId);
          }
          // overlap (§3): fold the directed clear into the positional one, even
          // when the cursor did not move (a lingering mention at/below the cursor
          // is still a real change). The port's clear is monotonic / idempotent —
          // already-read mentions are skipped — and returns the ids it actually
          // flipped, bounded by the SAME seq the cursor advanced to.
          const clearedIds = tx.viewer.clearStreamMentions(stream);
          if (clearedIds.length > 0) {
            changedConversations.add(r.conversationId);
            notificationChanged = true;
            dismissedNotificationIds.push(...clearedIds);
          }
        } else {
          const cleared = tx.viewer.clearNotification(r.notificationId);
          if (cleared.cleared) {
            notificationChanged = true;
            dismissedNotificationIds.push(r.notificationId);
            // Only `mention_self` in a live conversation feeds the badge's directed
            // term, and the attribution is the CONVERSATION's workspace (same
            // column the positional term groups by) — an anchorless
            // `agent_start_failed` or a CC'd `mention_external` never counted, so
            // clearing it moves no badge. The facts exist only in the `cleared`
            // arm, so this attribution cannot be made for a row this batch did not
            // clear.
            if (cleared.kind === 'mention_self' && cleared.anchorWorkspaceId) {
              directedOnlyBadgeWorkspaces.add(cleared.anchorWorkspaceId);
            }
          }
        }
      }
      return {
        changedConversations,
        notificationChanged,
        dismissedNotificationIds,
        directedOnlyBadgeWorkspaces,
      };
    },
  );

  const changed =
    outcome.changedConversations.size > 0 || outcome.notificationChanged;

  if (changed) {
    // Coalesced (§4): exactly ONE message-variant per changed conversation
    // (deduped — a mainline + thread of the same channel collapse to one), and
    // AT MOST ONE badge-variant when any notification `read_at` changed. Both
    // ride the viewer scope. This is the faithful "coalesced" contract under the
    // renderer's two-variant discrimination — not a single literal event.
    // Orthogonal to both: at most ONE `attention_badge_updated` per touched
    // workspace (#task:1870) — a different face of the same facts, deduped on the
    // workspace axis because its value is absolute.
    const effects: PostCommitEffect[] = [];
    const badgedWorkspaces = new Set<string>();
    for (const conversationId of outcome.changedConversations) {
      const conversation = deps.conversations.get(conversationId);
      if (!conversation) continue;
      // PLACEMENT SPLIT, and it lives HERE rather than inside a widened publisher
      // (#task:2035, same shape as `conversation-message/delivery.ts`). Both
      // workspace frames are keyed on (viewer, WORKSPACE): `workspace_unread_count`
      // and the tiered badge are workspace roll-ups, so that read model has no
      // shape for a placement carrying no workspace coordinate, and its publisher
      // says so by throwing.
      //
      // A `direct_pair` now reaches this loop for real: its HUMAN ENDPOINT is a
      // participant (§4.2 dispatch in `permissions.ts`), so the viewer may open the
      // line and clear it — and the cursor is committed by the transaction above
      // BEFORE anything here runs. An unconditional `requireWorkspacePlacement`
      // therefore turned every DM read into "cursor lowered, 500 returned, client
      // never told": the worst of both outcomes. What the viewer's DM row shows is
      // its unread, so the honest frame is the list invalidation.
      if (conversation.placement_kind === 'direct_pair') {
        // Only the OBSERVING viewer: this batch moved their read state and nobody
        // else's (the unit of work is viewer-bound), exactly as the workspace arm
        // publishes to `input.viewerUserId` alone.
        effects.push(() =>
          publishDirectPairsChangedToViewer(deps.ctx.events, input.viewerUserId, {
            conversation_id: conversationId,
          }),
        );
        continue;
      }
      // What remains is the workspace arm, and since #task:2072 the two placements
      // are exhaustive — so `requireWorkspacePlacement` is an ASSERTION of that,
      // not a filter. A row reaching it without a workspace coordinate is a corrupt
      // row or a placement added without an arm above; both must fail loud rather
      // than silently badge nothing.
      const workspaceId = requireWorkspacePlacement(conversation);
      badgedWorkspaces.add(workspaceId);
      // Enriched message variant (#task:1283): the closure runs POST-COMMIT, so
      // the counts reflect the just-lowered read state — the same authoritative
      // absolutes as arrival, so read/clear patches badges via one shape (no
      // half-model where read refetches). The seam co-emits this workspace's
      // tiered badge (#task:1870); a positional clear lowers both faces.
      effects.push(() =>
        publishUnreadUpdatedToViewer(
          deps.ctx.events,
          deps.attentionBadges,
          deps.conversationReads,
          conversationId,
          workspaceId,
          input.viewerUserId,
        ),
      );
    }
    // Directed-only clears: no cursor moved, so nothing above carried this
    // workspace's badge. Absolute, so a workspace already badged above needs no
    // second frame.
    for (const workspaceId of outcome.directedOnlyBadgeWorkspaces) {
      if (badgedWorkspaces.has(workspaceId)) continue;
      badgedWorkspaces.add(workspaceId);
      effects.push(() =>
        publishAttentionBadgeUpdated(
          deps.ctx.events,
          deps.attentionBadges,
          workspaceId,
          input.viewerUserId,
        ),
      );
    }
    if (outcome.notificationChanged) {
      // Badge variant: NO conversation_id (the predicate keys on its absence) →
      // routes to the notification-badge consumers, not the cursor read-models.
      // It also carries the ids just marked read so the single viewer-scope
      // handler can fan the "notification read" fact to the OS-dismiss projection
      // (#task:1431) — same fact, one event, no per-projection event.
      const badgePayload: UnreadUpdatedBadgePayload = {
        dismissed_notification_ids: outcome.dismissedNotificationIds,
      };
      effects.push(() =>
        deps.ctx.events.publishToScope(
          `viewer:${input.viewerUserId}`,
          'unread_updated',
          badgePayload,
        ),
      );
    }
    await runPostCommitEffects(effects, deps.ctx.logger);
  }

  return { ok: true, changed };
}
