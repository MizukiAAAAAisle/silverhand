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
  EventDeliveryProvenance,
  MessageDto,
  MessageReactionChangedEvent,
  ServerFrame,
  TaskChangedEvent,
} from '@silverhand/shared';
import { onWsFrame, eventWsClient } from '@/lib/ws-client';
import type { EventDeliveryMeta } from '@/lib/ws-client';
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
  applyClusterTaskChangedToCaches,
  applyMainlineMessageToChannelCaches,
  applyReactionChangedToChannelCaches,
  applyReactionChangedToThreadRootCache,
  applyTaskChangedToChannelCaches,
  applyThreadFollowersMessage,
  applyThreadRootReplyBump,
  hasActiveChannelAgentsReader,
  hasActiveMainlineReader,
  hasWarmInactiveMainline,
  invalidateThreadFollowers,
  openClusterReaderRoots,
  openThreadFollowerReaderRoots,
  openThreadRootReaderRoots,
  reconcileChannelAgentsOnSnapshotRequired,
  reconcileChannelMainlineOnSnapshotRequired,
  reconcileClusterOnSnapshotRequired,
  reconcileThreadRootOnSnapshotRequired,
  removeInactiveClusterCache,
  removeInactiveMainlineCache,
  warmInactiveClusterRoots,
} from '@/features/channels/hooks';
import type { ConversationAgentStatusPatch } from '@/features/channels/hooks';

type ReplayCursorEffect = 'content-apply' | 'cursor-inert';
type ReplayRecoveryEffect =
  | 'idempotent'
  | 'provenance-gated-authoritative-backfill'
  | 'authoritative-invalidate'
  | 'side-scope-self-healing';

type ReplaySafetySpec = {
  readonly cursor: ReplayCursorEffect;
  readonly recovery: ReplayRecoveryEffect;
  readonly summary: string;
};

/** Replay-safety contract for every cache effect this ingestor can produce
 *  (#task:1262). A new event kind or cache write must first be categorized here:
 *  - `content-apply` may advance the message-stream applied-water when the
 *    helper reports a real apply;
 *  - `cursor-inert` must never advance the message-stream applied-water.
 *
 *  This table is the typed version of the #1255 review matrix. It is deliberately
 *  about cache EFFECTS, not just wire kinds: one `message` frame can append an
 *  idempotent cluster row, bump a non-idempotent reply count, and invalidate a
 *  derived list. */
export const REPLAY_SAFETY_CONTRACTS = {
  mainline_message_window: {
    cursor: 'content-apply',
    recovery: 'provenance-gated-authoritative-backfill',
    summary:
      'mainline append/gap is idempotent; reply-count delta is live-only and backfill forces authority',
  },
  cluster_message_window: {
    cursor: 'content-apply',
    recovery: 'idempotent',
    summary: 'cluster message append is deduped by message id',
  },
  thread_root_reply_count: {
    cursor: 'content-apply',
    recovery: 'provenance-gated-authoritative-backfill',
    summary: 'thread-root reply-count delta is live-only and backfill forces authority',
  },
  thread_followers_invalidate: {
    cursor: 'cursor-inert',
    recovery: 'authoritative-invalidate',
    summary: 'followers projection refetches from its own source',
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
    summary: 'reaction patch sets absolute reaction state by message id',
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
    'mainline_message_window',
    'cluster_message_window',
    'thread_root_reply_count',
    'thread_followers_invalidate',
    'channel_threads_invalidate',
  ],
  task_changed: ['task_message_patch'],
  [MESSAGE_REACTION_CHANGED_EVENT]: ['reaction_message_patch'],
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
 * live in each view's `useConversationStream(onEvent)` handler, so views can be
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
 * These reader gates are NOT lifted by P2. P2 splits the single cursor into two
 * water-marks: a `received-water` (wire continuity / gap detection, always
 * advances on arrival) ⊥ an `applied-water` (the resume floor). Only the
 * applied-water gates recovery, and it advances ONLY on a real CONTENT apply —
 * an in-window append / cluster append·patch / thread-root reply bump /
 * reaction·task chip patch / mainline live-gap bump. It does NOT advance on a
 * derived-invalidate (cursor-INERT: an invalidate merely INITIATES recovery, it
 * is not an apply), nor on a no-op, and a non-idempotent backfill delta (e.g. a
 * reply-count bump) does not advance until its authoritative recovery COMMITS
 * (initiated ≠ committed). A frame with no active reader lands no content apply,
 * so it must not advance the applied-water (floor frozen → resume/cold-start on
 * resubscribe) — bit-for-bit today's orphan gate. Truly "apply without a reader"
 * needs per-scope cold-start snapshot seeding decoupled from view mount, which is
 * P3 (interest-registry). The `markApplied` / `commitSnapshotBaseline` water-mark
 * WRITERS live in Alice's transport seam (`ws-client.ts`, step-4); as of step-4
 * this ingestor is their sole content-driven CALLER — it fires `markApplied` on a
 * real content apply and drives `commitSnapshotBaseline` off the snapshot-reconcile
 * settle join (see `ingestConversationFrame` below). See §3.1/§5.
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

function ingestMessage(
  qc: QueryClient,
  channelId: string,
  msg: MessageDto,
  provenance: EventDeliveryProvenance,
): boolean {
  let applied = false;
  // Mainline (badge bump for replies / append-or-gap for main-line rows). The
  // reply-count bump is non-idempotent → provenance gates live-`+1` vs backfill
  // authoritative recovery inside the helper.
  if (hasActiveMainlineReader(qc, channelId)) {
    if (
      contentEffectApplied(
        'mainline_message_window',
        applyMainlineMessageToChannelCaches(qc, channelId, msg, provenance),
      )
    ) {
      applied = true;
    }
  }
  // Each open cluster filters the row to its own root (append = idempotent).
  for (const rootId of openClusterReaderRoots(qc, channelId)) {
    if (
      contentEffectApplied(
        'cluster_message_window',
        applyClusterMessageToCaches(qc, channelId, rootId, msg),
      )
    ) {
      applied = true;
    }
  }
  // Each open thread-root row bumps its authoritative reply count (non-idempotent
  // → provenance-gated).
  for (const rootId of openThreadRootReaderRoots(qc, channelId)) {
    if (
      contentEffectApplied(
        'thread_root_reply_count',
        applyThreadRootReplyBump(qc, channelId, rootId, msg, provenance),
      )
    ) {
      applied = true;
    }
  }
  // Each open follower snapshot refetches when a reply lands on its root
  // (derived-invalidate → cursor-inert, never advances the floor).
  for (const rootId of openThreadFollowerReaderRoots(qc, channelId)) {
    cursorInertEffect('thread_followers_invalidate');
    applyThreadFollowersMessage(qc, channelId, rootId, msg);
  }
  // The channel Threads list re-sorts/refetches on any message — a
  // derived-invalidate (cursor-inert).
  if (hasActiveChannelThreadsReader(qc, channelId)) {
    cursorInertEffect('channel_threads_invalidate');
    void invalidateChannelThreadsList(qc, channelId);
  }
  return applied;
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
  let applied = false;
  if (hasActiveMainlineReader(qc, channelId)) {
    if (
      contentEffectApplied(
        'task_message_patch',
        applyTaskChangedToChannelCaches(qc, channelId, task),
      )
    ) {
      applied = true;
    }
  }
  for (const rootId of openClusterReaderRoots(qc, channelId)) {
    if (
      contentEffectApplied(
        'task_message_patch',
        applyClusterTaskChangedToCaches(qc, channelId, rootId, task),
      )
    ) {
      applied = true;
    }
  }
  return applied;
}

function ingestReaction(
  qc: QueryClient,
  channelId: string,
  ev: MessageReactionChangedEvent,
): boolean {
  const viewerId = getCurrentUserId();
  let applied = false;
  // Mainline path also patches the reply-cluster window + reactor list — the
  // sole writer of cluster reactions in the old code (useThreadCluster has no
  // reaction branch), so gating it on the mainline reader is faithful.
  if (hasActiveMainlineReader(qc, channelId)) {
    if (
      contentEffectApplied(
        'reaction_message_patch',
        applyReactionChangedToChannelCaches(qc, channelId, ev, viewerId),
      )
    ) {
      applied = true;
    }
  }
  // The thread pane's root row is a separate query; patch it for the open root
  // the reaction targets (no-op unless `ev.message_id === root`).
  for (const rootId of openThreadRootReaderRoots(qc, channelId)) {
    if (
      contentEffectApplied(
        'reaction_message_patch',
        applyReactionChangedToThreadRootCache(qc, channelId, rootId, ev, viewerId),
      )
    ) {
      applied = true;
    }
  }
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
 * DUAL-WATER FLOOR (#1255 P2 step-4). For the content-gated message-stream scope
 * this is the SOLE content-driven writer of the transport applied-water (resume
 * floor):
 *  - an `event` that produced ≥1 real content write (an ingest* helper returned
 *    `true`) → `markApplied(scope, seq, epoch)` exactly once; a no-op /
 *    readerless / derived-invalidate-only frame does NOT (false-positive
 *    forbidden, §4.1);
 *  - `snapshot_required` → collect the reconcile settle Promises and, once the
 *    `Promise.allSettled` join is all-fulfilled, `commitSnapshotBaseline(scope,
 *    epoch)` once (apply-gated commit, §6). A rejected settle leaves the floor
 *    pinned (the transport re-drives on the next resume / snapshot).
 * The side scope has no content-apply seam — its floor auto-advances in the
 * transport (`acceptEventFrame`), so the ingestor never calls `markApplied` /
 * `commitSnapshotBaseline` for it (Alice's contract).
 *
 * `meta.provenance` is delivery metadata, not payload: a non-idempotent delta
 * (reply-count bump) applies optimistically on `live` and forces authoritative
 * recovery on `backfill` — threaded into the message helpers, never mutating the
 * wire frame.
 */
export function ingestConversationFrame(
  qc: QueryClient,
  frame: ServerFrame,
  meta?: EventDeliveryMeta,
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

  // Message-stream kinds ride `conversation:<id>`. The applied-water advances
  // only when a real content write landed (§4.1); markApplied is idempotent and
  // strict-contiguous transport-side, but we still gate the CALL on `applied` so
  // a no-op frame never even signals.
  if (messageStreamId) {
    const provenance = meta?.provenance ?? 'live';
    let applied = false;
    const kind = asMessageStreamKind(frame.kind);
    if (kind === 'message') {
      const msg = (frame.payload as { message?: MessageDto } | undefined)?.message;
      if (msg) applied = ingestMessage(qc, messageStreamId, msg, provenance);
    } else if (kind === 'task_changed') {
      const task = frame.payload as TaskChangedEvent | undefined;
      if (task?.message_id) applied = ingestTaskChanged(qc, messageStreamId, task);
    } else if (kind === MESSAGE_REACTION_CHANGED_EVENT) {
      const ev = frame.payload as MessageReactionChangedEvent | undefined;
      if (ev?.message_id) applied = ingestReaction(qc, messageStreamId, ev);
    }
    if (applied) eventWsClient.markApplied(frame.scope, frame.seq, frame.epoch);
    return;
  }

  // Side-channel kinds ride `conversation-side:<id>`. No content-apply seam —
  // the transport auto-advances the side floor; never call markApplied here.
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
    return onWsFrame((frame: ServerFrame, meta?: EventDeliveryMeta) =>
      ingestConversationFrame(qc, frame, meta),
    );
  }, [qc]);
}
