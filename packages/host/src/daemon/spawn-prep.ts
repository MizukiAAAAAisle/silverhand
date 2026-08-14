import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SILVERHAND_CONVERSATION_ID_ENV,
  SILVERHAND_DAEMON_SOCKET_ENV,
  SILVERHAND_LAST_DELIVERED_SEQ_FILE_ENV,
} from '@silverhand/shared';
import type { RuntimeScope } from '../protocol.js';
import {
  summarizeSilverhandEnvPresence,
  type SilverhandEnvPresenceSummary,
} from './spawn-diagnostics.js';

export interface SilverhandCliLauncher {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SpawnPrepInput {
  runtimeScope: RuntimeScope;
  agentId: string;
  systemPromptText: string;
  silverhandCli: SilverhandCliLauncher;
  /**
   * Per-spawn Silverhand CLI identity/control-plane env. This is written into
   * the `silverhand` shim itself so CLI calls still work when a runtime's tool
   * shell preserves PATH but scrubs the parent process env.
   */
  silverhandEnv: Record<string, string>;
  daemonSocketPath?: string;
}

export interface SpawnPrepHandle {
  systemPromptPath: string;
  lastDeliveredSeqPath: string;
  binDir: string;
  /** Secret-free proof of which required Silverhand env keys were embedded. */
  silverhandShimEnvPresence: SilverhandEnvPresenceSummary;
  /** The per-spawn temp dir (mkdtemp root). Other spawn-time generated
   *  files (e.g. the profile MCP config handed to a runtime) are written
   *  under here so they're cleaned up together. */
  dir: string;
  cleanup(): Promise<void>;
}

export async function prepareSpawnFiles(
  input: SpawnPrepInput,
): Promise<SpawnPrepHandle> {
  const scopeDir = input.runtimeScope.kind === 'agent'
    ? join('agent', input.agentId)
    : join(input.runtimeScope.conversation_id, input.agentId);
  const parentDir = join(tmpdir(), 'silverhand', scopeDir);
  await mkdir(parentDir, { recursive: true });
  const dir = await mkdtemp(join(parentDir, 'spawn-'));

  const systemPromptPath = join(dir, 'system-prompt.md');
  const lastDeliveredSeqPath = join(
    dir,
    input.runtimeScope.kind === 'agent'
      ? 'last-delivered-seq.json'
      : 'last-delivered-seq',
  );
  const binDir = join(dir, 'bin');
  const silverhandShimPath = join(binDir, 'silverhand');
  const shimEnv: Record<string, string> = {
    ...(input.silverhandCli.env ?? {}),
    ...input.silverhandEnv,
    ...(input.daemonSocketPath
      ? { [SILVERHAND_DAEMON_SOCKET_ENV]: input.daemonSocketPath }
      : {}),
    [SILVERHAND_LAST_DELIVERED_SEQ_FILE_ENV]: lastDeliveredSeqPath,
  };
  // A configured launcher may carry a legacy ambient conversation env of its
  // own. AgentSlot must delete it from the generated shim just as the child
  // process env does; omission from `silverhandEnv` is not sufficient.
  if (input.runtimeScope.kind === 'agent') {
    delete shimEnv[SILVERHAND_CONVERSATION_ID_ENV];
  }
  const shim = renderSilverhandShim(
    input.silverhandCli,
    shimEnv,
    input.runtimeScope.kind === 'agent'
      ? [SILVERHAND_CONVERSATION_ID_ENV]
      : [],
  );

  await Promise.all([
    mkdir(binDir, { recursive: true }),
    writeFile(systemPromptPath, input.systemPromptText, 'utf-8'),
  ]);
  await writeFile(silverhandShimPath, shim, 'utf-8');
  await chmod(silverhandShimPath, 0o755);

  return {
    systemPromptPath,
    lastDeliveredSeqPath,
    binDir,
    silverhandShimEnvPresence: summarizeSilverhandEnvPresence(shimEnv, {
      conversationIdRequired: input.runtimeScope.kind === 'conversation',
    }),
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function renderSilverhandShim(
  launcher: SilverhandCliLauncher,
  env: Record<string, string>,
  unsetKeys: readonly string[],
): string {
  const envAssignments = Object.entries(env)
    .map(([key, value]) => `export ${shellName(key)}=${shellString(value)}`)
    .join('\n');
  const envUnsets = unsetKeys
    .map(key => `unset ${shellName(key)}`)
    .join('\n');
  const command = [launcher.command, ...launcher.args]
    .map(part => shellString(part))
    .join(' ');
  return [
    '#!/bin/sh',
    'set -eu',
    envUnsets,
    envAssignments,
    `exec ${command} "$@"`,
    '',
  ]
    .filter(line => line.length > 0)
    .join('\n');
}

function shellName(value: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value;
  throw new Error(`invalid env var name for silverhand shim: ${value}`);
}

function shellString(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
