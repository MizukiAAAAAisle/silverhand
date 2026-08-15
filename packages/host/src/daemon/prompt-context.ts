import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DriverPromptContext,
  InjectedFileContent,
  WorkspaceMemoryIndexEntry,
} from '@silverhand/shared';
import type {
  ResolvedStartOptions,
  ResolvedWorkspaceRef,
} from './runtime-start-resolve.js';
import { isResolvedAgentStartOptions } from './runtime-start-resolve.js';
import { readMemoryNotesCatalog } from './memory-notes-catalog.js';

export const MEMORY_INJECT_CAP_BYTES = 16 * 1024;

export async function readFileWithCap(
  path: string,
  capBytes: number,
): Promise<InjectedFileContent> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { kind: 'missing' };
    const reason = code ?? (err as Error | undefined)?.message ?? 'unknown error';
    return { kind: 'unreadable', reason };
  }
  if (buf.byteLength <= capBytes) {
    return { kind: 'present', body: buf.toString('utf-8') };
  }
  let cut = capBytes;
  while (cut > 0 && buf[cut] !== undefined && (buf[cut]! & 0xc0) === 0x80) {
    cut -= 1;
  }
  return {
    kind: 'present',
    body: `${buf.subarray(0, cut).toString('utf-8')}\n…(truncated)`,
  };
}

export async function buildPromptContextFromRuntimeStartOptions(
  options: ResolvedStartOptions,
): Promise<DriverPromptContext> {
  const roleSystemPromptPath = join(
    options.agent.home_dir,
    'system_prompt.md',
  );
  const roleSystemPrompt = await readFile(roleSystemPromptPath, 'utf-8').catch(
    () => '',
  );

  const agentScoped = isResolvedAgentStartOptions(options);
  const workspaceLess = !agentScoped && options.workspace === null;
  let currentMemoryDir: string | null;
  if (agentScoped) {
    currentMemoryDir = options.agent.home_dir;
  } else if (options.workspace === null) {
    currentMemoryDir = null;
  } else {
    currentMemoryDir = memoryDirFor(options.workspace);
  }
  const currentMemory = currentMemoryDir === null
    ? { kind: 'missing' as const }
    : await readFileWithCap(
        join(currentMemoryDir, 'MEMORY.md'),
        MEMORY_INJECT_CAP_BYTES,
      );
  const memoryNotesCatalog = currentMemoryDir === null
    ? { entries: [], omittedCount: 0 }
    : await readMemoryNotesCatalog(currentMemoryDir);

  return {
    agentId: options.agent.id,
    agentName: options.agent.name,
    activeProfileDir: activeProfilePromptDir(
      agentScoped || options.workspace === null ? undefined : options.workspace,
    ),
    roleSystemPrompt,
    roleSystemPromptPath,
    currentMemory,
    memoryNotesCatalog,
    workspaceMemoryIndex: buildWorkspaceMemoryIndexFromRuntimeStartOptions(
      options,
    ),
    sessionContext: agentScoped
      ? {
          kind: 'agent',
          computerId: options.computer_id,
        }
      : options.workspace === null
        ? {
            kind: 'conversation',
            conversationId: options.session.conversation_id,
            computerId: options.computer_id,
            sessionTitle: options.session.title,
            members: options.session.members,
          }
        : {
          kind: 'conversation',
          conversationId: options.session.conversation_id,
          computerId: options.computer_id,
          workspaceName: options.workspace.name,
          // The daemon-resolved local root on THIS computer — the deterministic
          // agent-centric bundle coordinate for regular workspaces, the agent L1
          // home for DMs. Never a server-supplied path.
          workspacePath: options.workspace.path,
          channelKind: options.session.roster_policy === 'fixed' ? 'dm' : 'regular',
          sessionTitle: options.session.title,
          members: options.session.members,
        },
  };
}

export function buildWorkspaceMemoryIndexFromRuntimeStartOptions(
  options: ResolvedStartOptions,
): WorkspaceMemoryIndexEntry[] {
  if (isResolvedAgentStartOptions(options)) return [];
  return options.workspace_memory_index.map(workspace => {
    const isCurrent = options.workspace !== null
      && workspace.id === options.workspace.id;
    const baseLabel =
      workspace.kind === 'agent_home' ? `${workspace.name} (DM)` : workspace.name;
    return {
      label: isCurrent ? `${baseLabel} (current)` : baseLabel,
      // path === null → no local realization on this computer yet; the
      // renderer marks the entry unavailable instead of fabricating a path.
      memoryPath:
        workspace.path === null
          ? null
          : join(
              memoryDirFor({ ...workspace, path: workspace.path }),
              'MEMORY.md',
            ),
    };
  });
}

function activeProfilePromptDir(
  workspace: ResolvedWorkspaceRef | undefined,
): string {
  // relocation-v1 §7 task 1 — the agent cwd IS its L2 root for BOTH kinds now
  // (regular = the workspace bundle root; agent_home = the L1 home), so the
  // prompt's profile dir is always `.` (MEMORY.md at `./MEMORY.md`, notes at
  // `./notes/`). The old `./.silverhand/agents/<id>` sub-path is gone.
  void workspace;
  return '.';
}

function memoryDirFor(workspace: ResolvedWorkspaceRef): string {
  // The absolute L2 memory dir == the resolved cwd for both kinds (see
  // `activeProfilePromptDir`): the regular workspace bundle root or the
  // agent_home L1 home. No per-agent `.silverhand/agents/<id>` sub-path.
  return workspace.path;
}
