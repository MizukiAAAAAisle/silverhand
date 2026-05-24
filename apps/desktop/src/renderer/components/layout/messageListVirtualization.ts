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
}): InitialTopMostItemIndex {
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
}): boolean {
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
