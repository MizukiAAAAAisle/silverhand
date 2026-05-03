import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  ChannelDto,
  ChannelKind,
  ChannelRow,
  CreateChannelInput,
} from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

function rowToDto(row: ChannelRow): ChannelDto {
  return { ...row };
}

export interface ChannelRepoOptions {
  /** Root for auto-generated workspaces (`<silverhandDir>/workspaces/`). */
  workspacesRoot: string;
}

export class ChannelRepo {
  constructor(
    private readonly db: Db,
    private readonly opts: ChannelRepoOptions,
  ) {}

  list(): ChannelDto[] {
    const rows = this.db
      .prepare<[], ChannelRow>('SELECT * FROM channels ORDER BY updated_at DESC')
      .all();
    return rows.map(rowToDto);
  }

  get(id: string): ChannelDto | null {
    const row = this.db
      .prepare<[string], ChannelRow>('SELECT * FROM channels WHERE id = ?')
      .get(id);
    return row ? rowToDto(row) : null;
  }

  getByName(name: string): ChannelDto | null {
    const row = this.db
      .prepare<[string], ChannelRow>('SELECT * FROM channels WHERE name = ?')
      .get(name);
    return row ? rowToDto(row) : null;
  }

  /** Look up an agent's DM channel by `dm_agent_id`. Returns null when
   *  the agent has no DM (shouldn't happen for agents created via the
   *  POST /api/agents flow, which auto-provisions one) or the channel
   *  was deleted out from under us. */
  findDmByAgentId(agentId: string): ChannelDto | null {
    const row = this.db
      .prepare<[string], ChannelRow>(
        `SELECT * FROM channels
         WHERE kind = 'dm' AND dm_agent_id = ?
         LIMIT 1`,
      )
      .get(agentId);
    return row ? rowToDto(row) : null;
  }

  /**
   * Synchronous DB insert. Caller is responsible for the filesystem
   * side-effects (mkdir + .silverhand init), which happen separately
   * in the route handler — see `provisionChannel`.
   */
  insert(params: {
    name: string;
    description: string | null;
    kind: ChannelKind;
    workspace_path: string;
    workspace_host_id: string;
    dm_agent_id: string | null;
  }): ChannelDto {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO channels
         (id, name, description, kind, workspace_path, workspace_host_id,
          dm_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.name,
        params.description,
        params.kind,
        params.workspace_path,
        params.workspace_host_id,
        params.dm_agent_id,
        now,
        now,
      );
    const row = this.get(id);
    if (!row) throw new Error('insert failed');
    return row;
  }

  rename(id: string, name: string): ChannelDto | null {
    const now = Date.now();
    this.db
      .prepare('UPDATE channels SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, now, id);
    return this.get(id);
  }

  /** Toggle the soft-archive flag. `true` sets `archived_at = now`,
   *  `false` clears it back to NULL. Touches `updated_at` either way so
   *  the active-list ordering reflects the change. */
  setArchived(id: string, archived: boolean): ChannelDto | null {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE channels
         SET archived_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(archived ? now : null, now, id);
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
  }

  /** Auto-generated workspace path for a regular channel. */
  workspacePathFor(name: string): string {
    return join(this.opts.workspacesRoot, name);
  }
}

/**
 * Initialize a workspace directory's `.silverhand/` skeleton:
 *   <workspace>/.silverhand/CONSENSUS.md   (empty placeholder)
 *   <workspace>/.silverhand/agents/         (will be populated per-member)
 *
 * Idempotent — safe to call on existing dirs.
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
      '# Channel Consensus\n\n_Add only agreements that ALL members must respect. Keep under 2KB._\n',
    );
  }
}

/**
 * Seed L2 (per-channel per-agent) directory by copying L1 (agent global)
 * files. `<workspace>/.silverhand/agents/<agent-id>/` will end up containing
 * the agent's `system_prompt.md` and `MEMORY.md` snapshots, which the
 * agent then mutates independently inside the channel.
 *
 * `agentL1Dir` = `~/.silverhand/agents/<agent-id>/`.
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
      continue; // L2 already has it; do not overwrite
    } catch {
      // not present yet — copy from L1 if available
    }
    try {
      const content = await fs.readFile(src, 'utf8');
      await fs.writeFile(dst, content);
    } catch {
      // L1 doesn't have it either — write empty placeholder
      const placeholder =
        filename === 'system_prompt.md'
          ? `# Role\n\n_To be defined via the channel's onboarding conversation._\n`
          : `# Memory\n\n_What I have learned in this channel. Updated by the agent._\n`;
      await fs.writeFile(dst, placeholder);
    }
  }
}

/** Ensure agent L1 directory exists (`~/.silverhand/agents/<id>/`). */
export async function ensureAgentL1Dir(agentL1Dir: string): Promise<void> {
  await fs.mkdir(join(agentL1Dir, 'notes'), { recursive: true });
  for (const [filename, body] of [
    ['system_prompt.md', '# Global role\n\n_To be shaped via DM._\n'],
    ['MEMORY.md', '# Global memory\n\n_Cross-channel knowledge anchor._\n'],
  ] as const) {
    const path = join(agentL1Dir, filename);
    try {
      await fs.access(path);
    } catch {
      await fs.writeFile(path, body);
    }
  }
}
