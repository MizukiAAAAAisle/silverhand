import { describe, expect, it } from 'vitest';

import {
  buildChannelFilterOptions,
  type ChannelFilterCandidate,
} from './TaskFilterBar';

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
  it('maps a plain channel to a channel option', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1', title: 'General' }),
    ]);
    expect(out).toEqual([{ id: 'c1', label: 'General', kind: 'channel' }]);
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
      { id: 'c1', label: 'First', kind: 'channel', sublabel: 'ws-a' },
    ]);
  });

  it('marks dm_channel kind as a dm option', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1', kind: 'dm_channel' }),
    ]);
    expect(out[0]?.kind).toBe('dm');
  });

  it('forces dm icon for a plain channel inside a dm workspace', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1', kind: 'channel', fromDmWorkspace: true }),
    ]);
    expect(out[0]?.kind).toBe('dm');
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
