import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MCP_CONFIG_FILENAME,
  parseMcpConfig,
  runtimeMcpServerName,
  toClaudeMcpConfig,
  toCodexMcpOverrides,
  type RuntimeKind,
} from '@silverhand/shared';
import type { DaemonLogger } from './logger.js';

/**
 * Spawn-time loader for the subject's **profile MCP** layer
 * (`docs/agent-mcp-config-v1.md`). Reads the L1 `mcp.json`, translates it to
 * the runtime's native ADDITIVE mechanism, and returns the argv to append to
 * the runtime command. Keeping this in ONE module (keyed by `runtimeKind`),
 * rather than inside each driver's `buildArgs`, means: drivers stay pure/sync,
 * the file-write + parse live in one async place, and the codex mechanism can
 * be swapped (`-c` overrides ↔ a future config-file flag) without touching the
 * drivers or the canonical model.
 *
 * Mechanisms (both additive — never replace the user's own MCP, never write
 * the user's runtime config, never call `<runtime> mcp add`):
 *  - **claude:** write a per-spawn temp JSON, pass `--mcp-config <temp>` (no
 *    `--strict-mcp-config`).
 *  - **codex:** one `-c mcp_servers.<prefixed>=<inline-toml>` override per
 *    server (per-server so it MERGES with the user's `[mcp_servers.*]`).
 *
 * Failure semantics (locked, §6): the WRITE path already validated, so a
 * read/parse failure here means a hand-edited / half-written file. We drop the
 * ENTIRE layer (never a silent partial subset), log loud, and return `[]` so
 * the agent STILL spawns. A missing file is the normal "no MCP" case and is
 * silent. MCP *server* connection failures are the runtime's problem, not
 * ours — we never pre-check them.
 */
export interface ProfileMcpSpawnInput {
  runtimeKind: RuntimeKind;
  /** The subject's L1 home dir (daemon-resolved `agent.home_dir`). */
  agentHomeDir: string;
  /** The per-spawn temp dir to write any generated config into. */
  spawnDir: string;
  agentId: string;
  logger: DaemonLogger;
}

export async function buildProfileMcpSpawnArgs(
  input: ProfileMcpSpawnInput,
): Promise<{ args: string[] }> {
  const { runtimeKind, agentHomeDir, spawnDir, agentId, logger } = input;
  const filePath = join(agentHomeDir, MCP_CONFIG_FILENAME);

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // No profile MCP configured — the normal case. Silent.
      return { args: [] };
    }
    // Hard read failure (perm/IO). Loud, drop the layer, still spawn.
    logger.warn(
      { agentId, runtimeKind, filePath, err: String(err) },
      'profile MCP: failed to read mcp.json; skipping the entire MCP layer (agent still spawns)',
    );
    return { args: [] };
  }

  const parsed = parseMcpConfig(raw);
  if (!parsed.ok) {
    // The write path validates, so a bad file is hand-edit/half-write. Loud,
    // all-or-nothing (never a partial subset), non-blocking.
    logger.warn(
      { agentId, runtimeKind, filePath, error: parsed.error },
      'profile MCP: mcp.json failed validation; skipping the entire MCP layer (agent still spawns)',
    );
    return { args: [] };
  }

  const serverNames = Object.keys(parsed.config.mcpServers);
  if (serverNames.length === 0) return { args: [] };

  for (const rawName of serverNames) {
    logger.debug(
      { agentId, runtimeKind, mapping: `profile/${rawName} -> ${runtimeMcpServerName('profile', rawName)}` },
      'profile MCP: loading server',
    );
  }

  try {
    switch (runtimeKind) {
      case 'claude': {
        const claudeConfig = toClaudeMcpConfig(parsed.config, 'profile');
        if (!claudeConfig) return { args: [] };
        const outPath = join(spawnDir, 'profile-mcp.json');
        await writeFile(outPath, JSON.stringify(claudeConfig, null, 2), 'utf-8');
        return { args: ['--mcp-config', outPath] };
      }
      case 'codex': {
        const overrides = toCodexMcpOverrides(parsed.config, 'profile');
        return { args: overrides.flatMap(o => ['-c', o]) };
      }
      default:
        // cursor / others: no profile MCP support in v1. Loud so a user who
        // configured MCP for an unsupported runtime isn't silently ignored.
        logger.warn(
          { agentId, runtimeKind, servers: serverNames.length },
          'profile MCP: runtime has no MCP adapter; skipping the layer',
        );
        return { args: [] };
    }
  } catch (err) {
    // Translation/serialization failure (should be caught at write-time, but
    // be safe). Loud, all-or-nothing, non-blocking.
    logger.warn(
      { agentId, runtimeKind, filePath, err: String(err) },
      'profile MCP: failed to build runtime config; skipping the entire MCP layer (agent still spawns)',
    );
    return { args: [] };
  }
}
