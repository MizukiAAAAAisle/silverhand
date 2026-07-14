export const FIRST_ITEM_INDEX_START = 1_000_000;

export type InitialTopMostItemIndex =
  | number
  | { index: number; align: 'center' }
  | undefined;

// `initialTopMostItemIndex` is consumed only when Virtuoso mounts.
// Bottom is the right default for ordinary channel opens, but it is
// wrong while a saved-message jump is pending: a non-tail around window
// has a local bottom that can be hours behind the real conversation tail.
export function getInitialTopMostItemIndex(args: {
  jumpTargetIndex: number;
  hasJumpTarget: boolean;
  itemCount: number;
  // A back-to-bottom re-anchor was just requested. It must win over any
  // still-resolving jump target: the parent clears the jump prop
  // asynchronously, so without this the remount the bottom command triggers
  // would re-center on the jump target and the command would appear to do
  // nothing.
  preferBottom?: boolean;
}): InitialTopMostItemIndex {
  if (args.preferBottom) {
    return Math.max(0, args.itemCount - 1);
  }
  if (args.jumpTargetIndex >= 0) {
    return { index: args.jumpTargetIndex, align: 'center' };
  }
  if (args.hasJumpTarget) {
    return undefined;
  }
  return Math.max(0, args.itemCount - 1);
}

// A full window replacement needs a fresh Virtuoso size/scroll queue.
// During a jump we wait until the replacement actually contains the
// target, otherwise the remount would read the ordinary bottom fallback.
export function shouldRemountForWindowReplacement(args: {
  hasJumpTarget: boolean;
  jumpTargetIndex: number;
  // A back-to-bottom re-anchor is armed. Non-tail back-to-bottom issues an
  // authoritative latest reset; when the fresh window arrives the jump prop
  // may not have cleared yet (the parent clears it asynchronously). Without
  // this, the replacement would see `hasJumpTarget && target absent` and
  // decline to remount, so the new window would keep the stale around-window
  // position. The armed anchor is one command with the reset, so it forces
  // the remount regardless of jump state.
  preferBottom?: boolean;
}): boolean {
  if (args.preferBottom) return true;
  return !args.hasJumpTarget || args.jumpTargetIndex >= 0;
}

// Once the target is present, a jump should enter Virtuoso through a
// fresh mount. Reusing an existing size/scroll queue and then issuing an
// imperative scroll can land on the previous around-window's local
// position when variable-height messages are still being reconciled.
export function shouldRemountForJump(args: {
  hasJumpTarget: boolean;
  jumpTargetIndex: number;
}): boolean {
  return args.hasJumpTarget && args.jumpTargetIndex >= 0;
}

// Virtuoso's "bottom" is local to the mounted data window. Follow output
// only at the real conversation tail; otherwise incoming rows or window
// remounts can pull the user away from a saved-message target.
export function getFollowOutputBehavior(args: {
  hasJumpTarget: boolean;
  isAtTail: boolean;
  atBottom: boolean;
}): 'auto' | false {
  return !args.hasJumpTarget && args.isAtTail && args.atBottom ? 'auto' : false;
}

// ── Back-to-bottom anchor lifecycle ──────────────────────────────────────
//
// Back-to-bottom is ONE command with a strict one-shot lifecycle: it arms a
// bottom `intent` that the NEXT intended mount consumes, then reverts to
// 'default' so later, unrelated window churn (a refetch after the user has
// scrolled up to read history) follows the ordinary rules and does not drag
// them back to the tail. The subtlety this state machine exists for: the two
// branches consume on DIFFERENT signals, and neither can be "items.length > 0"
// alone.
//
//   • tail branch — the loaded window already holds the tail; a
//     `bottomAnchorVersion` remount reads the armed intent, then `tail-shown`
//     (that remount committing) spends it. The window never empties.
//   • reset branch — `resetToLatest()` calls `resetQueries`, which clears the
//     cache to [] BEFORE the tail refetch lands. Virtuoso unmounts on the
//     empty/loading branch and re-mounts NATURALLY when rows return — bumping
//     no version. So consumption cannot key off a version bump. It also cannot
//     consume on the first non-empty render, because the PRE-reset stale
//     around-window is still non-empty at click time. Consumption must wait
//     for the transient empty (`rows-hidden`) and then the real latest mount
//     (`rows-shown`).
export type BottomAnchorIntent = 'default' | 'bottom';

export type BottomAnchorState = {
  intent: BottomAnchorIntent;
  // A live request awaiting the mount that consumes it. `sawEmpty` latches
  // once the reset's transient empty has been observed, so the following
  // non-empty mount is known to be the fresh latest window (not the stale
  // pre-reset one).
  pending: null | { kind: 'tail' | 'reset'; sawEmpty: boolean };
};

export type BottomAnchorEvent =
  | { type: 'arm-tail' }
  | { type: 'arm-reset' }
  // The tail-branch remount committed (bottomAnchorVersion changed).
  | { type: 'tail-shown' }
  // Virtuoso is not showing rows (empty cache / loading skeleton).
  | { type: 'rows-hidden' }
  // Virtuoso is showing real rows.
  | { type: 'rows-shown' }
  // A fresh jump or channel switch overrides any in-flight request.
  | { type: 'cancel' };

export const INITIAL_BOTTOM_ANCHOR_STATE: BottomAnchorState = {
  intent: 'default',
  pending: null,
};

// Pure transition. Returns the SAME reference on a no-op so `useReducer`
// bails without a re-render (these events fire on every rows/version change).
export function reduceBottomAnchor(
  state: BottomAnchorState,
  event: BottomAnchorEvent,
): BottomAnchorState {
  switch (event.type) {
    case 'arm-tail':
      return { intent: 'bottom', pending: { kind: 'tail', sawEmpty: false } };
    case 'arm-reset':
      return { intent: 'bottom', pending: { kind: 'reset', sawEmpty: false } };
    case 'tail-shown':
      // Spend a tail request once its remount has committed (the mount already
      // read the armed intent during that render).
      if (state.pending?.kind !== 'tail') return state;
      return INITIAL_BOTTOM_ANCHOR_STATE;
    case 'rows-hidden':
      // The reset's transient empty. Latch it so the next real mount consumes.
      if (state.pending?.kind !== 'reset' || state.pending.sawEmpty) return state;
      return { intent: 'bottom', pending: { kind: 'reset', sawEmpty: true } };
    case 'rows-shown':
      // Only the latest mount that FOLLOWS the reset's empty consumes. A
      // request that has not yet seen empty is still looking at the pre-reset
      // stale window — leave it armed.
      if (state.pending?.kind !== 'reset' || !state.pending.sawEmpty) return state;
      return INITIAL_BOTTOM_ANCHOR_STATE;
    case 'cancel':
      if (state.intent === 'default' && state.pending === null) return state;
      return INITIAL_BOTTOM_ANCHOR_STATE;
    default:
      return state;
  }
}
