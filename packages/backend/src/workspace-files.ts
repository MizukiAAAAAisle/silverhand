import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Initialize a workspace directory's `.silverhand/` skeleton:
 *   <workspace>/.silverhand/CONSENSUS.md
 *   <workspace>/.silverhand/agents/
 *
 * Idempotent: safe to call on existing directories.
 */
export async function initWorkspaceDir(workspacePath: string): Promise<void> {
  await fs.mkdir(workspacePath, { recursive: true });
  const dotDir = join(workspacePath, '.silverhand');
  await fs.mkdir(join(dotDir, 'agents'), { recursive: true });
  const consensusPath = join(dotDir, 'CONSENSUS.md');
  try {
    await fs.access(consensusPath);
  } catch {
    await fs.writeFile(
      consensusPath,
      '# Workspace Consensus\n\n_Add only agreements that ALL members must respect. Keep under 2KB._\n',
    );
  }
}

/**
 * Seed L2 (per-workspace per-agent) directory by copying L1 (agent global)
 * files. `<workspace>/.silverhand/agents/<agent-id>/` receives the agent's
 * `system_prompt.md` and `MEMORY.md` snapshots, which the agent later mutates
 * independently inside that workspace.
 */
export async function seedAgentL2(params: {
  workspacePath: string;
  agentId: string;
  agentL1Dir: string;
}): Promise<void> {
  const l2Dir = join(params.workspacePath, '.silverhand', 'agents', params.agentId);
  await fs.mkdir(join(l2Dir, 'notes'), { recursive: true });

  for (const filename of ['system_prompt.md', 'MEMORY.md']) {
    const src = join(params.agentL1Dir, filename);
    const dst = join(l2Dir, filename);
    try {
      await fs.access(dst);
      continue;
    } catch {
      // Not present yet; copy from L1 if available.
    }
    try {
      const content = await fs.readFile(src, 'utf8');
      await fs.writeFile(dst, content);
    } catch {
      const placeholder =
        filename === 'system_prompt.md'
          ? `# Role\n\n_To be defined via the workspace's onboarding conversation._\n`
          : `# Memory\n\n_What I have learned in this workspace. Updated by the agent._\n`;
      await fs.writeFile(dst, placeholder);
    }
  }
}

/** Ensure agent L1 directory exists (`~/.silverhand/agents/<id>/`). */
export async function ensureAgentL1Dir(agentL1Dir: string): Promise<void> {
  await fs.mkdir(join(agentL1Dir, 'notes'), { recursive: true });
  for (const [filename, body] of [
    ['system_prompt.md', '# Global role\n\n_To be shaped via DM._\n'],
    ['MEMORY.md', '# Global memory\n\n_Cross-workspace knowledge anchor._\n'],
  ] as const) {
    const path = join(agentL1Dir, filename);
    try {
      await fs.access(path);
    } catch {
      await fs.writeFile(path, body);
    }
  }
}

