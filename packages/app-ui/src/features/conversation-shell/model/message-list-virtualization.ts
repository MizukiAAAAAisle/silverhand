export const FIRST_ITEM_INDEX_START = 1_000_000;

// Fetching rows and mounting their DOM have separate budgets. Touch scrolling
// needs an earlier network head start, but a smaller render budget than desktop.
// Distances follow the actual list viewport (including keyboard/rotation), with
// caps so a large window cannot turn virtualization into an unbounded render.
export function getMessageListViewportBudget(compact: boolean, viewportHeight: number) {
  const height = Math.max(0, viewportHeight);
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  return compact
    ? {
        preload: clamp(height * 2, 400, 1600),
        render: { top: clamp(height * 0.75, 200, 600), bottom: clamp(height * 0.5, 150, 400) },
      }
    : {
        preload: clamp(height, 400, 1200),
        render: { top: clamp(height, 400, 1200), bottom: clamp(height * 0.75, 200, 800) },
      };
}

export type InitialTopMostItemIndex = number | { index: number; align: "center" } | undefined;

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
    return { index: args.jumpTargetIndex, align: "center" };
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

// ── Top-of-window shift classification (#task:1505) ──────────────────────
//
// When the loaded window's first row changes, we must tell three shapes apart
// so Virtuoso keeps its scroll position instead of snapping to the default
// bottom:
//
//   • prepend    — older rows loaded above the old top (fetchPreviousPage). The
//                  old top is still present, deeper in the window.
//   • head-trim  — rows dropped from the HEAD while the rest of the window stays
//                  contiguous. This is the #1505 case: the latest cache page was
//                  live-appended PAST the page limit, so a refetch re-fetches the
//                  fixed-size latest window and trims the surplus head rows. The
//                  old top vanishes, but the reader's visible anchor (below the
//                  trimmed head) survives — so we must preserve position, NOT
//                  treat it as a disjoint replacement.
//   • replace    — a genuinely disjoint window (latest ↔ around-message jump):
//                  no overlap with the previous window.
//
// Overlap decides the shape: if the old top still appears in the new window it
// prepended; else if the new top still appears in the OLD window the head was
// trimmed. If a boundary cluster changes its key, compare the surviving rows
// before declaring the windows disjoint. Classification relies on the query's
// chronological row order (index lookup, no full contiguity proof).
export type TopShift =
  | { kind: "none" }
  | { kind: "prepend"; count: number }
  | { kind: "head-trim"; count: number }
  | { kind: "replace" };

export function classifyTopShift(prevKeys: string[], keys: string[]): TopShift {
  // Nothing observed yet (first data arrival / post-channel-switch): there is no
  // prior anchor to reconcile. The mount itself owns initial positioning, so
  // this must be a no-op — treating it as a replacement would remount spuriously.
  if (keys.length === 0 || prevKeys.length === 0) return { kind: "none" };
  const prevTop = prevKeys[0]!;
  const newTop = keys[0]!;
  if (prevTop === newTop) return { kind: "none" };
  // Old top still below the new head → rows prepended above it.
  const prevTopInNew = keys.indexOf(prevTop);
  if (prevTopInNew > 0) return { kind: "prepend", count: prevTopInNew };
  // New top still inside the old window → the head was trimmed.
  const newTopInPrev = prevKeys.indexOf(newTop);
  if (newTopInPrev > 0) return { kind: "head-trim", count: newTopInPrev };
  // A system-activity cluster is keyed by its first message. Loading older
  // events can extend that cluster and change its key, even though the rows
  // after it still overlap. Preserve those rows instead of remounting at tail.
  const previousIndexes = new Map(prevKeys.map((key, index) => [key, index]));
  for (let index = 0; index < keys.length; index++) {
    const previousIndex = previousIndexes.get(keys[index]!);
    if (previousIndex === undefined) continue;
    const delta = index - previousIndex;
    if (delta > 0) return { kind: "prepend", count: delta };
    if (delta < 0) return { kind: "head-trim", count: -delta };
    return { kind: "none" };
  }
  return { kind: "replace" };
}

// The `firstItemIndex` / remount action for a classified top shift.
//   • prepend  → shift firstItemIndex DOWN by count (existing behavior).
//   • head-trim (no user positioning) → shift firstItemIndex UP by count and do
//     NOT remount: the remaining rows keep their absolute index, so Virtuoso
//     holds the reader's scroll offset. This is the #1505 fix — the whole point
//     is to avoid the default-bottom remount that yanked the reader down.
//   • head-trim WHILE a user positioning command is active (jump / back-to-
//     bottom) → fall through to replacement semantics so those commands keep
//     owning the anchor (no #1504 regression).
//   • replace  → reset firstItemIndex and remount per `shouldRemountForWindowReplacement`.
export type TopShiftAction =
  | { firstItemIndex: "reset"; remount: boolean }
  | { firstItemIndex: "delta"; delta: number; remount: false };

export function resolveTopShiftAction(
  shift: TopShift,
  ctx: {
    userPositioning: boolean;
    hasJumpTarget: boolean;
    jumpTargetIndex: number;
    preferBottom: boolean;
  },
): TopShiftAction {
  const replace = (): TopShiftAction => ({
    firstItemIndex: "reset",
    remount: shouldRemountForWindowReplacement({
      hasJumpTarget: ctx.hasJumpTarget,
      jumpTargetIndex: ctx.jumpTargetIndex,
      preferBottom: ctx.preferBottom,
    }),
  });
  switch (shift.kind) {
    case "none":
      return { firstItemIndex: "delta", delta: 0, remount: false };
    case "prepend":
      return { firstItemIndex: "delta", delta: -shift.count, remount: false };
    case "head-trim":
      if (ctx.userPositioning) return replace();
      return { firstItemIndex: "delta", delta: shift.count, remount: false };
    case "replace":
      return replace();
  }
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
}): "auto" | false {
  return !args.hasJumpTarget && args.isAtTail && args.atBottom ? "auto" : false;
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
export type BottomAnchorIntent = "default" | "bottom";

export type BottomAnchorState = {
  intent: BottomAnchorIntent;
  // A live request awaiting the mount that consumes it. `sawEmpty` latches
  // once the reset's transient empty has been observed, so the following
  // non-empty mount is known to be the fresh latest window (not the stale
  // pre-reset one).
  pending: null | { kind: "tail" | "reset"; sawEmpty: boolean };
};

export type BottomAnchorEvent =
  | { type: "arm-tail" }
  | { type: "arm-reset" }
  // The tail-branch remount committed (bottomAnchorVersion changed).
  | { type: "tail-shown" }
  // Virtuoso is not showing rows (empty cache / loading skeleton).
  | { type: "rows-hidden" }
  // Virtuoso is showing real rows.
  | { type: "rows-shown" }
  // A fresh jump or channel switch overrides any in-flight request.
  | { type: "cancel" };

export const INITIAL_BOTTOM_ANCHOR_STATE: BottomAnchorState = {
  intent: "default",
  pending: null,
};

// Pure transition. Returns the SAME reference on a no-op so `useReducer`
// bails without a re-render (these events fire on every rows/version change).
export function reduceBottomAnchor(
  state: BottomAnchorState,
  event: BottomAnchorEvent,
): BottomAnchorState {
  switch (event.type) {
    case "arm-tail":
      return { intent: "bottom", pending: { kind: "tail", sawEmpty: false } };
    case "arm-reset":
      return { intent: "bottom", pending: { kind: "reset", sawEmpty: false } };
    case "tail-shown":
      // Spend a tail request once its remount has committed (the mount already
      // read the armed intent during that render).
      if (state.pending?.kind !== "tail") return state;
      return INITIAL_BOTTOM_ANCHOR_STATE;
    case "rows-hidden":
      // The reset's transient empty. Latch it so the next real mount consumes.
      if (state.pending?.kind !== "reset" || state.pending.sawEmpty) return state;
      return { intent: "bottom", pending: { kind: "reset", sawEmpty: true } };
    case "rows-shown":
      // Only the latest mount that FOLLOWS the reset's empty consumes. A
      // request that has not yet seen empty is still looking at the pre-reset
      // stale window — leave it armed.
      if (state.pending?.kind !== "reset" || !state.pending.sawEmpty) return state;
      return INITIAL_BOTTOM_ANCHOR_STATE;
    case "cancel":
      if (state.intent === "default" && state.pending === null) return state;
      return INITIAL_BOTTOM_ANCHOR_STATE;
    default:
      return state;
  }
}
