import { describe, expect, it } from 'vitest';
import { pickWorkspaceToRestore } from './workspace-restore';

const ws = (...ids: string[]) => ids.map(id => ({ id }));

describe('pickWorkspaceToRestore', () => {
  it('restores the remembered workspace when it still exists', () => {
    // The core of #task:1222: returning to the chat section must land on the
    // workspace the user last had open, not the first one in the list.
    expect(pickWorkspaceToRestore(ws('a', 'b', 'c'), 'b')).toBe('b');
  });

  it('restores the remembered workspace regardless of list order', () => {
    // Even if the remembered workspace sorts last (e.g. not in the starred
    // group), it still wins over `workspaces[0]`.
    expect(pickWorkspaceToRestore(ws('a', 'b', 'c'), 'c')).toBe('c');
  });

  it('falls back to the first workspace on a cold start (no memory)', () => {
    expect(pickWorkspaceToRestore(ws('a', 'b'), null)).toBe('a');
  });

  it('falls back to the first workspace when the remembered one is gone', () => {
    // Remembered workspace was deleted / archived in another window: don't
    // navigate to a dead id, take the first live one.
    expect(pickWorkspaceToRestore(ws('a', 'b'), 'zzz')).toBe('a');
  });

  it('returns null when there are no workspaces', () => {
    expect(pickWorkspaceToRestore([], null)).toBeNull();
    expect(pickWorkspaceToRestore([], 'a')).toBeNull();
  });
});
