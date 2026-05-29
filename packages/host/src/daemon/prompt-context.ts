import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DriverPromptContext,
  InjectedFileContent,
  WorkspaceMemoryIndexEntry,
} from '@silverhand/shared';
import type { StartOptions } from '../protocol.js';

export const MEMORY_INJECT_CAP_BYTES = 16 * 1024;
export const CONSENSUS_INJECT_CAP_BYTES = 4 * 1024;

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
  options: StartOptions,
): Promise<DriverPromptContext> {
  const roleSystemPrompt = await readFile(
    join(options.agent.home_dir, 'system_prompt.md'),
    'utf-8',
  ).catch(() => '');

  const currentMemory = await readFileWithCap(
    join(memoryDirFor(options.workspace, options.agent.id), 'MEMORY.md'),
    MEMORY_INJECT_CAP_BYTES,
  );

  const currentConsensus =
    options.workspace.kind === 'agent_home'
      ? null
      : await readFileWithCap(
          join(options.workspace.path, '.silverhand', 'CONSENSUS.md'),
          CONSENSUS_INJECT_CAP_BYTES,
        );

  return {
    agentId: options.agent.id,
    agentName: options.agent.name,
    activeProfileDir: activeProfilePromptDir(options.workspace, options.agent.id),
    roleSystemPrompt,
    currentMemory,
    currentConsensus,
    workspaceMemoryIndex: buildWorkspaceMemoryIndexFromRuntimeStartOptions(
      options,
    ),
    sessionContext: {
      conversationId: options.session.conversation_id,
      channelName:
        options.session.kind === 'dm_channel'
          ? options.session.title
          : options.workspace.name,
      channelKind: options.session.kind === 'dm_channel' ? 'dm' : 'regular',
      sessionTitle: options.session.title,
      members: options.session.members,
      selfAgentId: options.agent.id,
      isChildSession: options.session.kind === 'thread',
      parentSessionTitle: options.session.parent_title,
      parentChannelConversationId: options.session.parent_conversation_id,
      isAgentSpawnedChild: options.session.spawned_by_agent_id !== null,
    },
  };
}

export function buildWorkspaceMemoryIndexFromRuntimeStartOptions(
  options: StartOptions,
): WorkspaceMemoryIndexEntry[] {
  return options.workspace_memory_index.map(workspace => {
    const isCurrent = workspace.id === options.workspace.id;
    const baseLabel =
      workspace.kind === 'agent_home' ? `${workspace.name} (DM)` : workspace.name;
    return {
      label: isCurrent ? `${baseLabel} (current)` : baseLabel,
      memoryPath: join(memoryDirFor(workspace, options.agent.id), 'MEMORY.md'),
    };
  });
}

function activeProfilePromptDir(
  workspace: StartOptions['workspace'],
  agentId: string,
): string {
  if (workspace.kind === 'agent_home') return '.';
  return `./.silverhand/agents/${agentId}`;
}

function memoryDirFor(
  workspace: StartOptions['workspace'],
  agentId: string,
): string {
  if (workspace.kind === 'agent_home') return workspace.path;
  return join(workspace.path, '.silverhand', 'agents', agentId);
}
