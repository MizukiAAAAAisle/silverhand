import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SILVERHAND_DAEMON_SOCKET_ENV,
  SILVERHAND_LAST_DELIVERED_SEQ_FILE_ENV,
} from '@silverhand/shared';

export interface SilverhandCliLauncher {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SpawnPrepInput {
  conversationId: string;
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
  /** The per-spawn temp dir (mkdtemp root). Other spawn-time generated
   *  files (e.g. the profile MCP config handed to a runtime) are written
   *  under here so they're cleaned up together. */
  dir: string;
  cleanup(): Promise<void>;
}

export async function prepareSpawnFiles(
  input: SpawnPrepInput,
): Promise<SpawnPrepHandle> {
  const parentDir = join(tmpdir(), 'silverhand', input.conversationId, input.agentId);
  await mkdir(parentDir, { recursive: true });
  const dir = await mkdtemp(join(parentDir, 'spawn-'));

  const systemPromptPath = join(dir, 'system-prompt.md');
  const lastDeliveredSeqPath = join(dir, 'last-delivered-seq');
  const binDir = join(dir, 'bin');
  const silverhandShimPath = join(binDir, 'silverhand');
  const shim = renderSilverhandShim(input.silverhandCli, {
    ...(input.silverhandCli.env ?? {}),
    ...input.silverhandEnv,
    ...(input.daemonSocketPath
      ? { [SILVERHAND_DAEMON_SOCKET_ENV]: input.daemonSocketPath }
      : {}),
    [SILVERHAND_LAST_DELIVERED_SEQ_FILE_ENV]: lastDeliveredSeqPath,
  });

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
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function renderSilverhandShim(
  launcher: SilverhandCliLauncher,
  env: Record<string, string>,
): string {
  const envAssignments = Object.entries(env)
    .map(([key, value]) => `export ${shellName(key)}=${shellString(value)}`)
    .join('\n');
  const command = [launcher.command, ...launcher.args]
    .map(part => shellString(part))
    .join(' ');
  return [
    '#!/bin/sh',
    'set -eu',
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
