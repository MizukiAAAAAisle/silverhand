import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
  MESSAGE_REACTION_CHANGED_EVENT,
  parseConversationScope,
  parseConversationSideScope,
} from '@silverhand/shared';
import type {
  AgentRunState,
  ConversationActivityEvent,
  MessageDto,
  MessageEventPayload,
  MessageProjections,
  MessageReactionChangedEvent,
  ServerFrame,
  TaskChangedEvent,
} from '@silverhand/shared';
import { onWsFrame, eventWsClient } from '@/lib/ws-client';
import { getCurrentUserId } from '@/lib/current-user';
import {
  appendAgentActivityToCache,
  hasActiveAgentActivityReader,
  reconcileAgentActivityOnSnapshotRequired,
} from '@/features/agents/useAgentActivityFeed';
import {
  applyAgentRunStateToCache,
  hasActiveAgentRunStatesReader,
  invalidateAgentRunStates,
} from '@/lib/agentRunStateCache';
import {
  hasActiveChannelThreadsReader,
  invalidateChannelThreadsList,
} from '@/features/channels/useChannelThreads';
import {
  applyAgentStatusToCache,
  applyClusterMessageToCaches,
  applyMainlineMessageToChannelCaches,
  applyReactionToMessage,
  applyTaskChangedToMessage,
  applyThreadFollowersMessage,
  applyThreadRootReplyBump,
  hasActiveChannelAgentsReader,
  hasActiveMainlineReader,
  hasWarmInactiveMainline,
  invalidateThreadFollowers,
  openClusterReaderRoots,
  openThreadFollowerReaderRoots,
  openThreadRootReaderRoots,
  patchMessageInActiveProjections,
  reconcileChannelAgentsOnSnapshotRequired,
  reconcileChannelMainlineOnSnapshotRequired,
  reconcileClusterOnSnapshotRequired,
  reconcileThreadRootOnSnapshotRequired,
  removeInactiveClusterCache,
  removeInactiveMainlineCache,
  warmInactiveClusterRoots,
} from '@/features/channels/hooks';
import type { ConversationAgentStatusPatch } from '@/features/channels/hooks';
import { messageReactorsKey } from '@/features/channels/reaction-hooks';
import { applyTaskChangedToTaskByNumberCache } from '@/features/tasks/useTaskByNumber';
import {
  dispositionSettle,
  ingestMessageProjections,
  validateMessageProjections,
} from './projection-registry';

type ReplayCursorEffect = 'content-apply' | 'cursor-inert';
type ReplayRecoveryEffect =
  | 'idempotent'
  | 'authoritative-invalidate'
  | 'side-scope-self-healing';

type ReplaySafetySpec = {
  readonly cursor: ReplayCursorEffect;
  readonly recovery: ReplayRecoveryEffect;
  readonly summary: string;
};

/** Replay-safety contract for every cache effect this ingestor can produce
 *  (#task:1262, reclassified for #task:1263 (c)). A new event kind or cache write
 *  must first be categorized here:
 *  - `content-apply` is satisfied by a synchronous content write (an in-window
 *    append / chip·reaction patch / live-gap affordance) — idempotent on replay;
 *  - `cursor-inert` is satisfied by an AUTHORITATIVE invalidate settling: it holds
 *    only a message-DERIVED projection (a reply count, a followers/threads list),
 *    never message content, so it recovers by refetching its own source.
 *
 *  Under #1261 the message-stream floor advances on SATISFACTION — a per-frame
 *  `Promise.allSettled` over BOTH classes' effect promises, all-fulfilled — not on
 *  "content-apply only". So `cursor` now documents the recovery MECHANISM
 *  (content-commit vs authoritative-invalidate), not a runtime floor-gate: a
 *  cursor-inert effect DOES advance the floor, but only once its refetch COMMITS
 *  (initiated ≠ committed, §4.1). #1263 (c) moved the reply-count effects here:
 *  the old optimistic `+1` was non-idempotent and double-counted on replay, so a
 *  reply count is now recovered authoritatively like any other derived list.
 *
 *  This table is deliberately about cache EFFECTS, not wire kinds: one `message`
 *  frame can append an idempotent cluster row (content-apply), authoritatively
 *  recover a reply count (cursor-inert), and invalidate a derived list
 *  (cursor-inert). */
export const REPLAY_SAFETY_CONTRACTS = {
  mainline_row_window: {
    cursor: 'content-apply',
    recovery: 'idempotent',
    summary:
      'mainline row append / live-gap affordance is id-deduped content; the row loads authoritatively when the window reaches tail',
  },
  mainline_reply_count: {
    cursor: 'cursor-inert',
    recovery: 'authoritative-invalidate',
    summary:
      'mainline reply badge is a message-derived count; #1263 (c) recovers it authoritatively (no optimistic +1), replay-safe',
  },
  cluster_message_window: {
    cursor: 'content-apply',
    recovery: 'idempotent',
    summary: 'cluster message append is deduped by message id',
  },
  thread_root_reply_count: {
    cursor: 'cursor-inert',
    recovery: 'authoritative-invalidate',
    summary:
      'thread-root reply count is message-derived; #1263 (c) recovers it authoritatively (no optimistic +1), replay-safe',
  },
  thread_followers_invalidate: {
    cursor: 'cursor-inert',
    recovery: 'authoritative-invalidate',
    summary:
      'followers projection refetches from its own source',
  },
  channel_threads_invalidate: {
    cursor: 'cursor-inert',
    recovery: 'authoritative-invalidate',
    summary: 'threads list is message-derived invalidate, not message content',
  },
  task_message_patch: {
    cursor: 'content-apply',
    recovery: 'idempotent',
    summary: 'task chip patch sets fields by message id',
  },
  reaction_message_patch: {
    cursor: 'content-apply',
    recovery: 'idempotent',
    summary:
      'reaction patch sets absolute reaction state by message id — the FLOOR-BEARING effect of a reaction frame (its synchronous content-apply gate)',
  },
  reactors_list_refresh: {
    cursor: 'cursor-inert',
    recovery: 'authoritative-invalidate',
    summary:
      'reactors popover detail list (who-reacted) refreshed by the reaction patch — a FIRE-AND-FORGET, authoritative-on-open detail invalidate. NOT resume-floor-bearing: a reaction frame keeps the SYNCHRONOUS content-apply gate on reaction_message_patch (#1263 hybrid boundary), so unlike a `message` frame this cursor-inert effect is deliberately NOT commit-gated via allSettled — do not "unify" it into the message satisfaction path',
  },
  agent_run_states: {
    cursor: 'cursor-inert',
    recovery: 'side-scope-self-healing',
    summary: 'side scope cache with its own refetch-on-mount/snapshot reconcile',
  },
  channel_agents: {
    cursor: 'cursor-inert',
    recovery: 'side-scope-self-healing',
    summary: 'side scope agents cache with snapshot reconcile and pending patch buffer',
  },
  agent_activity_feed: {
    cursor: 'cursor-inert',
    recovery: 'side-scope-self-healing',
    summary: 'side scope activity feed merges by row id and has REST cold-start',
  },
} as const satisfies Record<string, ReplaySafetySpec>;

type ReplaySafetyContracts = typeof REPLAY_SAFETY_CONTRACTS;
type ReplayEffectId = keyof ReplaySafetyContracts;
type ReplayEffectByCursor<C extends ReplayCursorEffect> = {
  [K in ReplayEffectId]: ReplaySafetyContracts[K]['cursor'] extends C ? K : never;
}[ReplayEffectId];

function contentEffectApplied(
  _effect: ReplayEffectByCursor<'content-apply'>,
  applied: boolean,
): boolean {
  return applied;
}

function cursorInertEffect(_effect: ReplayEffectByCursor<'cursor-inert'>): void {}

export const MESSAGE_STREAM_KIND_CONTRACTS = {
  message: [
    'mainline_row_window',
    'mainline_reply_count',
    'cluster_message_window',
    'thread_root_reply_count',
    'thread_followers_invalidate',
    'channel_threads_invalidate',
  ],
  task_changed: ['task_message_patch'],
  [MESSAGE_REACTION_CHANGED_EVENT]: [
    'reaction_message_patch',
    'reactors_list_refresh',
  ],
} as const satisfies Record<string, readonly ReplayEffectId[]>;

type MessageStreamKind = keyof typeof MESSAGE_STREAM_KIND_CONTRACTS;

export const SIDE_KIND_CONTRACTS = {
  agent_activity: ['agent_run_states'],
  agent_status: ['channel_agents'],
  conversation_activity: ['agent_activity_feed'],
} as const satisfies Record<string, readonly ReplayEffectId[]>;

type SideKind = keyof typeof SIDE_KIND_CONTRACTS;

function asMessageStreamKind(kind: string): MessageStreamKind | null {
  return kind in MESSAGE_STREAM_KIND_CONTRACTS
    ? (kind as MessageStreamKind)
    : null;
}

function asSideKind(kind: string): SideKind | null {
  return kind in SIDE_KIND_CONTRACTS ? (kind as SideKind) : null;
}

/**
 * Stage-2 central conversation ingestor (#task:1255).
 *
 * The single App-level consumer of conversation realtime frames across BOTH
 * transport scopes — the message stream `conversation:<id>` (message /
 * message_reaction_changed / task_changed) and the side channel
 * `conversation-side:<id>` (agent_status / agent_activity /
 * conversation_activity). It owns the cache writes that used to
 * live in each view's `onWsFrame` handler, so views can be
 * pure readers (zero `onWsFrame`) — the precondition Stage-2 P2 needs to drop the
 * orphan gate (gate-(b)). See docs/renderer-event-ingestion-v1.md and
 * docs/event-ws-recovery-class-scope-v1.md.
 *
 * P1a + P1b + P1c scope: the main-stream caches (old
 * `useChannelMessages.onEvent`), the thread cluster / root / followers caches
 * (old `useThreadCluster` / `useThreadRoot` / `useThreadFollowers` `onEvent`s),
 * the channel Threads list (old `useChannelThreads.onEvent`), `agent_activity`
 * + run-states reconcile (old `useAgentRunStates.onEvent` + the shared bridge
 * side-effect), `agent_status` (old `useChannelAgents.onEvent`), and
 * `conversation_activity` (old `AgentActivityTimeline.onEvent`). The message-
 * window and product-projection caches are all driven HERE; the one exception is
 * `useConversationMembers` — a side-scope, invalidate-only consumer that keeps
 * its own `onWsFrame` (cursor-inert: no message-window cache, just a members
 * refetch on `conversation_members_changed`). `ChannelView`'s
 * read cursor is NOT here by design — read advancement stays on the read axis
 * (`useMarkMessageChannelRead`), driven by the mainline cache, not frame arrival
 * (read-inert, #1244/#1251).
 *
 * SCOPE PARTITION (#task:1255 P2 step-3). The recovery classes are split across
 * two disjoint transport scopes. Routing goes through the SHARED parsers only
 * (`parseConversationScope` / `parseConversationSideScope`) — never a fuzzy
 * `startsWith('conversation')` — so a side frame never reaches a message-stream
 * apply and vice-versa. Side kinds publish to `conversation-side:<id>` (backend
 * cutover = Alice P2 step-2); a `snapshot_required` reconciles only the caches of
 * the scope it arrived on. The message-derived Threads list / thread followers
 * STAY on the message stream (their liveness rides the `message` kind).
 *
 * PER-TARGET READER GATE (behavior equivalence — P1 = prep, not correctness):
 * each write ran in the old code ONLY while its hook was mounted. The ingestor
 * preserves that — mainline writes gate on {@link hasActiveMainlineReader};
 * cluster / root / follower writes enumerate the OPEN reader roots (those with a
 * live observer) and apply per-root. A scope kept subscribed by INTEREST alone
 * (e.g. an Activity ThreadPanel-only pane: thread reader, no mainline reader)
 * must NOT bootstrap/patch a target with no REST snapshot behind it — a blanket
 * gate would mis-fire (Cindy blocker #1 / its cluster-axis dual, Alice).
 *
 * These reader gates govern where CONTENT is WRITTEN — they are NOT lifted by P2
 * / #1261 (P3's interest-registry adds cold-start seeding so a readerless scope
 * can hold content at all). P2 splits the single cursor into two water-marks: a
 * `received-water` (wire continuity / gap detection, always advances on arrival)
 * ⊥ an `applied-water` (the resume floor). #1261 promotes the applied-water from
 * "content-apply only" to SATISFACTION: the floor advances once EVERY per-frame
 * effect is settled-fulfilled — a synchronous content apply (in-window append /
 * cluster append·patch / reaction·task chip patch / live-gap affordance), an
 * AUTHORITATIVE derived-invalidate that COMMITS (reply count #1263 (c) /
 * followers / threads list — an invalidate INITIATES recovery, so the floor waits
 * for its refetch, initiated ≠ committed), or a warm-inactive window REMOVED so it
 * cold-starts. A rejected refetch pins the floor (the transport re-drives on the
 * next resume). This REFINES the old orphan-gate floor-pin rather than preserving
 * it: a frame with no active reader and NO warm cache is COLD-ABSENT → its effect
 * set is empty → vacuously satisfied (the floor advances), because its content
 * cold-starts authoritatively on next open and advancing past it can't strand a
 * warm cache — the #1251 hole needs a warm DISPLAYABLE cache, which cold-absent
 * lacks. A readerless-but-WARM window is instead removed (never vacuously
 * satisfied — that would serve post-advance stale rows, Cindy B1). So the reader
 * gate governs cache-writes, not the floor. (`task_changed` / `reaction` are the
 * one carve-out — pure idempotent patches with no derived-invalidate, so they
 * keep the synchronous content-apply gate; their satisfaction-model unification is
 * a possible fast-follow.) The `markSatisfied` / `commitSnapshotBaseline` water-
 * mark WRITERS live in Alice's transport seam (`ws-client.ts`, step-4); this
 * ingestor is their sole content-driven CALLER — it fires `markSatisfied` off the
 * per-frame `Promise.allSettled` satisfaction join and drives
 * `commitSnapshotBaseline` off the snapshot-reconcile settle join (see
 * `ingestConversationFrame` below). See §3.1/§5.
 *
 * Read-inert by construction: it never advances the viewer read cursor or
 * writes notification read state — read advancement stays visibility/intent-
 * driven (#task:1244, #task:1251). The applied-water it drives here is the
 * transport RESUME floor, a distinct axis from the viewer read cursor; the
 * `received-water` still auto-advances transport-side (`acceptEventFrame`).
 */

// Scope routing goes through the SHARED parsers only (never a fuzzy
// `startsWith('conversation')`, which would let a `conversation-side:` frame
// leak into the message-stream branch). `parseConversationScope` matches
// `conversation:<id>` (message stream: message / message_reaction_changed /
// task_changed);
// `parseConversationSideScope` matches `conversation-side:<id>` (side channel:
// agent_status / agent_activity / conversation_activity). The two prefixes are
// disjoint by construction (#task:1255 P2 step-3).

/** Build the SATISFACTION disposition for one message-stream `message` frame
 *  (#task:1255 / #task:1263 (c)). Returns the per-effect settle Promises the
 *  caller joins with `Promise.allSettled` to gate `markSatisfied` — all-fulfilled
 *  advances the resume floor once; a rejected refetch pins it (§4.1 / #1261,
 *  commit-gated ≠ dispatch-gated). This is the per-event twin of
 *  {@link ingestMessageStreamSnapshotRequired}: an active reader APPLIES content
 *  (append/gap → resolved) or RECOVERS a derived projection (reply count /
 *  followers / threads list → the invalidate's settle); a warm-but-inactive
 *  CONTENT window is REMOVED, never left to serve post-advance stale rows (Cindy
 *  B1 / #1255 §6); a cold ABSENT target contributes nothing → the frame is
 *  vacuously satisfied (its content cold-starts authoritatively on next open, so
 *  advancing the floor past it can't strand a warm cache — the #1251 hole needs a
 *  warm displayable cache, which cold-absent lacks). Unlike the snapshot handler's
 *  blanket sweep, a live frame touches only its OWN root, so the warm-cluster
 *  removal is SCOPED to that root. */
function ingestMessage(
  qc: QueryClient,
  channelId: string,
  msg: MessageDto,
  projections: MessageProjections | undefined,
): Promise<void>[] {
  const settles: Promise<void>[] = [];
  const push = (eff: Promise<void> | null): void => {
    if (eff) settles.push(eff);
  };

  // S1 (#task:1277): a reply frame carrying an absolute reply_count patch MERGES
  // the authoritative value into the displayed root row + mainline badge (below,
  // via the projection registry) instead of the invalidate→refetch fallback. The
  // patch is EFFECTIVE only when it targets THIS frame's reply root — a root
  // mismatch is a dirty sidecar ("active but no valid patch", Cindy blocker / doc
  // §10 gate #6), so keep the fallback and don't merge the wrong root. SINGLE-POINT
  // validation ({@link validateMessageProjections}) is the anti-corruption boundary:
  // it validates each projection against its own association key ONCE, and BOTH the
  // suppression flag here and the registry dispatch below consume that one result —
  // you cannot suppress rootA's fallback while still merging rootB's dirty patch.
  const validatedProjections = projections
    ? validateMessageProjections(projections, msg)
    : undefined;
  const isPatchedReply = validatedProjections?.thread_root_reply_count != null;
  // #1278: a valid threads_list_entry patch merges/repositions the row in place
  // (registry below) → suppress the blanket threads-list invalidate for this frame.
  const isPatchedThreadsList = validatedProjections?.threads_list_entry != null;

  // MAINLINE — a reply badge is a message-derived count (authoritative-invalidate,
  // cursor-inert; #1277 upgrades it to an absolute merge when a patch rides the
  // frame); a mainline row is an id-deduped content append/gap. A warm-but-
  // inactive mainline (default staleTime:5s) would serve a stale row/count on
  // remount → REMOVE it so the next open cold-starts (coarse, mirroring the
  // snapshot handler: any message frame can touch the window).
  if (hasActiveMainlineReader(qc, channelId)) {
    // A patched reply's badge is merged by the registry below; a non-reply row
    // (append/gap) and the no-patch reply-badge fallback still go through here.
    if (!isPatchedReply) {
      push(applyMainlineMessageToChannelCaches(qc, channelId, msg));
    }
  } else if (hasWarmInactiveMainline(qc, channelId)) {
    push(removeInactiveMainlineCache(qc, channelId));
  }

  // CLUSTERS — each open cluster filters the row to its own root; append is an
  // id-deduped content write. A warm-inactive cluster for THIS msg's root would
  // serve stale on reopen (refetchOnMount:false) → remove it, SCOPED to the root
  // the frame touches (the snapshot handler removes them all; a live frame only
  // affects one).
  for (const rootId of openClusterReaderRoots(qc, channelId)) {
    push(applyClusterMessageToCaches(qc, channelId, rootId, msg));
  }
  for (const rootId of warmInactiveClusterRoots(qc, channelId)) {
    if (msg.thread_root_id === rootId || msg.id === rootId) {
      push(removeInactiveClusterCache(qc, channelId, rootId));
    }
  }

  // THREAD-ROOT reply count — message-derived (authoritative-invalidate, (c)). A
  // warm-inactive thread-root row is NOT removed — mirrors the snapshot handler
  // (useThreadRoot refetches on mount, so a ≤staleTime stale count self-heals).
  // #1277: suppressed when a patch merges the count (registry below).
  if (!isPatchedReply) {
    for (const rootId of openThreadRootReaderRoots(qc, channelId)) {
      push(applyThreadRootReplyBump(qc, channelId, rootId, msg));
    }
  }

  // FOLLOWERS + THREADS-LIST — message-derived invalidations (cursor-inert): the
  // settle is fulfilled once the refetch lands, gating the floor advance.
  // FOLLOWERS stay on the invalidate path (P3 `viewer_following` is per-viewer, not
  // yet emitted). THREADS-LIST: #1278 upgrades it to an in-place merge+resort when a
  // valid `threads_list_entry` patch rides the frame (registry below) — suppress the
  // blanket invalidate then; absent/off-page still fall back (off-page via the
  // reader's own pending-fallback, no-patch via this invalidate).
  for (const rootId of openThreadFollowerReaderRoots(qc, channelId)) {
    push(applyThreadFollowersMessage(qc, channelId, rootId, msg));
  }
  if (hasActiveChannelThreadsReader(qc, channelId)) {
    if (!isPatchedThreadsList) push(invalidateChannelThreadsList(qc, channelId));
  }

  // S1 authoritative projection merge (#task:1277): dispatch the frame's VALIDATED
  // absolute projection patches through the reader registry; each displayed surface
  // returns a 4-state disposition (§7) mapped to its settle promise for the
  // satisfaction join. A merge settles synchronously (resolved); a surface with no
  // reader / no loaded row is cold-absent-vacuous (nothing pushed). Mismatched
  // patches were already dropped by `validateMessageProjections`, so a dirty
  // sidecar's wrong root never reaches a reader (the suppressed paths above are its
  // no-patch fallback for the frame's real root).
  if (validatedProjections) {
    for (const d of ingestMessageProjections(qc, channelId, validatedProjections)) {
      push(dispositionSettle(d));
    }
  }

  return settles;
}

/** Apply a live/replayed `agent_activity` frame to the agent-run-states cache
 *  (#task:1255 P1c). Verbatim move of the old shared `ingestConversationEvent`
 *  side-effect, now gated on a mounted run-states reader (a non-terminal event
 *  would otherwise bootstrap an incomplete one-row list with no snapshot). */
function ingestAgentActivity(
  qc: QueryClient,
  channelId: string,
  state: AgentRunState,
): void {
  if (hasActiveAgentRunStatesReader(qc, channelId)) {
    cursorInertEffect('agent_run_states');
    applyAgentRunStateToCache(channelId, state, qc);
  }
}

/** Apply a live `agent_status` frame to the channel agents cache (#task:1255
 *  P1c), gated on a mounted `useChannelAgents` reader. */
function ingestAgentStatus(
  qc: QueryClient,
  channelId: string,
  patch: ConversationAgentStatusPatch,
): void {
  if (hasActiveChannelAgentsReader(qc, channelId)) {
    cursorInertEffect('channel_agents');
    applyAgentStatusToCache(qc, channelId, patch);
  }
}

/** Apply a live `conversation_activity` row to its agent's activity feed
 *  (#task:1255 P1c #2). The row self-routes by `agent_id`; we gate on that
 *  agent's feed reader being mounted (no bootstrap with no reader) — the
 *  per-agentId equivalent of the cluster-root enumeration. Read-inert: the feed
 *  is content, never a read/transport cursor (Alice P2 red line). */
function ingestConversationActivity(
  qc: QueryClient,
  channelId: string,
  row: ConversationActivityEvent,
): void {
  const agentId = row.agent_id;
  if (!agentId) return;
  if (hasActiveAgentActivityReader(qc, channelId, agentId)) {
    cursorInertEffect('agent_activity_feed');
    appendAgentActivityToCache(qc, channelId, agentId, row);
  }
}

function ingestTaskChanged(
  qc: QueryClient,
  channelId: string,
  task: TaskChangedEvent,
): boolean {
  // The task-by-number DETAIL cache is a SEPARATE projection (task hover/detail
  // by number), not the message-stream content the resume floor tracks. It is
  // fired outside the row-patch seam, membership-gated by its OWN cache (no-op /
  // no bootstrap when absent), and NEVER counted in `applied` — authoritative-on-
  // open, same class as the reaction reactors-list refresh (#task:1270). Firing
  // it unconditionally (not behind the mainline gate) drops an incidental
  // coupling: task detail must update even when the mainline isn't open.
  applyTaskChangedToTaskByNumberCache(qc, task);
  // The message-row chip (task_number/status/title/…) is a message-scoped row
  // patch → the seam fans it to every displayed projection holding the row
  // (mainline / open clusters / open thread-root), closing the coverage the
  // old hand-enumerated handler missed for thread-root task rows.
  return contentEffectApplied(
    'task_message_patch',
    patchMessageInActiveProjections(
      qc,
      {
        channelId,
        messageId: task.message_id,
        threadRootId: task.thread_root_id,
      },
      message => applyTaskChangedToMessage(message, task),
    ),
  );
}

function ingestReaction(
  qc: QueryClient,
  channelId: string,
  ev: MessageReactionChangedEvent,
): boolean {
  const viewerId = getCurrentUserId();
  // Message-scoped absolute-count row patch → the seam fans it to every
  // displayed projection holding the row (mainline / open clusters / open
  // thread-root). This is what fixes #task:1269 item 1 by construction: the
  // Activity thread side panel opens a reply cluster with NO mainline reader, and
  // the old hand-enumerated gate only checked the mainline → live reactions were
  // dropped. #1263 hybrid boundary: reaction keeps the SYNCHRONOUS content-apply
  // (boolean) gate; `applied` is the synchronous content-commit signal.
  const applied = contentEffectApplied(
    'reaction_message_patch',
    patchMessageInActiveProjections(
      qc,
      { channelId, messageId: ev.message_id, threadRootId: ev.thread_root_id },
      message => applyReactionToMessage(message, ev, viewerId),
    ),
  );
  // FIRE-AND-FORGET, cursor-inert, authoritative-on-open: refresh the open
  // "who reacted" popover (`reactors_list_refresh`). Fired once regardless of row
  // writes and NEVER counted in `applied` — it self-heals on next open, so it
  // stays off the resume floor / the `message`-kind allSettled commit-gate (do
  // not promote reaction to the satisfaction path on its account — see
  // REPLAY_SAFETY_CONTRACTS).
  void qc.invalidateQueries({ queryKey: messageReactorsKey(ev.message_id) });
  return applied;
}

/** `snapshot_required` on the message-stream scope (`conversation:<id>`):
 *  reconcile every message-derived cache and RETURN the settle Promises so the
 *  caller can gate `commitSnapshotBaseline` on an all-fulfilled
 *  `Promise.allSettled` (§6, apply-gated commit). Active targets invalidate →
 *  refetch (the Promise settles when the refetch lands); a warm-but-inactive
 *  content window — mainline (default `staleTime:5s`) OR cluster
 *  (`refetchOnMount:false`) — is REMOVED so it cold-starts on next open
 *  (synchronous, resolved Promise); an absent target is vacuously satisfied
 *  (nothing pushed). A warm inactive window is NEVER treated as absent: it would
 *  still display post-commit stale rows (`event-ws-transport-v1.md §8`). Empty ⇒
 *  `allSettled([])` is all-fulfilled ⇒ commit (a scope with no live content is
 *  vacuously recoverable). #1255 P2 step-4. */
function ingestMessageStreamSnapshotRequired(
  qc: QueryClient,
  channelId: string,
): Promise<void>[] {
  const settles: Promise<void>[] = [];
  if (hasActiveMainlineReader(qc, channelId)) {
    settles.push(reconcileChannelMainlineOnSnapshotRequired(qc, channelId));
  } else if (hasWarmInactiveMainline(qc, channelId)) {
    // Warm-but-inactive mainline (default staleTime:5s) would serve stale rows
    // on a remount within the window → remove it so the next open cold-starts
    // (§6), same treatment as a warm inactive cluster. Never left as
    // absent/vacuous (that commits the floor over displayable stale content).
    settles.push(removeInactiveMainlineCache(qc, channelId));
  }
  for (const rootId of openClusterReaderRoots(qc, channelId)) {
    settles.push(reconcileClusterOnSnapshotRequired(qc, channelId, rootId));
  }
  // Warm-but-inactive clusters (refetchOnMount:false) can't self-heal via
  // invalidate → remove them so the next open cold-starts (§6).
  for (const rootId of warmInactiveClusterRoots(qc, channelId)) {
    settles.push(removeInactiveClusterCache(qc, channelId, rootId));
  }
  // Open thread-root rows refetch their authoritative reply count — the covering
  // recovery that releases a backfill reply bump that pinned the floor (§4.1).
  for (const rootId of openThreadRootReaderRoots(qc, channelId)) {
    settles.push(reconcileThreadRootOnSnapshotRequired(qc, channelId, rootId));
  }
  for (const rootId of openThreadFollowerReaderRoots(qc, channelId)) {
    settles.push(invalidateThreadFollowers(qc, channelId, rootId));
  }
  // The channel Threads list is message-derived (a reply bumps a cluster / turns
  // a plain root into a thread) → stays on the message stream.
  if (hasActiveChannelThreadsReader(qc, channelId)) {
    settles.push(invalidateChannelThreadsList(qc, channelId));
  }
  return settles;
}

/** `snapshot_required` on the side-channel scope (`conversation-side:<id>`):
 *  reconcile the side caches (agent-run-states / channel agents / agent-activity
 *  feeds). The side scope has NO content-apply seam — its floor auto-advances
 *  transport-side — so this fires reconciles but never returns a commit signal
 *  or touches a cursor. #1255 P2 step-4 (agent-activity item-2 gap now closed). */
function ingestSideSnapshotRequired(qc: QueryClient, channelId: string): void {
  if (hasActiveAgentRunStatesReader(qc, channelId)) {
    void invalidateAgentRunStates(qc, channelId);
  }
  if (hasActiveChannelAgentsReader(qc, channelId)) {
    void reconcileChannelAgentsOnSnapshotRequired(qc, channelId);
  }
  // Agent-activity feeds are per-agentId; invalidate the whole conversation
  // prefix so every mounted feed refetches (item-2 gap, §4.1 / P1c #2).
  void reconcileAgentActivityOnSnapshotRequired(qc, channelId);
}

/**
 * Route one realtime frame into the channel main-stream + thread caches. Pure
 * (takes the `QueryClient` explicitly) so it is unit-testable without rendering.
 *
 * Scope-partitioned (#1255 P2 step-3): message-stream kinds ride
 * `conversation:<id>`, side-channel kinds ride `conversation-side:<id>`. Routing
 * uses the shared parsers only — the two prefixes are disjoint, so a side frame
 * never reaches a message-stream apply and vice-versa.
 *
 * DUAL-WATER FLOOR (#1255 P2 step-4 / #1263 (c)). For the content-gated
 * message-stream scope this is the SOLE content-driven writer of the transport
 * applied-water (resume floor):
 *  - a `message` `event` → build the per-frame SATISFACTION disposition
 *    ({@link ingestMessage}) and, once its `Promise.allSettled` join is
 *    all-fulfilled, `markSatisfied(scope, seq, epoch)` once (#1261: content applies
 *    + committed derived-invalidates + warm-removes + cold-absent vacuous all
 *    satisfy; a rejected refetch pins the floor);
 *  - a `task_changed` / `reaction` `event` → a pure idempotent content patch, so
 *    the synchronous `applied` gate stands: a real patch → `markSatisfied` once, a
 *    no-op → none (false-positive forbidden, §4.1);
 *  - `snapshot_required` → collect the reconcile settle Promises and, once the
 *    `Promise.allSettled` join is all-fulfilled, `commitSnapshotBaseline(scope,
 *    epoch)` once (apply-gated commit, §6). A rejected settle leaves the floor
 *    pinned (the transport re-drives on the next resume / snapshot).
 * The side scope has no content-apply seam — its floor auto-advances in the
 * transport (`acceptEventFrame`), so the ingestor never calls `markSatisfied` /
 * `commitSnapshotBaseline` for it (Alice's contract).
 */
export function ingestConversationFrame(
  qc: QueryClient,
  frame: ServerFrame,
): void {
  if (frame.type !== 'event' && frame.type !== 'snapshot_required') return;
  const messageStreamId = parseConversationScope(frame.scope);
  const sideId = parseConversationSideScope(frame.scope);
  if (!messageStreamId && !sideId) return;

  if (frame.type === 'snapshot_required') {
    if (messageStreamId) {
      const settles = ingestMessageStreamSnapshotRequired(qc, messageStreamId);
      const { scope, epoch } = frame;
      // Apply-gated commit: advance the floor to the server-stamped baseline
      // ONLY once every reconcile settled fulfilled. A rejected/aborted refetch
      // leaves the floor pinned — the transport re-drives on the next resume.
      void Promise.allSettled(settles).then(results => {
        if (results.every(r => r.status === 'fulfilled')) {
          eventWsClient.commitSnapshotBaseline(scope, epoch);
        }
      });
    }
    if (sideId) ingestSideSnapshotRequired(qc, sideId);
    return;
  }

  // Message-stream kinds ride `conversation:<id>`. The applied-water advances on
  // SATISFACTION (#1261), split by effect nature:
  //  - `message` carries cursor-inert derived-invalidate effects (reply counts,
  //    followers, threads list, #1263 (c)) alongside content appends, so it gates
  //    `markSatisfied` on a per-frame `Promise.allSettled` — all-fulfilled advances
  //    the floor once (after any refetch COMMITS); a rejected refetch pins it; a
  //    cold-absent frame satisfies vacuously (allSettled([]) is all-fulfilled).
  //  - `task_changed` / `reaction` are pure idempotent content patches (set-by-id,
  //    replay-safe) with no derived-invalidate effect, so they keep the synchronous
  //    `applied` gate: a real patch advances the floor, a no-op pins it (harmless
  //    on idempotent replay). Their #1261 satisfaction-model unification is a
  //    possible fast-follow, out of #1263's reply-count scope.
  if (messageStreamId) {
    const kind = asMessageStreamKind(frame.kind);
    if (kind === 'message') {
      const payload = frame.payload as MessageEventPayload | undefined;
      const msg = payload?.message;
      if (msg) {
        const settles = ingestMessage(
          qc,
          messageStreamId,
          msg,
          payload?.projections,
        );
        const { scope, seq, epoch } = frame;
        void Promise.allSettled(settles).then(results => {
          if (results.every(r => r.status === 'fulfilled')) {
            eventWsClient.markSatisfied(scope, seq, epoch);
          }
        });
      }
      return;
    }
    let applied = false;
    if (kind === 'task_changed') {
      const task = frame.payload as TaskChangedEvent | undefined;
      if (task?.message_id) applied = ingestTaskChanged(qc, messageStreamId, task);
    } else if (kind === MESSAGE_REACTION_CHANGED_EVENT) {
      const ev = frame.payload as MessageReactionChangedEvent | undefined;
      if (ev?.message_id) applied = ingestReaction(qc, messageStreamId, ev);
    }
    if (applied) eventWsClient.markSatisfied(frame.scope, frame.seq, frame.epoch);
    return;
  }

  // Side-channel kinds ride `conversation-side:<id>`. No content-apply seam —
  // the transport auto-advances the side floor; never call markSatisfied here.
  if (!sideId) return;
  const sideKind = asSideKind(frame.kind);
  if (sideKind === 'agent_activity') {
    const state = frame.payload as AgentRunState | undefined;
    if (state?.runId) ingestAgentActivity(qc, sideId, state);
  } else if (sideKind === 'agent_status') {
    const patch = frame.payload as ConversationAgentStatusPatch | undefined;
    if (patch?.agent_id) ingestAgentStatus(qc, sideId, patch);
  } else if (sideKind === 'conversation_activity') {
    const row = frame.payload as ConversationActivityEvent | undefined;
    if (row?.id != null) ingestConversationActivity(qc, sideId, row);
  }
}

export function useConversationIngestor(): void {
  const qc = useQueryClient();
  useEffect(() => {
    return onWsFrame((frame: ServerFrame) =>
      ingestConversationFrame(qc, frame),
    );
  }, [qc]);
}
