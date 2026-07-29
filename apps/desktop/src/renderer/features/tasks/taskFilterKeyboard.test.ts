import { describe, expect, it } from 'vitest';
import { rovingKeyAction, isImeComposing } from './taskFilterKeyboard';

describe('isImeComposing', () => {
  // ONE predicate, read by both the roving reducer's call site AND the create
  // picker's form-submit Enter guard, so the two composition checks can't drift.
  it('is true for the modern isComposing flag', () => {
    expect(isImeComposing({ isComposing: true })).toBe(true);
  });

  it('is true for the legacy keyCode 229 even when isComposing is false', () => {
    // The divergence Cindy caught: a `keyCode===229` Enter with `isComposing:false`
    // MUST read as composing at BOTH sites — the reducer bypasses it (no row
    // select) and the picker guard must therefore NOT preventDefault it, or the
    // candidate commit is stolen from the IME.
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it('is false for an ordinary keystroke (no composition)', () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposing({})).toBe(false);
  });
});

describe('rovingKeyAction', () => {
  it('moves down with wrap-around', () => {
    expect(rovingKeyAction('ArrowDown', 0, 3, false)).toEqual({ type: 'move', index: 1 });
    expect(rovingKeyAction('ArrowDown', 2, 3, false)).toEqual({ type: 'move', index: 0 });
  });

  it('moves up with wrap-around', () => {
    expect(rovingKeyAction('ArrowUp', 1, 3, false)).toEqual({ type: 'move', index: 0 });
    expect(rovingKeyAction('ArrowUp', 0, 3, false)).toEqual({ type: 'move', index: 2 });
  });

  it('Home/End jump to the ends when focus is not in a text field', () => {
    expect(rovingKeyAction('Home', 2, 4, false)).toEqual({ type: 'move', index: 0 });
    expect(rovingKeyAction('End', 0, 4, false)).toEqual({ type: 'move', index: 3 });
  });

  it('leaves Home/End as text-cursor nav inside the search input', () => {
    // The searchable channel picker keeps Home/End for the text caret; only
    // the arrows drive the list there (a single-line input ignores them).
    expect(rovingKeyAction('Home', 2, 4, true)).toBeNull();
    expect(rovingKeyAction('End', 0, 4, true)).toBeNull();
    // Arrows and Enter still work with focus in the input.
    expect(rovingKeyAction('ArrowDown', 0, 4, true)).toEqual({ type: 'move', index: 1 });
    expect(rovingKeyAction('Enter', 1, 4, true)).toEqual({ type: 'select' });
  });

  it('Enter selects the current index', () => {
    expect(rovingKeyAction('Enter', 2, 5, false)).toEqual({ type: 'select' });
  });

  it('ignores unrelated keys', () => {
    expect(rovingKeyAction('a', 0, 3, false)).toBeNull();
    expect(rovingKeyAction('Escape', 0, 3, false)).toBeNull();
    expect(rovingKeyAction('Tab', 0, 3, false)).toBeNull();
  });

  it('is inert on an empty list (no rows to move to or select)', () => {
    expect(rovingKeyAction('ArrowDown', 0, 0, false)).toBeNull();
    expect(rovingKeyAction('Enter', 0, 0, false)).toBeNull();
  });

  it('yields every key to the IME while a composition is in flight', () => {
    // CJK candidate selection reuses Enter (commit) and the arrows (walk the
    // candidate window). During composition the list MUST stay inert so the
    // helper never steals — or `preventDefault`s — a keystroke the input method
    // owns. This holds regardless of focus (text field or listbox).
    expect(rovingKeyAction('Enter', 2, 5, true, true)).toBeNull();
    expect(rovingKeyAction('ArrowDown', 0, 5, true, true)).toBeNull();
    expect(rovingKeyAction('ArrowUp', 1, 5, true, true)).toBeNull();
    expect(rovingKeyAction('Enter', 2, 5, false, true)).toBeNull();
  });

  it('resumes list navigation once composition ends', () => {
    // The same keys drive the list again on the next keydown after
    // `compositionend` (composing back to false) — no lingering suppression.
    expect(rovingKeyAction('Enter', 2, 5, true, false)).toEqual({ type: 'select' });
    expect(rovingKeyAction('ArrowDown', 0, 5, true, false)).toEqual({
      type: 'move',
      index: 1,
    });
  });
});
