/**
 * Falsifiers for the workspace member popover's remove authority — the mirror
 * of `DELETE /api/workspaces/:id/members/:agentId` (#task:1683).
 *
 * The route OR's two arms: `admin` governs the whole agent roster, and any
 * member may retract an agent they created (the symmetric half of enrolling
 * it). Neither arm may swallow the other — a role must not grant ownership of
 * someone else's agent, and ownership must not be required of an admin.
 */
import { describe, expect, it } from 'vitest';
import { canRemoveWorkspaceAgent } from './ManageMembersPopover';

const owned = new Set(['mine-1', 'mine-2']);

describe('canRemoveWorkspaceAgent', () => {
  it('lets a plain member retract the agents they created', () => {
    expect(canRemoveWorkspaceAgent('member', owned, 'mine-1')).toBe(true);
  });

  it('does not let a plain member retract somebody else’s agent', () => {
    expect(canRemoveWorkspaceAgent('member', owned, 'theirs')).toBe(false);
  });

  it('lets admin/owner retract any agent, owned or not', () => {
    for (const role of ['admin', 'owner'] as const) {
      expect(canRemoveWorkspaceAgent(role, new Set(), 'theirs')).toBe(true);
      expect(canRemoveWorkspaceAgent(role, owned, 'mine-1')).toBe(true);
    }
  });

  it('shows nothing while the viewer’s role is unresolved', () => {
    // Fail closed: the affordance appears once the role is known, rather than
    // flashing a control the server might refuse.
    expect(canRemoveWorkspaceAgent(null, owned, 'mine-1')).toBe(false);
  });
});
