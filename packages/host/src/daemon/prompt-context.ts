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

  const currentMemoryDir = memoryDirFor(options.workspace, options.agent.id);
  const currentMemory = await readFileWithCap(
    join(currentMemoryDir, 'MEMORY.md'),
    MEMORY_INJECT_CAP_BYTES,
  );
  const memoryNotesCatalog = await readMemoryNotesCatalog(currentMemoryDir);

  return {
    agentId: options.agent.id,
    agentName: options.agent.name,
    activeProfileDir: activeProfilePromptDir(options.workspace, options.agent.id),
    roleSystemPrompt,
    roleSystemPromptPath,
    currentMemory,
    memoryNotesCatalog,
    workspaceMemoryIndex: buildWorkspaceMemoryIndexFromRuntimeStartOptions(
      options,
    ),
    sessionContext: {
      conversationId: options.session.conversation_id,
      computerId: options.computer_id,
      workspaceName: options.workspace.name,
      // The daemon-resolved local root on THIS computer (registry for
      // regular workspaces, agent L1 home for DMs) — never the server-side
      // home workspace_path.
      workspacePath: options.workspace.path,
      channelKind: options.session.kind === 'dm_channel' ? 'dm' : 'regular',
      sessionTitle: options.session.title,
      members: options.session.members,
    },
  };
}

export function buildWorkspaceMemoryIndexFromRuntimeStartOptions(
  options: ResolvedStartOptions,
): WorkspaceMemoryIndexEntry[] {
  return options.workspace_memory_index.map(workspace => {
    const isCurrent = workspace.id === options.workspace.id;
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
              memoryDirFor({ ...workspace, path: workspace.path }, options.agent.id),
              'MEMORY.md',
            ),
    };
  });
}

function activeProfilePromptDir(
  workspace: ResolvedWorkspaceRef,
  agentId: string,
): string {
  if (workspace.kind === 'agent_home') return '.';
  return `./.silverhand/agents/${agentId}`;
}

function memoryDirFor(
  workspace: ResolvedWorkspaceRef,
  agentId: string,
): string {
  if (workspace.kind === 'agent_home') return workspace.path;
  return join(workspace.path, '.silverhand', 'agents', agentId);
}
