import { describe, expect, it } from 'vitest';
import { resolveComputerSelection } from './selection';

describe('computer selection', () => {
  it('keeps a selected computer and prefers local only for a default', () => {
    expect(resolveComputerSelection(['a', 'b'], 'b', 'a')).toBe('b');
    expect(resolveComputerSelection(['a', 'b'], null, 'b')).toBe('b');
  });

  it('falls back after removal without clearing memory on an empty read', () => {
    expect(resolveComputerSelection(['a', 'b'], 'removed', 'b')).toBe('b');
    expect(resolveComputerSelection(['a'], null, 'missing')).toBe('a');
    expect(resolveComputerSelection([], 'b', null)).toBe('b');
  });
});
