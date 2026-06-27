import type { ObserveSource } from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import type { Principal } from '../auth/principal.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { ConversationReadRepo } from '../repos/conversation-read-repo.js';
import type { NotificationRepo } from '../repos/notification-repo.js';
import { canViewConversation } from '../permissions.js';
import { type PostCommitEffect, runPostCommitEffects } from './post-commit.js';

/**
 * observe() — the SINGLE eliminate primitive (#task:1231,
 * docs/observe-collapse-v1.md). Every read-cleared Activity item (and, before
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
 *   - one transaction (§6.2) over the whole batch; coalesced `unread_updated`
 *     post-commit (per-conversation message-variant + at-most-one badge-variant,
 *     §4), only when something actually changed.
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
  notifications: NotificationRepo;
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

  // Phase 2 — one transaction over the whole batch (§6.2). We track WHAT
  // changed, not just whether: the renderer discriminates `unread_updated` by
  // payload shape — a body WITH `conversation_id` refreshes the cursor / chip /
  // message-unread read-models, a body WITHOUT it refreshes the notification
  // badge. So a stream change must emit a per-conversation message-variant, and
  // any `read_at` change must emit a badge-variant; an empty coalesced event
  // would leave the cursor read-models stale.
  const outcome = deps.ctx.db.transaction(() => {
    const changedConversations = new Set<string>();
    let notificationChanged = false;
    for (const r of resolved) {
      if (r.kind === 'stream') {
        const current = deps.conversationReads.getLastReadSeq(
          input.viewerUserId,
          r.conversationId,
          r.threadRootId,
        );
        if (r.targetSeq > current) {
          deps.conversationReads.markRead({
            viewerUserId: input.viewerUserId,
            conversationId: r.conversationId,
            threadRootId: r.threadRootId,
            seq: r.targetSeq,
          });
          changedConversations.add(r.conversationId);
        }
        // overlap (§3): fold the directed clear into the positional one, even
        // when the cursor did not move (a lingering mention at/below the cursor
        // is still a real change). `markStreamMentionsRead` is monotonic /
        // idempotent — already-read mentions are skipped.
        const cleared = deps.notifications.markStreamMentionsRead({
          userId: input.viewerUserId,
          conversationId: r.conversationId,
          threadRootId: r.threadRootId,
          uptoSeq: r.targetSeq,
        });
        if (cleared > 0) {
          changedConversations.add(r.conversationId);
          notificationChanged = true;
        }
      } else {
        if (deps.notifications.markRead(r.notificationId, input.viewerUserId)) {
          notificationChanged = true;
        }
      }
    }
    return { changedConversations, notificationChanged };
  })();

  const changed =
    outcome.changedConversations.size > 0 || outcome.notificationChanged;

  if (changed) {
    // Coalesced (§4): exactly ONE message-variant per changed conversation
    // (deduped — a mainline + thread of the same channel collapse to one), and
    // AT MOST ONE badge-variant when any notification `read_at` changed. Both
    // ride the viewer scope. This is the faithful "coalesced" contract under the
    // renderer's two-variant discrimination — not a single literal event.
    const effects: PostCommitEffect[] = [];
    for (const conversationId of outcome.changedConversations) {
      effects.push(() =>
        deps.ctx.events.publishToScope(
          `viewer:${input.viewerUserId}`,
          'unread_updated',
          { conversation_id: conversationId },
        ),
      );
    }
    if (outcome.notificationChanged) {
      effects.push(() =>
        deps.ctx.events.publishToScope(
          `viewer:${input.viewerUserId}`,
          'unread_updated',
          // Badge variant: NO conversation_id (the predicate keys on its
          // absence) → routes to the notification-badge consumers, not the
          // cursor read-models.
          {},
        ),
      );
    }
    await runPostCommitEffects(effects, deps.ctx.logger);
  }

  return { ok: true, changed };
}
