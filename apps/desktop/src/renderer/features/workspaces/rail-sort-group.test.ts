/**
 * The rail's sort-group projection (#task:2066 F1, flipped by #task:2045 Delta 4).
 * This is a mechanical fence, not a behaviour test: the token `railSortGroupOf`
 * returns is a WIRE + STORAGE value, and nothing at the call sites shows which
 * spelling is on the rows — so a "simplification" here compiles green and
 * silently resets every user's rail sort mode while leaving their manual drag
 * order in place (`user_list_sort_mode` is keyed by scope, `user_sort_entry` by
 * entity).
 *
 * It asserts the DIRECTION only, and the direction is now terminal: since Delta 4
 * the agent-space token is `'agent_space'` on all three carriers at once — the
 * shared schema, the backend's rail grouping, and the stored rows (migration
 * v86). Before that it was the legacy `'dm'`; this expectation moved with the
 * migration, not ahead of it.
 */
import { describe, expect, it } from 'vitest';
import { railSortGroupOf } from './rail-sort-group';

describe('railSortGroupOf', () => {
  it('maps the agent space to the agent-space sort token', () => {
    expect(railSortGroupOf({ owner_agent_id: 'agent-1' })).toBe('agent_space');
  });

  it('leaves a people-owned workspace on its unchanged token', () => {
    expect(railSortGroupOf({ owner_agent_id: null })).toBe('regular');
  });
});
