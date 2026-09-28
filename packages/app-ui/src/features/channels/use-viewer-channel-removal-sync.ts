// Triggers for the channel-scope viewer-local removal contract (#task:1689).
// Separate from the read hooks so the contract's pure logic
// (`viewer-channel-removal.ts`) stays React-free and this file holds nothing but
// the observation → chokepoint wiring. TWO observation sources, ONE policy
// (`resolveChannelMembershipLosses`) and ONE chokepoint
// (`handleViewerChannelRemoved`):
//
//   * the SELECTED workspace diffs its two mounted authoritative lists between
//     converged ticks — and owns navigation, because that is the only workspace
//     whose channel can be on screen;
//   * every OTHER member workspace reconciles from an authoritative re-read when
//     its scope reports a change — cache-only, no navigation, no waiting for the
//     viewer to walk over there.
import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import {
  fetchWorkspaceChannelTables,
  workspaceArchivedChannelsQueryKey,
  workspaceChannelsQueryKey,
} from "@/features/workspaces/hooks";
import { onWsFrame, subscribeWsScope } from "@/lib/ws-client";
import { handleViewerWorkspaceRemoved } from "@/features/workspaces/viewer-removal-contract";
import { createForeignWorkspaceReconciler } from "./foreign-workspace-reconcile";
import {
  handleViewerChannelRemoved,
  heldChannelIdsInWorkspace,
  isConvergedListTick,
  reduceChannelRemoval,
  resolveWorkspaceVisibilityLosses,
  type ChannelMembershipRow,
  type ChannelRemovalBaseline,
} from "./viewer-channel-removal";

/**
 * Converge every viewer-local projection when a THIRD PARTY removes the viewer
 * from a channel of the workspace they are looking at — the fact self-leave
 * already settles inside its own mutation and that nothing else observed until
 * now.
 *
 * READ-PATH AUTHORITATIVE (§12.1#6): there is no dedicated event and none is
 * needed (§12.2#3). The removed viewer still holds the workspace scope, so
 * `workspace_channels_changed` invalidates the active + archived channel lists;
 * their refetch IS the observation. This hook diffs the authoritative member set
 * between CONVERGED ticks and funnels each loss through
 * {@link handleViewerChannelRemoved}.
 *
 * CONVERGENCE, not `status` (#task:1689 blocker 1). A tick counts only when each
 * list is `success` AND idle AND not invalidated-awaiting-refetch. React Query
 * keeps `status: 'success'` for the duration of a background refetch, so a
 * `status`-only gate accepts the SPLIT-BRAIN tick — active list already
 * refetched, archived list not yet — during which a channel that just moved
 * between the two tables is absent from both. This contract reads "absent from
 * both" as a visibility loss and acts on it by destroying caches and moving the
 * primary pane, so that window has to be excluded, not merely made unlikely. The
 * `isInvalidated` half is read from the query cache inside the effect: React
 * Query does not surface it on the hook result, and it does not need to be
 * reactive — an invalidation of a mounted list starts a refetch, whose
 * `fetchStatus` transition re-renders and re-runs this effect.
 *
 * A list that is loading, or errored into an empty default, therefore never
 * reads as "every channel lost". The first converged tick of a workspace only
 * establishes the baseline, so a workspace switch can never fire a loss.
 *
 * `onVisibilityLoss` runs ONLY for a channel that left discovery, and only after
 * its caches are settled; it is where the caller moves the primary pane (the same
 * fallback ladder self-leave uses). A public `membership-loss` deliberately calls
 * nothing — the pane stays and collapses to the Join affordance.
 *
 * Also fires after the viewer's OWN leave, once the list refetch lands. That is
 * harmless by construction: every cleanup is idempotent, and the caller's
 * navigation is a no-op once the leave ladder has already moved the pane. For a
 * PUBLIC self-leave it means the channel's still-readable caches are re-read in
 * the background (`membership-loss` invalidates rather than removes) — one silent
 * round-trip, with the pane's data left in place, instead of the visible reload
 * an emptied cache produced (shiki 2026-07-28: 从 public channel leave 时"整个
 * 会话 UI 会刷新一次").
 */
export function useViewerChannelRemovalSync(input: {
  workspaceId: string | null;
  active: readonly ChannelMembershipRow[];
  archived: readonly ChannelMembershipRow[];
  /** `status === 'success' && fetchStatus === 'idle'` of the ACTIVE channel list. */
  activeSettled: boolean;
  /** Same for the ARCHIVED list. A workspace kind that has no archived list
   *  (`enabled: false`) never reaches `success`, so pass `true` there — the
   *  caller knows which lists exist, this hook does not guess. */
  archivedSettled: boolean;
  onVisibilityLoss: (channelId: string) => void;
}): void {
  const { workspaceId, active, archived, activeSettled, archivedSettled, onVisibilityLoss } = input;
  const qc = useQueryClient();
  const baselineRef = useRef<ChannelRemovalBaseline | null>(null);

  useEffect(() => {
    const converged =
      !!workspaceId &&
      isConvergedListTick({
        activeSettled,
        archivedSettled,
        activeAwaitingRefetch: isAwaitingRefetch(qc, workspaceChannelsQueryKey(workspaceId ?? "")),
        archivedAwaitingRefetch: isAwaitingRefetch(
          qc,
          workspaceArchivedChannelsQueryKey(workspaceId ?? ""),
        ),
      });
    const decision = reduceChannelRemoval(baselineRef.current, {
      workspaceId,
      converged,
      active,
      archived,
    });
    baselineRef.current = decision.baseline;
    if (!workspaceId) return;
    for (const loss of decision.losses) {
      handleViewerChannelRemoved(qc, {
        workspaceId,
        channelId: loss.channelId,
        mode: loss.mode,
      });
      if (loss.mode === "visibility-loss") onVisibilityLoss(loss.channelId);
    }
  }, [qc, workspaceId, active, archived, activeSettled, archivedSettled, onVisibilityLoss]);
}

/** Is this authoritative list invalidated and still waiting for its refetch? The
 *  half of convergence the hook result cannot express — read from the cache
 *  inside the effect, which is sound because the refetch an invalidation starts
 *  re-renders on its `fetchStatus` transition and re-runs the effect. */
function isAwaitingRefetch(qc: QueryClient, queryKey: QueryKey): boolean {
  return qc.getQueryState(queryKey)?.isInvalidated === true;
}

/**
 * The same convergence for every member workspace the viewer is NOT looking at
 * (#task:1689 blocker 2). A §12 domain fact must not wait for navigation: a
 * removal from workspace B leaves B's unread badge, Activity rows, Saved rows and
 * task rows describing a channel the viewer can no longer see, and — without this
 * hook — nothing settles them until the viewer walks into B and its list detector
 * happens to run.
 *
 * Why not the same list diff? Because B's lists are not mounted, so there is no
 * previously-observed member set to diff, and invalidation alone fetches nothing.
 * The direction is inverted instead: the CACHES say which channels of B they still
 * describe ({@link heldChannelIdsInWorkspace}), and those ids are the `observed`
 * input of the SAME resolver, evaluated against an authoritative re-read of B's
 * two tables. One policy, two observation sources.
 *
 * Two frame shapes, both handled, because either one can be the only notice of a
 * removal:
 *   - `workspace_channels_changed` carries `{workspace_id, channel_id}` → the
 *     probe narrows to that channel (and to nothing at all when the viewer holds
 *     no state for it, which is what keeps a busy workspace from causing churn).
 *     A payload without a usable `channel_id` degrades to the full held set.
 *   - `snapshot_required` is PER-SCOPE and carries NO channel id: it means "an
 *     unknown amount happened in this scope", and a gap can swallow exactly the
 *     event above. The only correct response is the authoritative re-read for
 *     every held channel — without this arm the live path would be fixed while
 *     reconnect/epoch recovery stayed fail-open.
 *
 * BOTH list caches of that workspace are invalidated UNCONDITIONALLY on both
 * frames — the active list, the per-workspace archived list, and the global
 * archived index — before any held-state gate: holding no viewer-local projection
 * is a reason to skip the probe, never a reason to leave a stale channel list
 * behind for the next time the viewer navigates there.
 *
 * A 403/404 from the re-read is NOT a per-channel answer: it means the viewer
 * lost the WORKSPACE, so it is handed to that fact's own chokepoint
 * ({@link handleViewerWorkspaceRemoved}) plus this contract's channel-scope
 * cleanup for every channel still held there, and the authoritative workspace
 * list is invalidated so the sidebar row converges from the server. Scheduling and
 * that classification live in {@link createForeignWorkspaceReconciler}.
 *
 * Cache-only: no navigation, no `onVisibilityLoss`. A channel of a non-selected
 * workspace cannot be the primary pane, and the selected workspace is excluded
 * here precisely so the two triggers never race for the pane.
 */
export function useForeignWorkspaceChannelRemovalSync(input: {
  /** Every workspace the viewer is a member of (the same set the archived index
   *  subscribes — memberships, not just the selected one). */
  workspaceIds: readonly string[];
  /** Owned by {@link useViewerChannelRemovalSync}; skipped here. */
  selectedWorkspaceId: string | null;
}): void {
  const qc = useQueryClient();
  // Sorted join: a stable dep, so a re-ordered array does not tear down and
  // re-establish every workspace subscription.
  const scopeIdsKey = [...input.workspaceIds].sort().join(",");
  const selectedRef = useRef(input.selectedWorkspaceId);
  selectedRef.current = input.selectedWorkspaceId;

  useEffect(() => {
    const ids = scopeIdsKey ? scopeIdsKey.split(",") : [];
    if (ids.length === 0) return;

    const reconciler = createForeignWorkspaceReconciler({
      fetchTables: fetchWorkspaceChannelTables,
      heldChannelIds: (workspaceId) => heldChannelIdsInWorkspace(qc, workspaceId),
      onLoss: (workspaceId, loss) => {
        handleViewerChannelRemoved(qc, {
          workspaceId,
          channelId: loss.channelId,
          mode: loss.mode,
        });
      },
      onWorkspaceUnreadable: (workspaceId, held) => {
        // The workspace fact goes through the workspace contract's chokepoint;
        // the channel-scope projections it cannot reach (channel-keyed caches,
        // Saved / task / search / per-conversation unread rows) go through this
        // one. Both are idempotent, so the viewer-scope
        // `viewer_workspaces_changed(removed)` handler arriving later is a no-op.
        handleViewerWorkspaceRemoved(qc, workspaceId);
        for (const loss of resolveWorkspaceVisibilityLosses(held)) {
          handleViewerChannelRemoved(qc, {
            workspaceId,
            channelId: loss.channelId,
            mode: loss.mode,
          });
        }
        void qc.invalidateQueries({ queryKey: ["workspaces"] });
      },
    });

    const subscriptions = ids.map((id) => subscribeWsScope(`workspace:${id}`));
    const unsub = onWsFrame((frame) => {
      if (frame.type !== "event" && frame.type !== "snapshot_required") return;
      const workspaceId = ids.find((id) => frame.scope === `workspace:${id}`);
      if (!workspaceId || workspaceId === selectedRef.current) return;
      if (frame.type === "event" && frame.kind !== "workspace_channels_changed") return;
      void qc.invalidateQueries({ queryKey: workspaceChannelsQueryKey(workspaceId) });
      void qc.invalidateQueries({
        queryKey: workspaceArchivedChannelsQueryKey(workspaceId),
      });
      void qc.invalidateQueries({ queryKey: ["archived-channels"] });
      const channelId = frame.type === "event" ? channelIdFromPayload(frame.payload) : null;
      reconciler.request(workspaceId, channelId ? new Set([channelId]) : null);
    });
    return () => {
      reconciler.dispose();
      for (const sub of subscriptions) sub.unsubscribe();
      unsub();
    };
  }, [qc, scopeIdsKey]);
}

/** `workspace_channels_changed` payload → the changed channel, or null when the
 *  payload does not name one. Null degrades to the full held-set reconcile, which
 *  is the fail-safe direction: a narrower probe would be the one that misses. */
function channelIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const channelId = (payload as { channel_id?: unknown }).channel_id;
  return typeof channelId === "string" && channelId.length > 0 ? channelId : null;
}
