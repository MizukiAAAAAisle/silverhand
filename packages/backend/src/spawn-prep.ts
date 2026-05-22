import { chmod, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SilverhandCliLauncher } from './context.js';

/**
 * Per-spawn temp-file scaffolding. We materialize the synthesized system
 * prompt to disk because some coding-agent CLIs accept it only as
 * `--system-prompt-file <path>`; they do not take long inline strings
 * safely (see core-design §4.2).
 *
 * Layout under `<os.tmpdir()>/silverhand/<conversationId>/<agentId>/<spawn>/`:
 *   - system-prompt.md   buildSystemPromptFor(driver.kind, …) output
 *   - bin/silverhand     stable CLI entrypoint injected at the front of PATH
 *
 * Lifecycle: `DaemonAgentRuntimeHost.start` calls `prepareSpawnFiles`
 * before issuing `bridge.runtimeStart`, then `cleanup()` after the
 * runtime exits. Crashed leaves stragglers — fine, OS tmp gets reaped
 * eventually.
 */

export interface SpawnPrepInput {
  conversationId: string;
  agentId: string;
  systemPromptText: string;
  /** Host-specific launcher that the per-spawn `bin/silverhand` shim forwards to. */
  silverhandCli: SilverhandCliLauncher;
}

export interface SpawnPrepHandle {
  systemPromptPath: string;
  binDir: string;
  cleanup(): Promise<void>;
}

export async function prepareSpawnFiles(
  input: SpawnPrepInput,
): Promise<SpawnPrepHandle> {
  const parentDir = join(tmpdir(), 'silverhand', input.conversationId, input.agentId);
  await mkdir(parentDir, { recursive: true });
  const dir = await mkdtemp(join(parentDir, 'spawn-'));

  const systemPromptPath = join(dir, 'system-prompt.md');
  const binDir = join(dir, 'bin');
  const silverhandShimPath = join(binDir, 'silverhand');

  const shim = renderSilverhandShim(input.silverhandCli);

  await Promise.all([
    mkdir(binDir, { recursive: true }),
    writeFile(systemPromptPath, input.systemPromptText, 'utf-8'),
  ]);
  await writeFile(silverhandShimPath, shim, 'utf-8');
  await chmod(silverhandShimPath, 0o755);

  return {
    systemPromptPath,
    binDir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function renderSilverhandShim(launcher: SilverhandCliLauncher): string {
  const envAssignments = Object.entries(launcher.env ?? {})
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
