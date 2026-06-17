import { describe, expect, it } from 'vitest';

import {
  buildChannelFilterOptions,
  type ChannelFilterCandidate,
} from './TaskFilterBar';
import { workspaceChannelCandidates } from '@/features/tasks/useTaskChannelOptions';

function candidate(
  over: Partial<ChannelFilterCandidate> & { id: string },
): ChannelFilterCandidate {
  return {
    title: `title-${over.id}`,
    kind: 'channel',
    archived_at: null,
    ...over,
  };
}

describe('buildChannelFilterOptions', () => {
  it('maps a plain channel to a channel option (title is the label)', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1', title: 'General' }),
    ]);
    expect(out).toEqual([
      { id: 'c1', label: 'General', group: 'workspace' },
    ]);
  });

  it('skips legacy fossil threads', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1' }),
      candidate({ id: 't1', kind: 'thread' }),
    ]);
    expect(out.map(o => o.id)).toEqual(['c1']);
  });

  it('skips archived channels — this is the drawer leak being fixed', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1' }),
      candidate({ id: 'c2', archived_at: 1700000000000 }),
    ]);
    expect(out.map(o => o.id)).toEqual(['c1']);
  });

  it('dedups by id, first occurrence wins', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1', title: 'First', sublabel: 'ws-a' }),
      candidate({ id: 'c1', title: 'Second', sublabel: 'ws-b' }),
    ]);
    expect(out).toEqual([
      { id: 'c1', label: 'First', group: 'workspace', sublabel: 'ws-a' },
    ]);
  });

  it('puts a dm_channel in the dm group', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1', kind: 'dm_channel' }),
    ]);
    expect(out[0]?.group).toBe('dm');
  });

  it('puts a plain channel inside a dm workspace in the dm group', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1', kind: 'channel', fromDmWorkspace: true }),
    ]);
    expect(out[0]?.group).toBe('dm');
  });

  it('omits sublabel when none is provided (single-workspace surface)', () => {
    const out = buildChannelFilterOptions([candidate({ id: 'c1' })]);
    expect(out[0]).not.toHaveProperty('sublabel');
  });

  it('preserves input order so a pre-sorted caller keeps its order', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'b' }),
      candidate({ id: 'a' }),
      candidate({ id: 'c' }),
    ]);
    expect(out.map(o => o.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('workspaceChannelCandidates — channel picker label/subtitle rule', () => {
  const ch = (id: string, title: string, over: Partial<{ kind: 'channel' | 'dm_channel' | 'thread'; archived_at: number | null }> = {}) => ({
    id,
    title,
    kind: over.kind ?? ('channel' as const),
    archived_at: over.archived_at ?? null,
  });

  it('regular channel: title is the label, workspace name is the subtitle', () => {
    const out = workspaceChannelCandidates(
      { name: 'Engineering', kind: 'regular' },
      [ch('c1', 'general')],
    );
    expect(out[0]).toMatchObject({
      id: 'c1',
      title: 'general',
      sublabel: 'Engineering',
      fromDmWorkspace: false,
    });
  });

  it("an agent's multiple DM channels stay distinct: titles differ, subtitle shares `@agent` (the #1165 bug)", () => {
    // Alice/Cindy/Norman each own `Mentions` + `Onboarding`; before the fix
    // both rendered as the same `@Alice` label. Now the channel title is the
    // label, `@agent` the subtitle — so the rows are distinguishable.
    const out = workspaceChannelCandidates({ name: 'dm-Alice', kind: 'dm' }, [
      ch('c1', 'Mentions', { kind: 'dm_channel' }),
      ch('c2', 'Onboarding', { kind: 'dm_channel' }),
    ]);
    expect(out.map(c => c.title)).toEqual(['Mentions', 'Onboarding']);
    expect(out.every(c => c.sublabel === '@Alice')).toBe(true);
    // No two rows collide on (label, subtitle).
    const built = buildChannelFilterOptions(out);
    const keys = built.map(o => `${o.label}::${o.sublabel}`);
    expect(new Set(keys).size).toBe(built.length);
    expect(built.map(o => o.label)).toEqual(['Mentions', 'Onboarding']);
  });

  it('a single-channel DM still carries the `@agent` subtitle', () => {
    const out = workspaceChannelCandidates({ name: 'dm-Judy', kind: 'dm' }, [
      ch('c1', 'Onboarding', { kind: 'dm_channel' }),
    ]);
    expect(out[0]).toMatchObject({ title: 'Onboarding', sublabel: '@Judy' });
  });
});
