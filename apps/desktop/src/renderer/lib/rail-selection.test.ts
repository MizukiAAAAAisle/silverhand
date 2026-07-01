import { describe, expect, it } from 'vitest';
import { railRowTierClass, railSelectionTier, type RailRowRef } from './rail-selection';

describe('railSelectionTier (#task:1254 exclusive, workspace/DM-only binary)', () => {
  const ws = (id: string): RailRowRef => ({ kind: 'workspace', workspaceId: id });
  const dm = (id: string): RailRowRef => ({ kind: 'dm', workspaceId: id });

  it('primary when the row is the selected workspace', () => {
    expect(railSelectionTier(ws('w1'), 'w1')).toBe('primary');
    expect(railSelectionTier(dm('w1'), 'w1')).toBe('primary');
  });

  it('none when the row is not the selected workspace', () => {
    expect(railSelectionTier(ws('w2'), 'w1')).toBe('none');
    expect(railSelectionTier(dm('w2'), 'w1')).toBe('none');
  });

  it('an open channel does not change the rule — its parent workspace stays primary', () => {
    // Channels never appear in the rail/STARRED, so opening one under the active
    // workspace simply leaves that workspace selected (the channel highlights in
    // the channel sidebar, a separate column). No channel arg reaches this fn.
    expect(railSelectionTier(ws('w1'), 'w1')).toBe('primary');
  });

  it('suppressed selection (top-level view owns it) → everything none', () => {
    expect(railSelectionTier(ws('w1'), null)).toBe('none');
    expect(railSelectionTier(dm('w1'), null)).toBe('none');
  });

  it('selecting a workspace: exactly one primary across the rail', () => {
    const tiers = [ws('w1'), ws('w2'), dm('w3')].map(r => railSelectionTier(r, 'w1'));
    expect(tiers).toEqual(['primary', 'none', 'none']);
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
