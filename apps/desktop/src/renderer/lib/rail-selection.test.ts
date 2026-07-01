import { describe, expect, it } from 'vitest';
import { railRowTierClass, railSelectionTier, type RailRowRef } from './rail-selection';

describe('railSelectionTier (#task:1254 exclusive, single-selection binary)', () => {
  const ws = (id: string): RailRowRef => ({ kind: 'workspace', workspaceId: id });
  const dm = (id: string): RailRowRef => ({ kind: 'dm', workspaceId: id });
  const ch = (channelId: string | null, parent: string): RailRowRef => ({
    kind: 'channel',
    channelId,
    workspaceId: parent,
  });

  describe('channel rows are leaf-only (primary or none)', () => {
    it('primary when it is the open channel', () => {
      expect(railSelectionTier(ch('c1', 'w1'), 'w1', 'c1', true)).toBe('primary');
    });
    it('none when a different channel is open', () => {
      expect(railSelectionTier(ch('c1', 'w1'), 'w1', 'c2', true)).toBe('none');
    });
    it('none when no channel is open (even if its parent ws is active)', () => {
      expect(railSelectionTier(ch('c1', 'w1'), 'w1', null, false)).toBe('none');
    });
    it('none for a channel row whose own id is null', () => {
      expect(railSelectionTier(ch(null, 'w1'), 'w1', null, false)).toBe('none');
    });
  });

  describe('workspace / dm rows: the single-selection rule keyed on selectedChannelStarred', () => {
    it('primary when selected and NO channel is open (the ws itself is the leaf)', () => {
      expect(railSelectionTier(ws('w1'), 'w1', null, false)).toBe('primary');
      expect(railSelectionTier(dm('w1'), 'w1', null, false)).toBe('primary');
    });
    it('primary when the active ws holds a NON-starred open channel (workspace keeps the cue)', () => {
      expect(railSelectionTier(ws('w1'), 'w1', 'c1', false)).toBe('primary');
      expect(railSelectionTier(dm('w1'), 'w1', 'c1', false)).toBe('primary');
    });
    it('none when the active ws holds a STARRED open channel (that STARRED row owns the highlight)', () => {
      expect(railSelectionTier(ws('w1'), 'w1', 'c1', true)).toBe('none');
      expect(railSelectionTier(dm('w1'), 'w1', 'c1', true)).toBe('none');
    });
    it('none (fail-closed) when the open channel starred-ness is UNKNOWN (null, cross-ws load window)', () => {
      // A channel is open but its ws channel sort has not loaded yet — must not
      // let the workspace row also go primary while the STARRED channel row does.
      expect(railSelectionTier(ws('w1'), 'w1', 'c1', null)).toBe('none');
      expect(railSelectionTier(dm('w1'), 'w1', 'c1', null)).toBe('none');
    });
    it('none when it is not the active ws', () => {
      expect(railSelectionTier(ws('w2'), 'w1', null, false)).toBe('none');
      expect(railSelectionTier(ws('w2'), 'w1', 'c1', false)).toBe('none');
      expect(railSelectionTier(ws('w2'), 'w1', 'c1', true)).toBe('none');
    });
  });

  it('suppressed selection (top-level view owns it) → everything none', () => {
    expect(railSelectionTier(ws('w1'), null, null, false)).toBe('none');
    expect(railSelectionTier(dm('w1'), null, null, false)).toBe('none');
    expect(railSelectionTier(ch('c1', 'w1'), null, null, false)).toBe('none');
  });

  it('open a STARRED channel: exactly one primary (the STARRED channel row), its ws none', () => {
    const selectedWs = 'w1';
    const selectedCh = 'c1';
    expect(railSelectionTier(ch('c1', 'w1'), selectedWs, selectedCh, true)).toBe('primary'); // the STARRED leaf
    expect(railSelectionTier(ws('w1'), selectedWs, selectedCh, true)).toBe('none'); // parent ws not highlighted
    expect(railSelectionTier(ws('w2'), selectedWs, selectedCh, true)).toBe('none'); // sibling ws
    expect(railSelectionTier(ch('c2', 'w1'), selectedWs, selectedCh, true)).toBe('none'); // sibling channel
  });

  it('cross-ws load window (starred-ness unknown): STARRED channel row primary, parent ws stays none', () => {
    // During cross-workspace nav the target ws channel sort is not cached, so the
    // starred flag is null. The channel row still resolves from selectedChannelId
    // alone (primary), but the workspace must NOT double-highlight.
    const selectedWs = 'w1';
    const selectedCh = 'c1';
    expect(railSelectionTier(ch('c1', 'w1'), selectedWs, selectedCh, null)).toBe('primary');
    expect(railSelectionTier(ws('w1'), selectedWs, selectedCh, null)).toBe('none');
    expect(railSelectionTier(dm('w2'), selectedWs, selectedCh, null)).toBe('none');
  });

  it('open a NON-starred channel: exactly one primary (the parent workspace row)', () => {
    const selectedWs = 'w1';
    const selectedCh = 'c1';
    expect(railSelectionTier(ws('w1'), selectedWs, selectedCh, false)).toBe('primary'); // ws keeps the cue
    expect(railSelectionTier(ws('w2'), selectedWs, selectedCh, false)).toBe('none'); // sibling ws
    // No STARRED row exists for a non-starred channel; the channel highlights in
    // the channel sidebar (a separate column), not the rail.
  });

  it('selecting a workspace directly: that ws is the single primary', () => {
    const tiers = [ws('w1'), ws('w2'), dm('w3'), ch('c1', 'w1')].map(r =>
      railSelectionTier(r, 'w1', null, false),
    );
    expect(tiers).toEqual(['primary', 'none', 'none', 'none']);
  });
});

describe('railRowTierClass (#task:1254 binary visual vocabulary)', () => {
  it('primary carries the selected-fill + on-selected text hook (theme border keys on it)', () => {
    const cls = railRowTierClass('primary');
    expect(cls).toContain('text-text-on-selected');
    expect(cls).toContain('bg-[var(--bg-row-selected,var(--bg-selected))]');
  });

  it('none is resting + hover only, without the selected hook', () => {
    const cls = railRowTierClass('none');
    expect(cls).not.toContain('text-text-on-selected');
    expect(cls).toContain('hover:');
  });

  it('there is no ambient tier anymore (no .rail-row-ambient anywhere)', () => {
    expect(railRowTierClass('primary')).not.toContain('rail-row-ambient');
    expect(railRowTierClass('none')).not.toContain('rail-row-ambient');
  });
});
