import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * Keyboard behaviour for the task filter dropdowns (#task:1257).
 *
 * The channel / assignee / creator filters are Radix `Popover`s, not Radix
 * `Select`s — the channel picker is a *searchable combobox* (text input + live
 * filtering + grouped sections), which a plain Select can't express. Popover
 * gives us open/close + Esc + outside-click + focus-trap, but NOT arrow-key
 * option navigation the way Select does. So both filter kinds share THIS one
 * roving-highlight helper rather than each hand-rolling its own key handling —
 * ArrowUp/Down wrap, Home/End jump, Enter commits the highlighted row, and the
 * highlight tracks the mouse. That keeps keyboard behaviour identical across the
 * two surfaces (Cindy review baseline: one reused primitive, consistent
 * keyboard/focus/Esc-Enter) without collapsing the searchable channel picker
 * into a non-searchable Select.
 */
export type RovingAction = { type: "move"; index: number } | { type: "select" } | null;

/**
 * True while an IME composition owns the keystroke — both the modern
 * `isComposing` flag (Chromium/Electron) and the legacy `keyCode === 229` some
 * input methods still emit for a composition keydown. Exported so a consumer's
 * OWN key handling (e.g. the create picker's form-submit Enter guard) reads the
 * SAME predicate as the roving helper: the two composition checks must not
 * drift, or a call site could `preventDefault` a keystroke the reducer bypasses
 * (or vice versa) and steal a candidate commit from the IME.
 */
export function isImeComposing(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return Boolean(e.isComposing) || e.keyCode === 229;
}

/**
 * Pure reducer for one keydown — extracted so the wrap/clamp/text-field rules
 * are unit-testable without a DOM. `inTextField` is true when focus sits in the
 * combobox's search input, where Home/End must stay text-cursor navigation
 * (the arrows still drive the list, since a single-line input ignores them).
 *
 * `composing` is true while an IME composition is in flight (e.g. a CJK input
 * method is mid-candidate). Every key then belongs to the input method — the
 * Enter that commits a candidate, and the arrows that move through the candidate
 * window — so the list MUST stay inert: no move, no select, and (at the call
 * site) no `preventDefault`, or the keystroke is stolen from the IME. List
 * navigation resumes on the next ordinary keydown after `compositionend`, when
 * `composing` reads false again.
 */
export function rovingKeyAction(
  key: string,
  current: number,
  count: number,
  inTextField: boolean,
  composing = false,
): RovingAction {
  if (composing) return null;
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return { type: "move", index: (current + 1) % count };
    case "ArrowUp":
      return { type: "move", index: (current - 1 + count) % count };
    case "Home":
      return inTextField ? null : { type: "move", index: 0 };
    case "End":
      return inTextField ? null : { type: "move", index: count - 1 };
    case "Enter":
      return { type: "select" };
    default:
      return null;
  }
}

export interface RovingListApi {
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  /** Attach to the element that owns keydown while the panel is open — the
   *  Popover.Content (listbox) or the combobox search input. */
  onKeyDown: (e: KeyboardEvent) => void;
  /** Ref callback for each option row, so the active row can scroll into view. */
  registerItem: (index: number, el: HTMLElement | null) => void;
}

/**
 * Drives the roving highlight for a flat, ordered option list. The consumer
 * owns render + selection: it passes the current option `count`, whether the
 * panel is `open`, and an `onSelect(index)` that commits row `index`. Pass a
 * `resetKey` (e.g. the search query) to snap the highlight back to the top when
 * the option set is re-derived.
 */
export function useRovingList({
  count,
  open,
  onSelect,
  resetKey,
}: {
  count: number;
  open: boolean;
  onSelect: (index: number) => void;
  resetKey?: unknown;
}): RovingListApi {
  const [activeIndex, setActiveIndex] = useState(0);
  const itemsRef = useRef<(HTMLElement | null)[]>([]);

  // Snap to the first row when the panel (re)opens or the option set is
  // re-derived (search query changed).
  useEffect(() => {
    if (open) setActiveIndex(0);
  }, [open, resetKey]);

  // Clamp when the list shrinks past the current highlight (filtering).
  useEffect(() => {
    setActiveIndex((i) => (i > count - 1 ? Math.max(0, count - 1) : i));
  }, [count]);

  // Keep the highlighted row visible.
  useEffect(() => {
    itemsRef.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const registerItem = useCallback((index: number, el: HTMLElement | null) => {
    itemsRef.current[index] = el;
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inTextField = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      const composing = isImeComposing(e.nativeEvent);
      const action = rovingKeyAction(e.key, activeIndex, count, inTextField, composing);
      if (!action) return;
      e.preventDefault();
      if (action.type === "move") setActiveIndex(action.index);
      else onSelect(activeIndex);
    },
    [activeIndex, count, onSelect],
  );

  return { activeIndex, setActiveIndex, onKeyDown, registerItem };
}
