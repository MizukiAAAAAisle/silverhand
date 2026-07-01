import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  MESSAGE_REACTION_CHANGED_EVENT,
  conversationSideScope,
  conversationScope,
} from '@silverhand/shared';
import type { AgentRunState, MessageDto, ServerFrame } from '@silverhand/shared';
import {
  MESSAGE_STREAM_KIND_CONTRACTS,
  REPLAY_SAFETY_CONTRACTS,
  SIDE_KIND_CONTRACTS,
  ingestConversationFrame,
} from './conversation-ingestor';
import { clusterMessagesKey, messagesKey, threadRootKey } from '@/features/channels/hooks';
import { messageReactorsKey } from '@/features/channels/reaction-hooks';
import { channelThreadsKey } from '@/features/channels/useChannelThreads';
import { agentRunStatesKey } from '@/lib/agentRunStateCache';
import { eventWsClient } from '@/lib/ws-client';
import {
  clearPendingAgentStatusPatches,
  mergePendingAgentStatusPatches,
} from '@/features/channels/hooks';

describe('replay-safety contract matrix (#task:1262, reclassified #task:1263 (c))', () => {
  it('classifies the message-stream wire kinds and their cache effects explicitly', () => {
    expect(Object.keys(MESSAGE_STREAM_KIND_CONTRACTS).sort()).toEqual([
      MESSAGE_REACTION_CHANGED_EVENT,
      'message',
      'task_changed',
    ].sort());
    expect(MESSAGE_STREAM_KIND_CONTRACTS.message).toEqual([
      'mainline_row_window',
      'mainline_reply_count',
      'cluster_message_window',
      'thread_root_reply_count',
      'thread_followers_invalidate',
      'channel_threads_invalidate',
    ]);
    expect(MESSAGE_STREAM_KIND_CONTRACTS.task_changed).toEqual(['task_message_patch']);
    expect(MESSAGE_STREAM_KIND_CONTRACTS[MESSAGE_REACTION_CHANGED_EVENT]).toEqual([
      'reaction_message_patch',
      'reactors_list_refresh',
    ]);
  });

  it('(A): the reactors popover refresh is a cursor-inert, non-floor-bearing detail invalidate', () => {
    // #1263 hybrid boundary, pinned: a reaction frame keeps the SYNCHRONOUS
    // content-apply floor gate on `reaction_message_patch`. Its `reactors_list_refresh`
    // sub-effect is a lazy hover-detail invalidate — cursor-inert, authoritative-on-
    // open, ZERO delta accumulation — so it is deliberately NOT commit-gated via the
    // message allSettled path. This assertion stops a future "unify satisfaction
    // path" refactor from silently making a tooltip refetch a floor dependency.
    expect(REPLAY_SAFETY_CONTRACTS.reaction_message_patch).toMatchObject({
      cursor: 'content-apply',
      recovery: 'idempotent',
    });
    expect(REPLAY_SAFETY_CONTRACTS.reactors_list_refresh).toMatchObject({
      cursor: 'cursor-inert',
      recovery: 'authoritative-invalidate',
    });
    expect(REPLAY_SAFETY_CONTRACTS.reactors_list_refresh.summary).toMatch(
      /not resume-floor-bearing/i,
    );
  });

  it('classifies the side-channel wire kinds as cursor-inert self-healing effects', () => {
    expect(Object.keys(SIDE_KIND_CONTRACTS).sort()).toEqual([
      'agent_activity',
      'agent_status',
      'conversation_activity',
    ].sort());
    for (const effectId of Object.values(SIDE_KIND_CONTRACTS).flat()) {
      const spec = REPLAY_SAFETY_CONTRACTS[effectId];
      expect(spec.cursor).toBe('cursor-inert');
      expect(spec.recovery).toBe('side-scope-self-healing');
    }
  });

  it('(c): reply-count effects are now cursor-inert authoritative-invalidate (no optimistic +1)', () => {
    // The whole #1263 (c) reframe: a reply count is a message-DERIVED projection,
    // recovered authoritatively — not a non-idempotent content delta.
    expect(REPLAY_SAFETY_CONTRACTS.mainline_reply_count).toMatchObject({
      cursor: 'cursor-inert',
      recovery: 'authoritative-invalidate',
    });
    expect(REPLAY_SAFETY_CONTRACTS.thread_root_reply_count).toMatchObject({
      cursor: 'cursor-inert',
      recovery: 'authoritative-invalidate',
    });
  });

  it('keeps message CONTENT appends as idempotent content-apply', () => {
    expect(REPLAY_SAFETY_CONTRACTS.mainline_row_window).toMatchObject({
      cursor: 'content-apply',
      recovery: 'idempotent',
    });
    expect(REPLAY_SAFETY_CONTRACTS.cluster_message_window).toMatchObject({
      cursor: 'content-apply',
      recovery: 'idempotent',
    });
  });

  it('marks derived invalidations as cursor-inert, not content-apply', () => {
    expect(REPLAY_SAFETY_CONTRACTS.thread_followers_invalidate.cursor).toBe(
      'cursor-inert',
    );
    expect(REPLAY_SAFETY_CONTRACTS.channel_threads_invalidate.cursor).toBe(
      'cursor-inert',
    );
  });
});

// #task:1255 P1a blocker-1 — the App-level ingestor must NOT write the mainline
// window unless a mainline reader (`useChannelMessages`) is mounted. A scope
// kept subscribed by thread/follower INTEREST alone (e.g. an Activity
// thread-source pane that mounts only `ThreadPanel`, no `ChannelView`) would
// otherwise bootstrap an incomplete, live-frame-stitched `messagesKey` window
// with no REST snapshot behind it — the pre-S gap P2 (cold-start two-water-mark)
// closes. P1 = prep, so the old "writes only while useChannelMessages mounted"
// gating is preserved via `hasActiveMainlineReader` (observer count on the exact
// mainline key). See docs/renderer-event-ingestion-v1.md §3.1/§5.

function mountMainlineReader(qc: QueryClient, channelId: string): () => void {
  // A standing observer on the exact mainline key — what `useChannelMessages`
  // registers. `enabled: false` keeps it from fetching; observer count still
  // ticks to 1, which is all the gate reads.
  const observer = new QueryObserver(qc, {
    queryKey: messagesKey(channelId),
    queryFn: () => new Promise<never>(() => {}),
    enabled: false,
  });
  return observer.subscribe(() => {});
}

function mountReader(
  qc: QueryClient,
  queryKey: readonly unknown[],
): () => void {
  const observer = new QueryObserver(qc, {
    queryKey,
    queryFn: () => new Promise<never>(() => {}),
    enabled: false,
  });
  return observer.subscribe(() => {});
}

function messageFrame(channelId: string, msg: MessageDto): ServerFrame {
  return {
    type: 'event',
    scope: `conversation:${channelId}`,
    seq: msg.seq,
    epoch: 'epoch-1',
    kind: 'message',
    payload: { message: msg },
  } as ServerFrame;
}

function hasMainlineCache(qc: QueryClient, channelId: string): boolean {
  return qc.getQueryData(messagesKey(channelId)) !== undefined;
}

describe('ingestConversationFrame — mainline-reader gate (#task:1255 P1a)', () => {
  it('does NOT bootstrap the mainline window with no reader (interest-only)', () => {
    const qc = new QueryClient();
    // Scope is subscribed (thread/follower interest) but no useChannelMessages
    // observes `messagesKey(c1)`.
    ingestConversationFrame(qc, messageFrame('c1', message({ id: 'm1', seq: 1 })));

    expect(hasMainlineCache(qc, 'c1')).toBe(false);
  });

  it('applies to the mainline window when a reader is mounted', () => {
    const qc = new QueryClient();
    const unsub = mountMainlineReader(qc, 'c1');

    ingestConversationFrame(qc, messageFrame('c1', message({ id: 'm1', seq: 1 })));

    expect(hasMainlineCache(qc, 'c1')).toBe(true);
    unsub();
  });

  it('gates per channel — a reader on c1 does not open c2', () => {
    const qc = new QueryClient();
    const unsub = mountMainlineReader(qc, 'c1');

    // Frame for c2 while only c1 has a reader → c2 stays closed.
    ingestConversationFrame(qc, messageFrame('c2', message({ id: 'n1', seq: 1 })));

    expect(hasMainlineCache(qc, 'c2')).toBe(false);
    unsub();
  });

  it('ignores non-conversation scopes and non-routable frames', () => {
    const qc = new QueryClient();
    const unsub = mountMainlineReader(qc, 'c1');

    ingestConversationFrame(qc, {
      type: 'event',
      scope: 'viewer:u1',
      seq: 1,
      epoch: 'e',
      kind: 'message',
      payload: { message: message({ id: 'x', seq: 1 }) },
    } as ServerFrame);
    ingestConversationFrame(qc, { type: 'ping' } as ServerFrame);

    expect(qc.getQueryData(messagesKey('c1'))).toBeUndefined();
    unsub();
  });
});

// #task:1255 P1b — per-target gating across the thread axis. The blanket
// mainline early-return is gone; cluster / root / follower writes enumerate the
// OPEN reader roots. The load-bearing dual of P1a blocker #1 (Alice): an
// Activity ThreadPanel-only pane has a CLUSTER reader but NO mainline reader —
// the cluster frame must apply while the mainline window stays untouched.
describe('ingestConversationFrame — thread-axis per-target gate (#1255 P1b)', () => {
  it('ThreadPanel-only: cluster applies, mainline messagesKey untouched', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, clusterMessagesKey('c1', 'root1'));
    // No mainline reader on c1.

    ingestConversationFrame(
      qc,
      messageFrame('c1', message({ id: 'r1', seq: 2, thread_root_id: 'root1' })),
    );

    // Cluster window got the reply...
    expect(
      qc.getQueryData(clusterMessagesKey('c1', 'root1')),
    ).not.toBeUndefined();
    // ...and the mainline window was never bootstrapped.
    expect(qc.getQueryData(messagesKey('c1'))).toBeUndefined();
    unsub();
  });

  it('per-root: a reply to root2 leaves an open root1 cluster untouched', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, clusterMessagesKey('c1', 'root1'));

    // Reply belongs to root2; root1's cluster reader is the only one open.
    ingestConversationFrame(
      qc,
      messageFrame('c1', message({ id: 'r2', seq: 3, thread_root_id: 'root2' })),
    );

    // root1 cluster: the frame was filtered out (wrong root) → still empty.
    expect(qc.getQueryData(clusterMessagesKey('c1', 'root1'))).toBeUndefined();
    // root2 had no reader → not bootstrapped either.
    expect(qc.getQueryData(clusterMessagesKey('c1', 'root2'))).toBeUndefined();
    unsub();
  });

  it('no cluster reader → a reply bootstraps no cluster window', () => {
    const qc = new QueryClient();
    // Mainline reader present, but no cluster reader for root1.
    const unsub = mountMainlineReader(qc, 'c1');

    ingestConversationFrame(
      qc,
      messageFrame('c1', message({ id: 'r1', seq: 2, thread_root_id: 'root1' })),
    );

    expect(qc.getQueryData(clusterMessagesKey('c1', 'root1'))).toBeUndefined();
    unsub();
  });
});

// #task:1255 P1c — the last pure-invalidate / pure-cache-write consumers move in:
// useChannelThreads (threads-list invalidate on any message + snapshot_required)
// and useAgentRunStates (agent_activity cache write + snapshot_required
// invalidate). Same per-reader gate as the message/cluster axes.
describe('ingestConversationFrame — channel-threads gate (#1255 P1c)', () => {
  it('invalidates the threads list on a message when a reader is mounted', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, channelThreadsKey('c1'));
    const spy = vi.spyOn(qc, 'invalidateQueries');

    ingestConversationFrame(qc, messageFrame('c1', message({ id: 'm1', seq: 1 })));

    expect(spy).toHaveBeenCalledWith({ queryKey: channelThreadsKey('c1') });
    unsub();
  });

  it('does NOT invalidate the threads list with no reader', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    ingestConversationFrame(qc, messageFrame('c1', message({ id: 'm1', seq: 1 })));

    expect(spy).not.toHaveBeenCalledWith({ queryKey: channelThreadsKey('c1') });
  });
});

describe('ingestConversationFrame — agent-run-states gate (#1255 P1c)', () => {
  it('applies agent_activity to the cache when a reader is mounted', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, agentRunStatesKey('c1'));

    ingestConversationFrame(qc, agentActivityFrame('c1', runState('c1', 'a1')));

    const states = qc.getQueryData<AgentRunState[]>(agentRunStatesKey('c1'));
    expect(states?.map(s => s.agentId)).toEqual(['a1']);
    unsub();
  });

  it('does NOT bootstrap the run-states cache with no reader', () => {
    const qc = new QueryClient();

    ingestConversationFrame(qc, agentActivityFrame('c1', runState('c1', 'a1')));

    expect(qc.getQueryData(agentRunStatesKey('c1'))).toBeUndefined();
  });
});

const agentsKey = (cid: string) => ['channels', cid, 'agents'] as const;

describe('ingestConversationFrame — agents (agent_status) gate (#1255 P1c)', () => {
  afterEach(() => clearPendingAgentStatusPatches('c1'));

  it('patches + buffers agent_status when a reader is mounted', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, agentsKey('c1'));

    ingestConversationFrame(qc, agentStatusFrame('c1', 'a1', 'active'));

    // Buffered for the in-flight snapshot replay.
    const merged = mergePendingAgentStatusPatches('c1', [
      { conversation_id: 'c1', agent_id: 'a1', cli_session_id: null, pid: null, status: 'idle', joined_at: 0 },
    ]);
    expect(merged[0]?.status).toBe('active');
    unsub();
  });

  it('does NOT buffer agent_status with no reader', () => {
    const qc = new QueryClient();

    ingestConversationFrame(qc, agentStatusFrame('c1', 'a1', 'active'));

    const merged = mergePendingAgentStatusPatches('c1', [
      { conversation_id: 'c1', agent_id: 'a1', cli_session_id: null, pid: null, status: 'idle', joined_at: 0 },
    ]);
    expect(merged[0]?.status).toBe('idle'); // untouched
  });
});

function agentStatusFrame(
  channelId: string,
  agentId: string,
  status: 'idle' | 'starting' | 'active' | 'crashed',
): ServerFrame {
  return {
    type: 'event',
    scope: conversationSideScope(channelId),
    seq: 1,
    epoch: 'epoch-1',
    kind: 'agent_status',
    payload: { agent_id: agentId, status },
  } as ServerFrame;
}

const agentActivityKey = (cid: string, aid: string) =>
  ['conversations', cid, 'agent-activity', aid] as const;

describe('ingestConversationFrame — agent activity feed gate (#1255 P1c #2)', () => {
  it('appends conversation_activity to the agent feed when its reader is mounted', () => {
    const qc = new QueryClient();
    // Reader loaded the feed (has data) AND observes the key.
    qc.setQueryData(agentActivityKey('c1', 'a1'), { events: [], nextBeforeId: null });
    const unsub = mountReader(qc, agentActivityKey('c1', 'a1'));

    ingestConversationFrame(qc, conversationActivityFrame('c1', 'a1', 7));

    const data = qc.getQueryData<{ events: { id: number }[] }>(
      agentActivityKey('c1', 'a1'),
    );
    expect(data?.events.map(e => e.id)).toEqual([7]);
    unsub();
  });

  it('does NOT bootstrap the feed with no reader', () => {
    const qc = new QueryClient();

    ingestConversationFrame(qc, conversationActivityFrame('c1', 'a1', 7));

    expect(qc.getQueryData(agentActivityKey('c1', 'a1'))).toBeUndefined();
  });

  it('routes by agent_id — a row for a2 leaves a1 feed untouched', () => {
    const qc = new QueryClient();
    qc.setQueryData(agentActivityKey('c1', 'a1'), { events: [], nextBeforeId: null });
    const unsub = mountReader(qc, agentActivityKey('c1', 'a1'));

    ingestConversationFrame(qc, conversationActivityFrame('c1', 'a2', 7));

    const data = qc.getQueryData<{ events: { id: number }[] }>(
      agentActivityKey('c1', 'a1'),
    );
    expect(data?.events).toEqual([]); // a1 untouched
    expect(qc.getQueryData(agentActivityKey('c1', 'a2'))).toBeUndefined();
    unsub();
  });
});

function conversationActivityFrame(
  channelId: string,
  agentId: string,
  id: number,
): ServerFrame {
  return {
    type: 'event',
    scope: conversationSideScope(channelId),
    seq: id,
    epoch: 'epoch-1',
    kind: 'conversation_activity',
    payload: {
      id,
      conversation_id: channelId,
      agent_id: agentId,
      kind: 'text',
      payload: { text: `m${id}` },
      created_at: id,
    },
  } as ServerFrame;
}

function runState(conversationId: string, agentId: string): AgentRunState {
  return {
    conversationId,
    agentId,
    runId: `${agentId}-run1`,
    status: 'thinking',
    startedAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  };
}

function agentActivityFrame(
  channelId: string,
  state: AgentRunState,
): ServerFrame {
  return {
    type: 'event',
    scope: conversationSideScope(channelId),
    seq: state.updatedAt,
    epoch: 'epoch-1',
    kind: 'agent_activity',
    payload: state,
  } as ServerFrame;
}

function message(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'm1',
    conversation_id: 'c1',
    from_kind: 'user',
    from_agent_id: null,
    from_user_id: 'u1',
    content: 'body',
    metadata: null,
    attachments: null,
    seq: 1,
    created_at: 0,
    thread_root_id: null,
    task_number: null,
    task_status: null,
    task_title: null,
    task_workspace_id: null,
    task_closed_at: null,
    task_assignee: null,
    reactions: null,
    ...overrides,
  };
}

// #task:1255 P2 step-3 — cross-scope routing is DISJOINT: a kind must arrive on
// its own scope. A side kind on the message scope (or a message kind on the side
// scope) is ignored, never mis-applied — the shared parsers keep the two
// recovery classes from leaking. And `snapshot_required` reconciles only the
// caches of the scope it arrived on.
describe('ingestConversationFrame — cross-scope routing is disjoint (#1255 P2 step-3)', () => {
  afterEach(() => clearPendingAgentStatusPatches('c1'));

  it('an agent_status on the MESSAGE scope is ignored (not buffered)', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, agentsKey('c1'));
    // agent_status is a SIDE kind — deliver it on the wrong (message) scope.
    ingestConversationFrame(qc, {
      type: 'event',
      scope: 'conversation:c1',
      seq: 1,
      epoch: 'epoch-1',
      kind: 'agent_status',
      payload: { agent_id: 'a1', status: 'active' },
    } as ServerFrame);

    const merged = mergePendingAgentStatusPatches('c1', [
      { conversation_id: 'c1', agent_id: 'a1', cli_session_id: null, pid: null, status: 'idle', joined_at: 0 },
    ]);
    expect(merged[0]?.status).toBe('idle'); // untouched — wrong scope
    unsub();
  });

  it('a message on the SIDE scope is ignored (mainline untouched)', () => {
    const qc = new QueryClient();
    const unsub = mountMainlineReader(qc, 'c1');

    ingestConversationFrame(qc, {
      type: 'event',
      scope: conversationSideScope('c1'),
      seq: 1,
      epoch: 'epoch-1',
      kind: 'message',
      payload: { message: message({ id: 'm1', seq: 1 }) },
    } as ServerFrame);

    expect(qc.getQueryData(messagesKey('c1'))).toBeUndefined();
    unsub();
  });

  it('snapshot_required on the MESSAGE scope reconciles mainline, not run-states', () => {
    const qc = new QueryClient();
    const unsubMain = mountMainlineReader(qc, 'c1');
    const unsubRun = mountReader(qc, agentRunStatesKey('c1'));
    const spy = vi.spyOn(qc, 'invalidateQueries');

    ingestConversationFrame(qc, {
      type: 'snapshot_required',
      scope: 'conversation:c1',
      epoch: 'e',
      currentSeq: 5,
    } as ServerFrame);

    expect(spy).toHaveBeenCalledWith({ queryKey: messagesKey('c1') });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: agentRunStatesKey('c1') });
    unsubMain();
    unsubRun();
  });

  it('snapshot_required on the SIDE scope reconciles run-states, not mainline', () => {
    const qc = new QueryClient();
    const unsubMain = mountMainlineReader(qc, 'c1');
    const unsubRun = mountReader(qc, agentRunStatesKey('c1'));
    const spy = vi.spyOn(qc, 'invalidateQueries');

    ingestConversationFrame(qc, {
      type: 'snapshot_required',
      scope: conversationSideScope('c1'),
      epoch: 'e',
      currentSeq: 5,
    } as ServerFrame);

    expect(spy).toHaveBeenCalledWith({ queryKey: agentRunStatesKey('c1') });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: messagesKey('c1') });
    unsubMain();
    unsubRun();
  });
});

// #task:1255 P2 step-4 — DUAL-WATER FLOOR. The ingestor is the SOLE
// content-driven writer of the transport applied-water for the content-gated
// message-stream scope: a frame that produced ≥1 real content write → exactly one
// `markSatisfied(scope, seq, epoch)`; a no-op / readerless / derived-invalidate-only
// frame → none (false-positive forbidden, §4.1). We spy the transport seam so the
// unit test asserts the CALL without running transport state.
function messageFrameSeq(
  channelId: string,
  msg: MessageDto,
  seq: number,
): ServerFrame {
  return {
    type: 'event',
    scope: conversationScope(channelId),
    seq,
    epoch: 'epoch-1',
    kind: 'message',
    payload: { message: msg },
  } as ServerFrame;
}

/** A mainline cache at tail carrying an optional root key so a reply bump lands
 *  in-window. `has_more_after:false` ⇒ `lastPageIsTail` true (append path runs). */
function seedMainline(
  qc: QueryClient,
  channelId: string,
  opts: { rootId?: string; replyCount?: number } = {},
): void {
  const reply_counts_by_root = opts.rootId
    ? { [opts.rootId]: opts.replyCount ?? 0 }
    : {};
  qc.setQueryData(messagesKey(channelId), {
    pages: [
      {
        messages: [],
        reply_counts_by_root,
        has_more_before: false,
        has_more_after: false,
        stream_head_seq: 5,
      },
    ],
    pageParams: [undefined],
  });
}

function mainlineReplyCount(
  qc: QueryClient,
  channelId: string,
  rootId: string,
): number | undefined {
  const data = qc.getQueryData<{
    pages: { reply_counts_by_root: Record<string, number> }[];
  }>(messagesKey(channelId));
  return data?.pages[0]?.reply_counts_by_root[rootId];
}

describe('ingestConversationFrame — per-event satisfaction disposition (#task:1263 (c) / #1261)', () => {
  let markSatisfied: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    markSatisfied = vi
      .spyOn(eventWsClient, 'markSatisfied')
      .mockImplementation(() => {});
    // Isolate: an event-path frame never commits, but guard against a real
    // commit if a future change routes one through here.
    vi.spyOn(eventWsClient, 'commitSnapshotBaseline').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  // markSatisfied is now ASYNC for `message` frames (gated on Promise.allSettled),
  // so positives await and negatives flush a few microtasks first.
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it('① a content-write frame (mainline append) markSatisfies once (scope, seq, epoch) after settle', async () => {
    const qc = new QueryClient();
    const unsub = mountMainlineReader(qc, 'c1');
    ingestConversationFrame(
      qc,
      messageFrameSeq('c1', message({ id: 'm1', seq: 6 }), 6),
      { provenance: 'live' },
    );
    await vi.waitFor(() => expect(markSatisfied).toHaveBeenCalledTimes(1));
    expect(markSatisfied).toHaveBeenCalledWith(conversationScope('c1'), 6, 'epoch-1');
    unsub();
  });

  it('② a derived-invalidate reply markSatisfies only AFTER the refetch COMMITS, not on dispatch', async () => {
    const qc = new QueryClient();
    const unsub = mountMainlineReader(qc, 'c1');
    seedMainline(qc, 'c1', { rootId: 'root1', replyCount: 0 });
    // A controllable invalidate so we can prove commit-gating (initiated ≠ committed).
    let commitRefetch!: () => void;
    vi.spyOn(qc, 'invalidateQueries').mockReturnValue(
      new Promise<void>(resolve => {
        commitRefetch = () => resolve();
      }),
    );
    ingestConversationFrame(
      qc,
      messageFrameSeq('c1', message({ id: 'r1', seq: 6, thread_root_id: 'root1' }), 6),
      { provenance: 'live' },
    );
    await flush();
    // Dispatch-gated would fire now; commit-gated must wait for the refetch.
    expect(markSatisfied).not.toHaveBeenCalled();
    expect(mainlineReplyCount(qc, 'c1', 'root1')).toBe(0); // no optimistic +1
    commitRefetch();
    await vi.waitFor(() => expect(markSatisfied).toHaveBeenCalledTimes(1));
    expect(markSatisfied).toHaveBeenCalledWith(conversationScope('c1'), 6, 'epoch-1');
    unsub();
  });

  it('③ a rejected refetch pins the floor — markSatisfied NOT called', async () => {
    const qc = new QueryClient();
    const unsub = mountMainlineReader(qc, 'c1');
    seedMainline(qc, 'c1', { rootId: 'root1', replyCount: 0 });
    vi.spyOn(qc, 'invalidateQueries').mockRejectedValue(new Error('refetch failed'));
    ingestConversationFrame(
      qc,
      messageFrameSeq('c1', message({ id: 'r1', seq: 6, thread_root_id: 'root1' }), 6),
      { provenance: 'live' },
    );
    await flush();
    expect(markSatisfied).not.toHaveBeenCalled();
    unsub();
  });

  it('④ a warm-inactive mainline (no reader) is REMOVED, then the frame satisfies', async () => {
    const qc = new QueryClient();
    seedMainline(qc, 'c1'); // warm cache, NO observer
    expect(qc.getQueryData(messagesKey('c1'))).not.toBeUndefined();
    ingestConversationFrame(
      qc,
      messageFrameSeq('c1', message({ id: 'm1', seq: 6 }), 6),
      { provenance: 'live' },
    );
    // Warm-removed → next open cold-starts (never left to serve stale, B1)...
    expect(qc.getQueryData(messagesKey('c1'))).toBeUndefined();
    // ...and the removeInactive settle (resolved) lets the floor advance.
    await vi.waitFor(() => expect(markSatisfied).toHaveBeenCalledTimes(1));
    expect(markSatisfied).toHaveBeenCalledWith(conversationScope('c1'), 6, 'epoch-1');
  });

  it('⑤ a cold-absent frame (no reader, no cache) satisfies VACUOUSLY', async () => {
    const qc = new QueryClient();
    ingestConversationFrame(
      qc,
      messageFrameSeq('c1', message({ id: 'm1', seq: 6 }), 6),
      { provenance: 'live' },
    );
    // No cache bootstrapped (the reader gate governs cache-WRITES)...
    expect(qc.getQueryData(messagesKey('c1'))).toBeUndefined();
    // ...but the floor still advances: cold-start is authoritative on next open,
    // and advancing past a cold-absent frame can't strand a warm cache (the #1251
    // hole needs a warm DISPLAYABLE cache, which cold-absent lacks).
    await vi.waitFor(() => expect(markSatisfied).toHaveBeenCalledTimes(1));
    expect(markSatisfied).toHaveBeenCalledWith(conversationScope('c1'), 6, 'epoch-1');
  });

  it('⑥ a multi-target reply markSatisfies EXACTLY ONCE after ALL effects settle', async () => {
    const qc = new QueryClient();
    const unsubMain = mountMainlineReader(qc, 'c1');
    seedMainline(qc, 'c1', { rootId: 'root1', replyCount: 0 });
    const unsubCluster = mountReader(qc, clusterMessagesKey('c1', 'root1'));
    const unsubThreads = mountReader(qc, channelThreadsKey('c1'));
    // 3 effects: mainline reply-count invalidate + cluster append + threads-list
    // invalidate → one markSatisfied once they all settle fulfilled.
    ingestConversationFrame(
      qc,
      messageFrameSeq('c1', message({ id: 'r1', seq: 6, thread_root_id: 'root1' }), 6),
      { provenance: 'live' },
    );
    await vi.waitFor(() => expect(markSatisfied).toHaveBeenCalledTimes(1));
    expect(markSatisfied).toHaveBeenCalledWith(conversationScope('c1'), 6, 'epoch-1');
    unsubMain();
    unsubCluster();
    unsubThreads();
  });

  it('⑦ replaying the same reply frame never double-counts (Cindy #1263 falsifier)', async () => {
    const qc = new QueryClient();
    const unsub = mountMainlineReader(qc, 'c1');
    seedMainline(qc, 'c1', { rootId: 'root1', replyCount: 3 });
    const frame = messageFrameSeq(
      'c1',
      message({ id: 'r1', seq: 6, thread_root_id: 'root1' }),
      6,
    );
    // Deliver the SAME reply twice (live then replay). (c) recovers the count
    // authoritatively (invalidate), never a blind +1 → the count is never bumped
    // locally, so replay cannot double-count (the original bug's regression guard).
    ingestConversationFrame(qc, frame, { provenance: 'live' });
    ingestConversationFrame(qc, frame, { provenance: 'backfill' });
    await flush();
    expect(mainlineReplyCount(qc, 'c1', 'root1')).toBe(3); // never bumped locally
    unsub();
  });

  it('an off-window reply on an ACTIVE mainline satisfies vacuously (authoritative on paginate)', async () => {
    const qc = new QueryClient();
    const unsub = mountMainlineReader(qc, 'c1');
    seedMainline(qc, 'c1'); // no root key → the badge isn't on any loaded page
    ingestConversationFrame(
      qc,
      messageFrameSeq('c1', message({ id: 'r1', seq: 6, thread_root_id: 'rootX' }), 6),
      { provenance: 'live' },
    );
    // No effect (active mainline is authoritative; the count refetches when the
    // window paginates to rootX) → vacuous satisfy, floor advances.
    await vi.waitFor(() => expect(markSatisfied).toHaveBeenCalledTimes(1));
    unsub();
  });

  it('task_changed keeps the SYNCHRONOUS content-apply gate (hybrid: not the message allSettled path)', () => {
    const qc = new QueryClient();
    const unsub = mountMainlineReader(qc, 'c1');
    // Seed the row the chip patches so the patch lands (applied=true).
    qc.setQueryData(messagesKey('c1'), {
      pages: [
        {
          messages: [
            message({ id: 't1', seq: 5, task_number: 7, task_status: 'todo' }),
          ],
          reply_counts_by_root: {},
          has_more_before: false,
          has_more_after: false,
          stream_head_seq: 5,
        },
      ],
      pageParams: [undefined],
    });
    ingestConversationFrame(qc, taskChangedFrame('c1', 't1', 6), { provenance: 'live' });
    // Synchronous (no await) — task/reaction are pure idempotent patches, so they
    // keep the boolean content-apply gate rather than the message allSettled path.
    expect(markSatisfied).toHaveBeenCalledTimes(1);
    expect(markSatisfied).toHaveBeenCalledWith(conversationScope('c1'), 6, 'epoch-1');
    unsub();
  });

  it('side-scope frames never markSatisfied (side floor auto-advances)', async () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, agentRunStatesKey('c1'));
    ingestConversationFrame(qc, agentActivityFrame('c1', runState('c1', 'a1')), {
      provenance: 'live',
    });
    await flush();
    expect(markSatisfied).not.toHaveBeenCalled();
    unsub();
  });

  it('reaction keeps the SYNCHRONOUS floor gate; its reactors refresh is authoritative-on-open, never accumulated (#1263 (A) falsifier)', () => {
    const qc = new QueryClient();
    const unsub = mountMainlineReader(qc, 'c1');
    // Seed the row the reaction targets so the absolute-count patch lands (applied).
    qc.setQueryData(messagesKey('c1'), {
      pages: [
        {
          messages: [message({ id: 'm1', seq: 5 })],
          reply_counts_by_root: {},
          has_more_before: false,
          has_more_after: false,
          stream_head_seq: 5,
        },
      ],
      pageParams: [undefined],
    });
    ingestConversationFrame(qc, reactionFrame('c1', 'm1', 6), { provenance: 'live' });
    // Synchronous (no await): reaction stays on the boolean `reaction_message_patch`
    // gate despite its cursor-inert `reactors_list_refresh` sub-effect — that refresh
    // is NOT commit-gated into the message allSettled path.
    expect(markSatisfied).toHaveBeenCalledTimes(1);
    expect(markSatisfied).toHaveBeenCalledWith(conversationScope('c1'), 6, 'epoch-1');
    // (A) falsifier: the ingestor accumulates NO reactor-list state — the who-reacted
    // popover cache is left untouched (undefined). So advancing the floor past this
    // frame (resume won't replay it) strands nothing: the popover is authoritative-on-
    // open (a fresh REST fetch on hover), correct without the replay.
    expect(qc.getQueryData(messageReactorsKey('m1'))).toBeUndefined();
    unsub();
  });
});

function taskChangedFrame(
  channelId: string,
  messageId: string,
  seq: number,
): ServerFrame {
  return {
    type: 'event',
    scope: conversationScope(channelId),
    seq,
    epoch: 'epoch-1',
    kind: 'task_changed',
    payload: {
      kind: 'status',
      workspace_id: 'w1',
      channel_id: channelId,
      thread_root_id: null,
      legacy_thread_conversation_id: null,
      thread_id: null,
      conversation_id: channelId,
      task_number: 7,
      message_id: messageId,
      status: 'in_progress',
      assignee: null,
      title: 'do the thing',
      closed_at: null,
    },
  } as ServerFrame;
}

function reactionFrame(
  channelId: string,
  messageId: string,
  seq: number,
): ServerFrame {
  return {
    type: 'event',
    scope: conversationScope(channelId),
    seq,
    epoch: 'epoch-1',
    kind: MESSAGE_REACTION_CHANGED_EVENT,
    payload: {
      message_id: messageId,
      conversation_id: channelId,
      thread_root_id: null,
      emoji: '👍',
      op: 'add',
      reactor_kind: 'user',
      reactor_id: 'u2',
      count: 1,
    },
  } as ServerFrame;
}

describe('ingestConversationFrame — snapshot commit gate (#task:1255 P2 step-4)', () => {
  let commit: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    commit = vi
      .spyOn(eventWsClient, 'commitSnapshotBaseline')
      .mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  function snapshotFrame(channelId: string): ServerFrame {
    return {
      type: 'snapshot_required',
      scope: conversationScope(channelId),
      epoch: 'epoch-9',
      currentSeq: 42,
    } as ServerFrame;
  }

  it('commits (scope, epoch) once every reconcile settles fulfilled', async () => {
    const qc = new QueryClient();
    const unsub = mountMainlineReader(qc, 'c1');
    ingestConversationFrame(qc, snapshotFrame('c1'));
    await vi.waitFor(() =>
      expect(commit).toHaveBeenCalledWith(conversationScope('c1'), 'epoch-9'),
    );
    expect(commit).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('an empty reconcile set (no readers) commits vacuously', async () => {
    const qc = new QueryClient();
    ingestConversationFrame(qc, snapshotFrame('c1'));
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
  });

  it('does NOT commit if a reconcile rejects (floor stays pinned)', async () => {
    const qc = new QueryClient();
    const unsub = mountMainlineReader(qc, 'c1');
    vi.spyOn(qc, 'invalidateQueries').mockRejectedValue(new Error('refetch failed'));
    ingestConversationFrame(qc, snapshotFrame('c1'));
    // Flush the allSettled microtasks; commit must never fire.
    await Promise.resolve();
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
    unsub();
  });

  it('a side-scope snapshot never commits (side floor auto-advances)', async () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, agentRunStatesKey('c1'));
    ingestConversationFrame(qc, {
      type: 'snapshot_required',
      scope: conversationSideScope('c1'),
      epoch: 'epoch-9',
      currentSeq: 42,
    } as ServerFrame);
    await Promise.resolve();
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
    unsub();
  });
});

describe('ingestConversationFrame — warm-remove inactive cluster on snapshot (#task:1255 P2 step-4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('removes a warm-but-inactive cluster cache (refetchOnMount:false cold-start)', () => {
    const qc = new QueryClient();
    // A cluster window with data but NO observer (warm-inactive).
    qc.setQueryData(clusterMessagesKey('c1', 'root1'), {
      pages: [
        {
          messages: [message({ id: 'x', seq: 1, thread_root_id: 'root1' })],
          reply_counts_by_root: {},
          has_more_before: false,
          has_more_after: false,
          stream_head_seq: 1,
        },
      ],
      pageParams: [undefined],
    });
    expect(qc.getQueryData(clusterMessagesKey('c1', 'root1'))).not.toBeUndefined();

    ingestConversationFrame(qc, {
      type: 'snapshot_required',
      scope: conversationScope('c1'),
      epoch: 'e',
      currentSeq: 5,
    } as ServerFrame);

    // Removed → next open cold-starts (invalidate alone wouldn't refetch it).
    expect(qc.getQueryData(clusterMessagesKey('c1', 'root1'))).toBeUndefined();
  });

  it('removes a warm-but-inactive mainline cache (default staleTime:5s would serve stale)', async () => {
    const qc = new QueryClient();
    const commit = vi
      .spyOn(eventWsClient, 'commitSnapshotBaseline')
      .mockImplementation(() => {});
    // A mainline window with data but NO observer (warm-inactive): ChannelView
    // unmounted but the cache is still inside the gcTime/staleTime window.
    seedMainline(qc, 'c1');
    expect(qc.getQueryData(messagesKey('c1'))).not.toBeUndefined();

    ingestConversationFrame(qc, {
      type: 'snapshot_required',
      scope: conversationScope('c1'),
      epoch: 'e',
      currentSeq: 5,
    } as ServerFrame);

    // Removed (not left as absent/vacuous), so a remount within staleTime can't
    // display post-commit stale rows; the removeQueries settle is still
    // fulfilled, so the floor commit proceeds.
    expect(qc.getQueryData(messagesKey('c1'))).toBeUndefined();
    await vi.waitFor(() =>
      expect(commit).toHaveBeenCalledWith(conversationScope('c1'), 'e'),
    );
  });

  it('removes BOTH warm mainline AND warm cluster in one snapshot (regression guard)', () => {
    // Guard both warm-remove classes together so a future change can't silently
    // drop one (the mainline hole was exactly "cluster covered, mainline not").
    const qc = new QueryClient();
    vi.spyOn(eventWsClient, 'commitSnapshotBaseline').mockImplementation(() => {});
    seedMainline(qc, 'c1');
    qc.setQueryData(clusterMessagesKey('c1', 'root1'), {
      pages: [
        {
          messages: [message({ id: 'x', seq: 1, thread_root_id: 'root1' })],
          reply_counts_by_root: {},
          has_more_before: false,
          has_more_after: false,
          stream_head_seq: 1,
        },
      ],
      pageParams: [undefined],
    });
    expect(qc.getQueryData(messagesKey('c1'))).not.toBeUndefined();
    expect(qc.getQueryData(clusterMessagesKey('c1', 'root1'))).not.toBeUndefined();

    ingestConversationFrame(qc, {
      type: 'snapshot_required',
      scope: conversationScope('c1'),
      epoch: 'e',
      currentSeq: 5,
    } as ServerFrame);

    expect(qc.getQueryData(messagesKey('c1'))).toBeUndefined();
    expect(qc.getQueryData(clusterMessagesKey('c1', 'root1'))).toBeUndefined();
  });
});
