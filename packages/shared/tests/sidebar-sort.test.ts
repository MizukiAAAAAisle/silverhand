import { describe, expect, it } from 'vitest';
import {
  SidebarSortResponseSchema,
  SIDEBAR_FIXED_BRANCH_IDS,
  sidebarWorkspaceBranchId,
  SortReorderInputSchema,
} from '../src/api/sort.js';

describe('sidebar sort contract', () => {
  it('keeps fixed branches independent of visibility and entity ids', () => {
    expect(SIDEBAR_FIXED_BRANCH_IDS).toEqual(['section:starred', 'section:direct_messages']);
    expect(sidebarWorkspaceBranchId('section:starred')).toBe('workspace:section:starred');
    expect(
      SortReorderInputSchema.parse({
        list_key: 'sidebar',
        group: 'sidebar',
        ordered_ids: [...SIDEBAR_FIXED_BRANCH_IDS, 'workspace:a'],
      }).ordered_ids,
    ).toHaveLength(3);
  });
  it('cannot advertise recent mode on the server ordered read', () => {
    const viewer_sort = { list_key: 'sidebar', modes: { '': 'manual' }, entries: [] };
    expect(SidebarSortResponseSchema.safeParse({ viewer_sort }).success).toBe(true);
    expect(
      SidebarSortResponseSchema.safeParse({
        viewer_sort: { ...viewer_sort, modes: { '': 'recent' } },
      }).success,
    ).toBe(false);
  });
});
