import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentWorkspaceDto,
  AgentWorkspaceFilePreview,
  AgentWorkspaceNote,
} from '@silverhand/shared';

const MAX_PREVIEW_BYTES = 64 * 1024;

/** Read a UTF-8 text file with a hard size cap. Returns null if the
 *  file is missing (the agent's L1 dir gets seeded lazily, so a brand-
 *  new agent may not have these files yet). */
async function readFilePreview(path: string): Promise<AgentWorkspaceFilePreview | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const buf = await fs.readFile(path);
  const truncated = buf.byteLength > MAX_PREVIEW_BYTES;
  const content = truncated
    ? buf.subarray(0, MAX_PREVIEW_BYTES).toString('utf8') +
      '\n\n… (truncated; open in Finder for full content)'
    : buf.toString('utf8');
  return {
    path,
    size: stat.size,
    mtime: stat.mtimeMs,
    content,
    truncated,
  };
}

async function listNotes(notesDir: string): Promise<AgentWorkspaceNote[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(notesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: AgentWorkspaceNote[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.startsWith('.')) continue;
    const full = join(notesDir, e.name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
    out.push({ name: e.name, size: stat.size, mtime: stat.mtimeMs });
  }
  // Newest first — matches how a user actually scans notes ("what
  // did I jot down recently"). Files modified in the same ms get a
  // stable name-based tiebreak.
  out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return out;
}

/**
 * Build the AgentWorkspaceDto for an agent's L1 directory. All file
 * IO happens here so the route handler stays a thin wrapper.
 */
export async function buildAgentWorkspaceDto(
  agentL1Dir: string,
): Promise<AgentWorkspaceDto> {
  const [system_prompt, memory, notes] = await Promise.all([
    readFilePreview(join(agentL1Dir, 'system_prompt.md')),
    readFilePreview(join(agentL1Dir, 'MEMORY.md')),
    listNotes(join(agentL1Dir, 'notes')),
  ]);
  return { l1_path: agentL1Dir, system_prompt, memory, notes };
}
