import { describe, expect, it } from 'vitest';
import { workspaceScopedQueryEnabled } from './workspace-scoped-query';

/** #task:2078 successor to the retired `archivedChannelsEnabledForKind` guard.
 *
 *  That predicate switched on the container KIND, and every kind was enabled —
 *  its only cell with independent content was `null ⇒ false`, i.e. "the
 *  container isn't resolved, don't ask the server about it". This pins exactly
 *  that rule on the shape that replaced it, for the whole workspace-scoped
 *  query family (channel list, viewer sort, archived list, message unread) which
 *  now shares one gate.
 *
 *  The load-bearing cell is the middle one: an id alone is NOT permission. The
 *  id comes from the URL and the row from the workspace list query, so "id
 *  known, row not yet" is a reachable window — and collapsing the gate back to
 *  `!!workspaceId` fires every workspace-scoped read in it. */
describe('workspaceScopedQueryEnabled', () => {
  it('does not fire without a workspace id', () => {
    expect(workspaceScopedQueryEnabled(null, true)).toBe(false);
  });

  it('does not fire while the container row is unresolved', () => {
    expect(workspaceScopedQueryEnabled('w-1', false)).toBe(false);
  });

  it('fires once the id and its resolved row are both in hand', () => {
    expect(workspaceScopedQueryEnabled('w-1', true)).toBe(true);
  });
});
