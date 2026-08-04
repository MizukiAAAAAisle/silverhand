import { describe, expect, it } from 'vitest';
import { defaultWorkspaceDataRootDir } from '../../src/daemon/workspace-registry/state-dir.js';

/**
 * #task:1596/#task:1603/#task:1612 — workspace-data lives in the EXPLICIT
 * durable computer data root; the daemon performs NO legacy physical moves
 * (the desktop layout engine owns them and runs before any daemon) and, since
 * #task:1612, no legacy path aliasing either.
 *
 * relocation-v1 §7-4 (#task:1808) — what remains daemon-side is ONLY the
 * durable-root default/wiring below. The caller-proposed-path guards that used
 * to be pinned here (`protectedRoots`, the `legacyWorkspacesRoot` carve-out,
 * the disjoint-volume ancestor guard, the retired stale-path alias) went with
 * the registry write path: no caller proposes a workspace path anymore, so
 * there is no requested path left to validate. The surviving path-safety
 * boundary — a workspace id becoming a path SEGMENT — is pinned in
 * `tests/workspace-path-authority.test.ts`.
 */

describe('defaultWorkspaceDataRootDir', () => {
  it('is the global durable root (used only when the embedder passes nothing)', () => {
    expect(
      defaultWorkspaceDataRootDir().endsWith('/.silverhand/workspace-data'),
    ).toBe(true);
  });
});
