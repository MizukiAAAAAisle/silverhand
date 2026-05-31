import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Daemon-canonical workspace `.silverhand/` skeleton (D4.e-1). The daemon is
 * the SOLE writer of workspace files; the pre-D4.e backend `initWorkspaceDir`
 * (`packages/backend/src/workspace-files.ts`) was removed in D4.e-5 so
 * `packages/backend/src` carries no agent-host filesystem code (invariant I6).
 * The CONSENSUS default content is kept byte-identical to the pre-D4.e backend
 * value so adopting/seeding an existing workspace does not change bytes
 * (design §5 template ownership; acceptance A5).
 */

/**
 * Byte-identical to the pre-D4.e backend default. Do not reformat.
 */
export const WORKSPACE_CONSENSUS_DEFAULT =
  '# Workspace Consensus\n\n_Add only agreements that ALL members must respect. Keep under 2KB._\n';

/**
 * Initialize a regular workspace directory's `.silverhand/` skeleton:
 *   <workspace>/.silverhand/CONSENSUS.md
 *   <workspace>/.silverhand/agents/
 *
 * Idempotent: safe on existing directories; the CONSENSUS file is only
 * written when missing (preserves member edits).
 */
export async function initWorkspaceSkeleton(workspacePath: string): Promise<void> {
  await mkdir(workspacePath, { recursive: true });
  const dotDir = join(workspacePath, '.silverhand');
  await mkdir(join(dotDir, 'agents'), { recursive: true });
  const consensusPath = join(dotDir, 'CONSENSUS.md');
  try {
    await access(consensusPath);
  } catch {
    await writeFile(consensusPath, WORKSPACE_CONSENSUS_DEFAULT);
  }
}
