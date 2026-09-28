import type { DirectPairAuthority } from "@/features/chat-shell/model/chat-place-restore";
import type { AppSection } from "@/components/layout/nav-rail";
import { routes } from "@/router";

/**
 * How `handleJumpToMessage` should route a jump target whose only coordinates
 * are ids. A jump target carries NO placement — a workspace-less
 * `channelId` could be a direct line OR a workspace channel that was passed
 * without its workspace id — so the one authority that can tell them apart is
 * the viewer's direct-pair list. This is the same fail-closed discipline the
 * bare-`/chat` restore already owns (`resolveChatPlaceRestore`), applied to the
 * jump seam: an unanswered pair list is NOT an empty one, and guessing routes
 * to a wrong place a navigation can't take back. But the seam and restore read
 * the `refetching` state differently ON PURPOSE — restore waits a frame, this
 * one-shot gesture cannot (there is no replay), so it acts on the last answer's
 * HITs and only fails closed on what that answer could not yet confirm.
 *
 *   - `to-direct`         → the workspace-less target is one of the viewer's
 *                           direct lines; open its route (`routes.chatDirect`,
 *                           plus `?thread` when the target names a reply
 *                           cluster — a pair has clusters since #task:2096).
 *                           Reached on a HIT whether the list is settled
 *                           (`ready`) or `refetching` — a viewer's pair
 *                           membership only grows, so a hit cannot be revoked by
 *                           a read in flight.
 *   - `workspace-resolve` → resolve the target against the workspace arm
 *                           (`resolveNavWorkspaceId` → channel route). Reached
 *                           when the target carries its own workspace id, and
 *                           when a workspace-less target is NOT a known pair on a
 *                           SETTLED list (a normal channel target that simply
 *                           arrived without its workspace id).
 *   - `fail-closed`       → do not navigate. A workspace-LESS target the pair
 *                           list cannot vouch for: it has never answered
 *                           (`pending`/`failed`), or it is `refetching` and this
 *                           id is not in the last answer — possibly a pair the
 *                           in-flight read is about to introduce.
 */
export type JumpNavDecision = "to-direct" | "workspace-resolve" | "fail-closed";

/**
 * Where an ACCEPTED jump lands: which primary pane, and the reply cluster to
 * open with it.
 *
 * This exists to make "does this arm carry the thread coordinate" ONE answer
 * instead of one per arm. The bug it retires: the direct arm navigated with
 * `nav.toDirect(channelId)` and dropped `threadRootId` on the floor, because it
 * was written when a pair had no reply clusters — an invariant #task:2096 ended.
 * So a DM attachment whose source message lived in a thread opened the pair's
 * MAIN line, where that message is not, and the primed locate never matched.
 * The workspace arm meanwhile carried the same coordinate correctly, which is
 * exactly the shape a per-arm decision drifts into.
 *
 * `threadRootId` is therefore normalized ONCE here and shared by both variants;
 * a future third pane kind gets it by construction rather than by remembering.
 */
export type JumpRoute =
  | {
      kind: "direct";
      conversationId: string;
      /** Root of the reply cluster to open, or null for the main line. */
      threadRootId: string | null;
    }
  | {
      kind: "channel";
      workspaceId: string;
      channelId: string;
      threadRootId: string | null;
    };

export function resolveJumpRoute(inputs: {
  /** The accepted decision from {@link resolveJumpNav}. `fail-closed` never
   *  reaches here — it must return before any side effect. */
  decision: Exclude<JumpNavDecision, "fail-closed">;
  channelId: string;
  /** The workspace the channel arm resolved (`resolveNavWorkspaceId`). Null
   *  means unresolvable, and a channel URL cannot be built without it. The
   *  direct arm never reads it: a pair has no container to name. */
  navWorkspaceId: string | null;
  /** The cluster the target names. Both "not named" (`undefined`) and "the main
   *  line" (`null`) are the same downstream answer, which is why the caller can
   *  hand its raw param straight in. */
  threadRootId?: string | null | undefined;
}): JumpRoute | null {
  // One normalization for every arm — the whole point of this function.
  const threadRootId = inputs.threadRootId ?? null;
  if (inputs.decision === "to-direct") {
    return { kind: "direct", conversationId: inputs.channelId, threadRootId };
  }
  if (!inputs.navWorkspaceId) return null;
  return {
    kind: "channel",
    workspaceId: inputs.navWorkspaceId,
    channelId: inputs.channelId,
    threadRootId,
  };
}

/**
 * The section-aware base PATH an accepted {@link JumpRoute} lands on, BEFORE the
 * `?thread` query is layered on (#task:2115). One place answers "which section
 * shell hosts this jump", for BOTH placements:
 *
 *   - From the Activity list, a jump STAYS in `/activity/...` — a channel item
 *     opens `/activity/w/:wid/c/:cid` and a DirectPair opens `/activity/d/:cid`,
 *     both keeping the Activity shell/list beside the reused pane. A DM used to
 *     fall back to `/chat/d/:cid` and leave the section, the dogfood regression
 *     this retires.
 *   - From any other section (chat, or a notification click viewed elsewhere) a
 *     jump lands in chat: `/chat/w/:wid/c/:cid` or `/chat/d/:cid`.
 *
 * The placement (`route.kind`) and the section are ORTHOGONAL — the section
 * chooses the prefix, the placement chooses whether a workspace segment exists —
 * so the two decisions compose here instead of drifting into per-arm `if`s in
 * the caller. A pure string function so the "DM from Activity stays in Activity"
 * contract is pinned without mounting the app.
 */
export function jumpBasePath(section: AppSection, route: JumpRoute): string {
  const inActivity = section === "activity";
  if (route.kind === "direct") {
    return inActivity
      ? routes.activityDirect(route.conversationId)
      : routes.chatDirect(route.conversationId);
  }
  return inActivity
    ? routes.activityChannel(route.workspaceId, route.channelId)
    : routes.chatChannel(route.workspaceId, route.channelId);
}

export function resolveJumpNav(inputs: {
  /** Whether the target carries its own workspace coordinate
   *  (`params.workspaceId`). The discriminator is the TARGET's shape, not the
   *  pair list's state — a target with a workspace id is a channel jump and must
   *  never be gated on an unrelated query being ready (@Paul review #2). */
  hasWorkspaceCoordinate: boolean;
  /** The workspace-less conversation id to route. */
  channelId: string;
  pairs: DirectPairAuthority;
}): JumpNavDecision {
  // Carries a workspace coordinate ⇒ a channel jump. It never needs the pair
  // list, so it is never blocked on the list being ready. Straight to the
  // workspace arm.
  if (inputs.hasWorkspaceCoordinate) return "workspace-resolve";

  // Workspace-less: only the direct-pair authority can classify this id.
  switch (inputs.pairs.status) {
    case "ready":
      // Answered and settled. A hit is the viewer's own direct line. A miss is a
      // normal workspace-channel target that arrived without its workspace id —
      // it falls through to the workspace arm (the pre-existing "use the selected
      // workspace" path), unchanged. Only the workspace-less path is touched.
      return inputs.pairs.conversationIds.has(inputs.channelId) ? "to-direct" : "workspace-resolve";
    case "refetching":
      // Answered before, a refetch in flight now. This is NOT a rare cold window:
      // `['direct-pairs']` is a viewer-global single cache that every incoming DM
      // invalidates, so the gesture (a one-shot click with no replay) routinely
      // lands here. A HIT is safe to act on immediately — the viewer's pair list
      // only grows (no pagination, a named #task:2038 contract; a removed
      // counterpart still returns as a `read_only` row), so a cached membership
      // cannot be revoked by the read in flight. A MISS still fails closed: it
      // may be exactly the freshly minted pair this refetch is about to bring
      // back, and guessing the workspace arm is the wrong-place jump this seam
      // prevents. (Restore reads the same state as `wait`; only this seam acts.)
      return inputs.pairs.conversationIds.has(inputs.channelId) ? "to-direct" : "fail-closed";
    case "pending":
    case "failed":
      // Never answered (cold `?task=` deep-link, first refetch with nothing
      // cached) or a failed read. The list is the sole authority that
      // distinguishes a DM from a channel here, and it has not spoken. Falling to
      // the workspace arm would resolve a workspace-less id against
      // `selectedWorkspaceId` and build a channel URL under a workspace the
      // conversation isn't in — the exact wrong-place jump this seam warns about.
      // Fail closed: do not navigate.
      return "fail-closed";
  }
}
