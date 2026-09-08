import { describe, expect, it } from "vitest";
import { isBareCardClick } from "./SavedListView";

/**
 * A Saved card navigates on click, but it wraps fully-interactive message
 * content — a code-fence Copy button, inline links, and selectable text.
 * `isBareCardClick` is the decision branch that keeps those working: the jump
 * fires ONLY for a bare click. This locks the behavior (jump vs. no-jump), not
 * any pixels, so a future "simplify back to `onClick={onJump}`" can't silently
 * reintroduce the reported bug (#task:1497). Pure predicate → mocked DOM stubs,
 * no jsdom needed.
 */

const el = (closestResult: unknown): HTMLElement =>
  ({ closest: () => closestResult }) as unknown as HTMLElement;

const card = (containsResult: boolean): HTMLElement =>
  ({ contains: () => containsResult }) as unknown as HTMLElement;

const selection = (isCollapsed: boolean, anchorNode: Node | null = null): Selection =>
  ({ isCollapsed, anchorNode }) as unknown as Selection;

describe("isBareCardClick — the Saved card jumps only on a bare click", () => {
  it("jumps on a plain click with no selection", () => {
    expect(isBareCardClick(el(null), card(false), null)).toBe(true);
  });

  it("does NOT jump when the click lands on a nested button (code-fence Copy)", () => {
    expect(isBareCardClick(el({}), card(false), null)).toBe(false);
  });

  it("does NOT jump when the click lands on a nested link", () => {
    // `closest('button, a')` matches either; the stub returns a truthy match.
    expect(isBareCardClick(el({}), card(false), null)).toBe(false);
  });

  it("does NOT jump when the click ends a text selection inside the card", () => {
    const anchor = {} as unknown as Node;
    expect(isBareCardClick(el(null), card(true), selection(false, anchor))).toBe(false);
  });

  it("jumps on a genuine click that collapsed a prior selection", () => {
    // mousedown collapses the selection before the click fires.
    expect(isBareCardClick(el(null), card(true), selection(true))).toBe(true);
  });

  it("jumps when a live selection lives OUTSIDE this card", () => {
    const anchor = {} as unknown as Node;
    expect(isBareCardClick(el(null), card(false), selection(false, anchor))).toBe(true);
  });
});
