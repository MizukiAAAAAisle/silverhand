// Channel agent-status ingestor buffer + cache patches (#task:1255 P1c),
// extracted verbatim from hooks.ts (#task:1292). Owns the per-channel refcounted
// patch buffer singletons; the central ingestor writes them and useChannelAgents
// (still in hooks.ts) drains them. Depends only on the core key builder.
import type { QueryClient } from '@tanstack/react-query';
import type { ConversationAgentDto } from '@silverhand/shared';
import { agentsKey } from '@/features/channels/message-cache-core';

export type ConversationAgentStatusPatch = Pick<ConversationAgentDto, 'agent_id'> &
  Partial<Pick<ConversationAgentDto, 'status' | 'pid' | 'cli_session_id'>>;

function applySessionAgentPatch(
  agent: ConversationAgentDto,
  patch: ConversationAgentStatusPatch,
): ConversationAgentDto {
  if (agent.agent_id !== patch.agent_id) return agent;
  return {
    ...agent,
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.pid !== undefined ? { pid: patch.pid } : {}),
    ...(patch.cli_session_id !== undefined
      ? { cli_session_id: patch.cli_session_id }
      : {}),
  };
}

function applyPendingSessionAgentPatches(
  agents: ConversationAgentDto[],
  pending: Map<string, ConversationAgentStatusPatch>,
): ConversationAgentDto[] {
  if (pending.size === 0) return agents;
  return agents.map(agent => {
    const patch = pending.get(agent.agent_id);
    return patch ? applySessionAgentPatch(agent, patch) : agent;
  });
}

// ─── Stage-2 P1c: channel agents (agent_status) ingestor buffer ──────────────
// `useChannelAgents` used a hook-local `useRef` buffer so a live `agent_status`
// that arrives WHILE the snapshot GET is in flight isn't lost when the snapshot
// replaces the cache (the queryFn replays the buffer onto the fresh snapshot).
// To make the hook a pure reader (#task:1255 P1c) the buffer moves here, keyed
// per channel, written by the central ingestor and drained by the queryFn. A
// channel can have MORE THAN ONE `useChannelAgents` reader at once (e.g.
// ChannelView + an AgentInfoPopover surface), so the buffer is refcounted: it is
// cleared only when the LAST reader for that channel leaves. A naive
// clear-on-any-unmount would wipe a still-mounted reader's in-flight snapshot
// buffer and drop a live `agent_status` patch (Cindy P1c #1 blocker). This
// mirrors the old per-hook ref, where one hook unmounting never touched another
// hook's buffer.
const pendingAgentStatusPatchesByChannel = new Map<
  string,
  Map<string, ConversationAgentStatusPatch>
>();
const agentStatusBufferRefcount = new Map<string, number>();

function getPendingAgentStatusPatches(
  channelId: string,
): Map<string, ConversationAgentStatusPatch> {
  let buffer = pendingAgentStatusPatchesByChannel.get(channelId);
  if (!buffer) {
    buffer = new Map();
    pendingAgentStatusPatchesByChannel.set(channelId, buffer);
  }
  return buffer;
}

/** Drop the buffered `agent_status` patches for a channel outright (not
 *  refcounted) — used on `snapshot_required`, where the authoritative snapshot
 *  refetch supersedes any buffered live patch regardless of how many readers are
 *  mounted. Reader-lifecycle clearing goes through retain/release instead. */
export function clearPendingAgentStatusPatches(channelId: string): void {
  pendingAgentStatusPatchesByChannel.delete(channelId);
}

/** Register a `useChannelAgents(channelId)` reader's interest in the patch
 *  buffer (#task:1255 P1c). */
export function retainAgentStatusBuffer(channelId: string): void {
  agentStatusBufferRefcount.set(
    channelId,
    (agentStatusBufferRefcount.get(channelId) ?? 0) + 1,
  );
}

/** Release a reader's interest; clear the buffer only when the last reader for
 *  the channel leaves so a concurrent reader's in-flight snapshot buffer isn't
 *  wiped (Cindy P1c #1 blocker). */
export function releaseAgentStatusBuffer(channelId: string): void {
  const next = (agentStatusBufferRefcount.get(channelId) ?? 0) - 1;
  if (next <= 0) {
    agentStatusBufferRefcount.delete(channelId);
    pendingAgentStatusPatchesByChannel.delete(channelId);
  } else {
    agentStatusBufferRefcount.set(channelId, next);
  }
}

/** Replay the buffered `agent_status` patches for a channel onto a fresh agents
 *  snapshot (#task:1255 P1c). Called by `useChannelAgents`'s queryFn so a patch
 *  that landed while the GET was in flight isn't clobbered by the snapshot. */
export function mergePendingAgentStatusPatches(
  channelId: string,
  agents: ConversationAgentDto[],
): ConversationAgentDto[] {
  return applyPendingSessionAgentPatches(
    agents,
    getPendingAgentStatusPatches(channelId),
  );
}

/** True when a `useChannelAgents(channelId)` reader is mounted — the exact
 *  agents key has at least one active observer. Stage-2 P1c gate (#task:1255):
 *  the ingestor patches the agents cache only while a reader is alive. */
export function hasActiveChannelAgentsReader(
  qc: QueryClient,
  channelId: string,
): boolean {
  const entry = qc
    .getQueryCache()
    .find({ queryKey: agentsKey(channelId), exact: true });
  return (entry?.getObserversCount() ?? 0) > 0;
}

/** Apply a live `agent_status` patch to the channel agents cache (#task:1255
 *  P1c) — verbatim move of `useChannelAgents.onEvent`'s agent_status branch:
 *  buffer the patch (so a concurrent snapshot refetch replays it), patch the
 *  cached rows in place, and invalidate to refetch if the agent isn't a known
 *  row yet (a freshly-provisioned agent). */
export function applyAgentStatusToCache(
  qc: QueryClient,
  channelId: string,
  patch: ConversationAgentStatusPatch,
): void {
  if (!patch?.agent_id) return;
  const buffer = getPendingAgentStatusPatches(channelId);
  const prevPatch = buffer.get(patch.agent_id);
  buffer.set(patch.agent_id, { ...prevPatch, ...patch });

  const key = agentsKey(channelId);
  const current = qc.getQueryData<ConversationAgentDto[]>(key);
  const hasCurrentRow =
    current?.some(a => a.agent_id === patch.agent_id) ?? false;

  qc.setQueryData<ConversationAgentDto[]>(key, prev =>
    prev ? prev.map(a => applySessionAgentPatch(a, patch)) : prev,
  );

  if (!hasCurrentRow) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

/** Reconcile the channel agents cache on `snapshot_required` (#task:1255 P1c) —
 *  verbatim move of `useChannelAgents.onEvent`'s connected+snapshot_required
 *  branch: drop the stale buffer and refetch the authoritative snapshot.
 *
 *  Returns the invalidate Promise so the ingestor can join reconcile settle for
 *  the P2 snapshot-baseline commit (#1255 P2). Strategy is unchanged — the
 *  returned Promise ONLY expresses "this reconcile has settled". */
export function reconcileChannelAgentsOnSnapshotRequired(
  qc: QueryClient,
  channelId: string,
): Promise<void> {
  clearPendingAgentStatusPatches(channelId);
  return qc.invalidateQueries({ queryKey: agentsKey(channelId) });
}
