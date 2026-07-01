import { describe, expect, it } from 'vitest';
import { rovingKeyAction } from './taskFilterKeyboard';

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
});
