import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Daemon-canonical workspace `.silverhand/` skeleton (D4.e-1). The daemon is
 * the SOLE writer of workspace files; the pre-D4.e backend `initWorkspaceDir`
 * (`packages/backend/src/workspace-files.ts`) was removed in D4.e-5 so
 * `packages/backend/src` carries no agent-host filesystem code (invariant I6).
 */

/**
 * Initialize a regular workspace directory's `.silverhand/` skeleton.
 * Idempotent: safe on existing directories.
 */
export async function initWorkspaceSkeleton(workspacePath: string): Promise<void> {
  await mkdir(workspacePath, { recursive: true });
  const dotDir = join(workspacePath, '.silverhand');
  await mkdir(join(dotDir, 'agents'), { recursive: true });
}
