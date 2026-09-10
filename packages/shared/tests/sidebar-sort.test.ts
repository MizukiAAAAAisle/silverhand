import { describe, expect, it } from 'vitest';
import { WorkspaceColdReadResponseSchema } from '../src/api/workspace.js';
import {
  SidebarSortResponseSchema,
  SIDEBAR_FIXED_BRANCH_IDS,
  sidebarWorkspaceBranchId,
  SortReorderInputSchema,
  SortGroupSchema,
  SortListKeySchema,
} from '../src/api/sort.js';

describe('sidebar sort contract', () => {
  it('workspace identity no longer publishes sort state', () => {
    expect(Object.keys(WorkspaceColdReadResponseSchema.shape)).toEqual(['workspaces']);
    expect(WorkspaceColdReadResponseSchema.parse({ workspaces: [] })).toEqual({ workspaces: [] });
  });
  it('removes the retired list and grouping vocabulary', () => {
    expect(SortListKeySchema.safeParse('workspaces').success).toBe(false);
    for (const group of ['regular', 'agent_space']) {
      expect(SortGroupSchema.safeParse(group).success).toBe(false);
    }
    for (const list of ['sidebar', 'favorites', 'channels:workspace']) {
      expect(SortListKeySchema.safeParse(list).success).toBe(true);
    }
  });
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
