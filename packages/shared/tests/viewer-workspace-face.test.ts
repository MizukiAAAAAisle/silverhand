import { describe, expect, it } from 'vitest';
import {
  ViewerWorkspaceDtoSchema,
  WorkspaceSchema,
} from '../src/api/index.js';

/**
 * The workspace boundary's two halves, pinned (#task:2069).
 *
 * Until that ticket ONE type named `WorkspaceDto` was simultaneously the shape
 * `WorkspaceRepo` returns (compared by ~30 backend call sites, most of them
 * authorization doors) and the payload `/api/workspaces*` handed the desktop
 * verbatim. That fusion is *why* there was nowhere to convert the container word:
 * publishing the product word would have pushed presentation vocabulary into the
 * authorization core, and keeping the stored word meant the human desktop decoded
 * a physical DB word locally. The fix was a missing boundary — `Workspace`
 * (domain, STORED) + `ViewerWorkspaceDto` (wire, PUBLISHED) with one projection
 * (`toViewerWorkspace`) at the HTTP edge.
 *
 * #task:2075's stop-publish step then answered the question the boundary had made
 * askable: the wire carries NO container word at all. Every viewer decision asks
 * the ownership relation (`owner_agent_id`) through `isAgentHomeWorkspace*`, so the
 * published word was the same bit spelled twice. #task:2080 has now dropped the
 * stored `workspace_kind` column itself, so the domain shape carries no container
 * word either — the two halves agree on the exact key set, and the only asymmetry
 * that could reappear is a NEW field on one side that the other did not decide to
 * carry. That is what the ledger below still pins.
 *
 * One thing remains uncheckable by reading either type: the wire face is a CHOICE,
 * not an inheritance. `ViewerWorkspaceDtoSchema` is spelled out field by field
 * rather than derived from `WorkspaceSchema`, precisely so a future domain field is
 * not auto-published — that would be the double-duty problem wearing a second name.
 * The cost of that choice is silent drift, which the key ledger below converts into
 * a red cell: a deliberate divergence is updated in the commit that makes it, an
 * accidental one fails.
 */
describe('workspace domain/wire boundary (#task:2069)', () => {
  // The keys the human wire face carries. Written out rather than read from
  // `WorkspaceSchema.shape`, so ADDING a domain field is a decision recorded HERE
  // (publish it → add to this list AND leave the domain gap explicit; keep it
  // internal → the domain-only gap fails cell 2 until stated) instead of silently
  // reaching the desktop.
  const PUBLISHED_KEYS = [
    'archived_at',
    'created_at',
    'description',
    'dm_channel_id',
    'dm_channel_ids',
    'id',
    'name',
    'owner_agent_id',
    'owner_user_id',
    'updated_at',
  ];

  it('publishes exactly the wire key set — no container word among them', () => {
    expect(Object.keys(ViewerWorkspaceDtoSchema.shape).sort()).toEqual(
      [...PUBLISHED_KEYS].sort(),
    );
  });

  it('publishes the domain shape — the two halves agree key-for-key', () => {
    // The other side of the same ledger. With the stored container word dropped
    // (#task:2080) the domain and wire shapes carry the identical key set today, so
    // this is plain key-identity: a domain field added without a matching wire
    // decision (or vice versa) diverges the two shapes and reddens this cell,
    // forcing the decision to be written rather than reached silently.
    expect(Object.keys(ViewerWorkspaceDtoSchema.shape).sort()).toEqual(
      Object.keys(WorkspaceSchema.shape).sort(),
    );
  });
});
