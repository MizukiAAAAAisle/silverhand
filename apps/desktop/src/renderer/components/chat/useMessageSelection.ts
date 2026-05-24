import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MessageDto } from '@silverhand/shared';

/**
 * Multi-select selection state for the message list.
 *
 * Owned by MessageList (not ChannelView) so the cleanup deps —
 * `channelId`, `windowResetVersion`, and `jumpToMessageId` — live in
 * the same scope. If selection state were lifted to ChannelView the
 * window-reset signal isn't reachable without a callback round-trip.
 *
 * State shape:
 * - `mode: 'idle' | 'selecting'`
 * - `selected: Map<msg_id, MessageDto>` — full snapshots, NOT just ids.
 *   We freeze each message at toggle time so an around-window /
 *   latest-window swap (which evicts rows from the cache) doesn't lose
 *   content from the export queue. Cindy's #4 in proposal review.
 *
 * Cleanup is automatic via deps: any change to `channelId`, a window
 * replacement (`windowResetVersion` bump), or a new jump target sets
 * the hook back to `idle` with an empty selection.
 *
 * Sort order on read: every consumer that walks `selected` for export
 * must do so via `selectedSorted()` so the output is in `MessageDto.seq`
 * ascending order regardless of the order in which the user toggled
 * each row.
 */

// ── Pure state primitives ─────────────────────────────────────────────
//
// The reducer-style pure functions below let us unit-test the state
// machine without React. The `useMessageSelection` hook is a thin
// adapter that wires them to React state.

export type SelectionMode = 'idle' | 'selecting';

export interface SelectionState {
  mode: SelectionMode;
  /** Insertion-order Map. Order is NOT meaningful for export — always
   *  read via `selectionSorted()` which sorts by `seq` ascending. */
  selected: ReadonlyMap<string, MessageDto>;
}

export function createSelectionState(): SelectionState {
  return { mode: 'idle', selected: new Map() };
}

/** Enter selection mode and seed with one message. Idempotent: if
 *  already selecting, just adds the message. Returns a new state. */
export function selectionEnter(
  state: SelectionState,
  initial: MessageDto,
): SelectionState {
  const next = new Map(state.selected);
  next.set(initial.id, initial);
  return { mode: 'selecting', selected: next };
}

/** Toggle a single message's membership. No-op semantically when the
 *  state is `idle` — the caller is expected to have entered first.
 *  Always returns a new state object. */
export function selectionToggle(
  state: SelectionState,
  msg: MessageDto,
): SelectionState {
  const next = new Map(state.selected);
  if (next.has(msg.id)) next.delete(msg.id);
  else next.set(msg.id, msg);
  return { mode: state.mode, selected: next };
}

/** Drop all selections but stay in selection mode. */
export function selectionClear(state: SelectionState): SelectionState {
  return { mode: state.mode, selected: new Map() };
}

/** Leave selection mode and drop all selections. */
export function selectionExit(): SelectionState {
  return createSelectionState();
}

/** Read selected snapshots sorted by `MessageDto.seq` ascending —
 *  the only correct read path for export. */
export function selectionSorted(state: SelectionState): MessageDto[] {
  return Array.from(state.selected.values()).sort((a, b) => a.seq - b.seq);
}

export function selectionIsSelected(
  state: SelectionState,
  messageId: string,
): boolean {
  return state.selected.has(messageId);
}

// ── React adapter ─────────────────────────────────────────────────────

export interface MessageSelectionHook {
  mode: SelectionMode;
  /** Selected snapshots keyed by message id. Insertion order is NOT
   *  meaningful — `selectedSorted()` is the only correct read path
   *  for export. */
  selected: ReadonlyMap<string, MessageDto>;
  /** Selected count. Cheap accessor for the toolbar label. */
  count: number;
  /** True iff `mode === 'selecting'`. Convenience for components that
   *  only need the boolean. */
  active: boolean;
  /** Enter selection mode and seed with one message. */
  enter(initial: MessageDto): void;
  /** Toggle a single message's membership. */
  toggle(msg: MessageDto): void;
  /** Drop all selections but stay in selection mode. */
  clear(): void;
  /** Leave selection mode and drop all selections. */
  exit(): void;
  /** Read selected snapshots sorted by `MessageDto.seq` ascending. */
  selectedSorted(): MessageDto[];
  /** Membership check used by MessageItem for checkbox state. */
  isSelected(messageId: string): boolean;
}

/**
 * @param deps Cleanup signals. Any change resets state to idle.
 *   - `channelId` — channel switch.
 *   - `windowResetVersion` — full window replacement (latest ↔
 *     around). Even if the same channel, the visual frame the user
 *     was selecting in is gone.
 *   - `jumpToMessageId` — a new jump request is in flight; the user's
 *     attention has moved.
 */
export function useMessageSelection(deps: {
  channelId: string;
  windowResetVersion: number;
  jumpToMessageId: string | null;
}): MessageSelectionHook {
  const [state, setState] = useState<SelectionState>(createSelectionState);

  // Cleanup: any of the three deps changing puts us back in idle with
  // empty selection. We deliberately key the effect on the deps and not
  // on a derived `key` string so React fires it once per actual change.
  useEffect(() => {
    setState(selectionExit());
  }, [deps.channelId, deps.windowResetVersion, deps.jumpToMessageId]);

  const enter = useCallback((initial: MessageDto) => {
    setState(s => selectionEnter(s, initial));
  }, []);
  const toggle = useCallback((msg: MessageDto) => {
    setState(s => selectionToggle(s, msg));
  }, []);
  const clear = useCallback(() => {
    setState(s => selectionClear(s));
  }, []);
  const exit = useCallback(() => {
    setState(selectionExit());
  }, []);
  const selectedSorted = useCallback(
    (): MessageDto[] => selectionSorted(state),
    [state],
  );
  const isSelected = useCallback(
    (messageId: string): boolean => selectionIsSelected(state, messageId),
    [state],
  );

  const count = state.selected.size;
  const active = state.mode === 'selecting';

  return useMemo(
    () => ({
      mode: state.mode,
      selected: state.selected,
      count,
      active,
      enter,
      toggle,
      clear,
      exit,
      selectedSorted,
      isSelected,
    }),
    [
      state.mode,
      state.selected,
      count,
      active,
      enter,
      toggle,
      clear,
      exit,
      selectedSorted,
      isSelected,
    ],
  );
}
