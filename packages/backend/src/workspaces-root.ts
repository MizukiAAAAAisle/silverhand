import { mkdir } from 'node:fs/promises';

/**
 * Backend-local infrastructure: ensure the managed-workspaces root directory
 * exists at boot. This is the ONLY filesystem responsibility the backend
 * retains around workspaces — it creates the server's own managed parent
 * directory, never an agent-host (workspace `.silverhand/` / L1 / L2) path.
 * All agent-host path resolution lives on the daemon (invariant I1/I6).
 *
 * Deliberately a narrow, single-purpose module so the `node:fs` allow-list in
 * `tests/dependency-guard-no-agent-host-fs.test.ts` can grant exactly this one
 * mkdir without re-privileging a larger file (D4.e-5; Cindy review).
 */
export async function ensureWorkspacesRoot(workspacesRoot: string): Promise<void> {
  await mkdir(workspacesRoot, { recursive: true });
}
