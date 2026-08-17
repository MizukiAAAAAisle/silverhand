import type { DirectPairAuthority } from '@/lib/chat-place-restore';

/**
 * How `handleJumpToMessage` should route a jump target whose only coordinates
 * are ids (#task:2052). A jump target carries NO placement — a workspace-less
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
 *                           direct lines; open it with `nav.toDirect`. Reached on
 *                           a HIT whether the list is settled (`ready`) or
 *                           `refetching` — a viewer's pair membership only grows,
 *                           so a hit cannot be revoked by a read in flight.
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
export type JumpNavDecision = 'to-direct' | 'workspace-resolve' | 'fail-closed';

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
  if (inputs.hasWorkspaceCoordinate) return 'workspace-resolve';

  // Workspace-less: only the direct-pair authority can classify this id.
  switch (inputs.pairs.status) {
    case 'ready':
      // Answered and settled. A hit is the viewer's own direct line. A miss is a
      // normal workspace-channel target that arrived without its workspace id —
      // it falls through to the workspace arm (the pre-existing "use the selected
      // workspace" path), unchanged. Only the workspace-less path is touched.
      return inputs.pairs.conversationIds.has(inputs.channelId)
        ? 'to-direct'
        : 'workspace-resolve';
    case 'refetching':
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
      return inputs.pairs.conversationIds.has(inputs.channelId)
        ? 'to-direct'
        : 'fail-closed';
    case 'pending':
    case 'failed':
      // Never answered (cold `?task=` deep-link, first refetch with nothing
      // cached) or a failed read. The list is the sole authority that
      // distinguishes a DM from a channel here, and it has not spoken. Falling to
      // the workspace arm would resolve a workspace-less id against
      // `selectedWorkspaceId` and build a channel URL under a workspace the
      // conversation isn't in — the exact wrong-place jump this seam warns about.
      // Fail closed: do not navigate.
      return 'fail-closed';
  }
}
