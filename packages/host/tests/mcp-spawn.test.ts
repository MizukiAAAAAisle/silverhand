import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProfileMcpSpawnArgs } from '../src/daemon/mcp-spawn.js';
import type { DaemonLogger } from '../src/daemon/logger.js';

/**
 * Spawn-time profile-MCP adapter (#task:1135, docs/agent-mcp-config-v1.md §4).
 * Locks the per-runtime ADDITIVE translation + the fail-loud/non-blocking,
 * all-or-nothing failure semantics (§6):
 *   - absent file  → silent `[]` (the normal "no MCP" case)
 *   - empty config → `[]`
 *   - claude       → writes a per-spawn JSON, returns `--mcp-config <path>`
 *                    with names prefixed `silverhand_profile__*` (NEVER
 *                    `--strict-mcp-config`, which would REPLACE the user's MCP)
 *   - codex        → one `-c mcp_servers.<prefixed>=<toml>` per server
 *   - bad JSON     → loud, drop the WHOLE layer, still spawn (`[]`)
 *   - hard read err→ loud, `[]`
 *   - unknown rt   → loud, `[]`
 */

function captureLogger(): { logger: DaemonLogger; warns: unknown[][] } {
  const warns: unknown[][] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (obj: unknown, msg?: string) => {
      warns.push([obj, msg]);
    },
    error: () => {},
  } as unknown as DaemonLogger;
  return { logger, warns };
}

const AGENT_ID = 'aid-mcp-spawn';

let homeDir = '';
let spawnDir = '';
afterEach(() => {
  for (const d of [homeDir, spawnDir]) {
    try {
      if (d) rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});
beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'mcp-home-'));
  spawnDir = mkdtempSync(join(tmpdir(), 'mcp-spawn-'));
});

describe('buildProfileMcpSpawnArgs', () => {
  it('returns [] silently when no mcp.json exists (the normal case)', async () => {
    const { logger, warns } = captureLogger();
    const r = await buildProfileMcpSpawnArgs({
      runtimeKind: 'claude',
      agentHomeDir: homeDir,
      spawnDir,
      agentId: AGENT_ID,
      logger,
    });
    expect(r.args).toEqual([]);
    expect(warns).toEqual([]); // absent is silent, NOT loud
  });

  it('returns [] for an empty server map', async () => {
    writeFileSync(join(homeDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const { logger } = captureLogger();
    const r = await buildProfileMcpSpawnArgs({
      runtimeKind: 'codex',
      agentHomeDir: homeDir,
      spawnDir,
      agentId: AGENT_ID,
      logger,
    });
    expect(r.args).toEqual([]);
  });

  it('claude: writes a per-spawn config and passes --mcp-config (NEVER --strict-mcp-config)', async () => {
    writeFileSync(
      join(homeDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', args: ['-y', 'server-fs'] },
          remote: { type: 'http', url: 'https://example.com/mcp' },
        },
      }),
    );
    const { logger } = captureLogger();
    const r = await buildProfileMcpSpawnArgs({
      runtimeKind: 'claude',
      agentHomeDir: homeDir,
      spawnDir,
      agentId: AGENT_ID,
      logger,
    });
    expect(r.args[0]).toBe('--mcp-config');
    expect(r.args).not.toContain('--strict-mcp-config');
    const outPath = r.args[1]!;
    expect(outPath).toBe(join(spawnDir, 'profile-mcp.json'));
    const written = JSON.parse(readFileSync(outPath, 'utf-8'));
    // Names are namespaced so they never shadow the user's own servers.
    expect(Object.keys(written.mcpServers).sort()).toEqual([
      'silverhand_profile__fs',
      'silverhand_profile__remote',
    ]);
    expect(written.mcpServers.silverhand_profile__fs.command).toBe('npx');
  });

  it('codex: emits one -c mcp_servers.<prefixed> override per server', async () => {
    writeFileSync(
      join(homeDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', args: ['-y', 'server-fs'] },
          remote: { type: 'http', url: 'https://example.com/mcp' },
        },
      }),
    );
    const { logger } = captureLogger();
    const r = await buildProfileMcpSpawnArgs({
      runtimeKind: 'codex',
      agentHomeDir: homeDir,
      spawnDir,
      agentId: AGENT_ID,
      logger,
    });
    // Two servers → two `-c <override>` pairs.
    const flags = r.args.filter(a => a === '-c');
    expect(flags).toHaveLength(2);
    expect(r.args).toHaveLength(4);
    const overrides = r.args.filter(a => a !== '-c');
    for (const o of overrides) {
      expect(o.startsWith('mcp_servers.silverhand_profile__')).toBe(true);
    }
  });

  it('bad JSON: drops the WHOLE layer, logs loud, still returns [] (agent spawns)', async () => {
    writeFileSync(join(homeDir, 'mcp.json'), '{ this is not json');
    const { logger, warns } = captureLogger();
    const r = await buildProfileMcpSpawnArgs({
      runtimeKind: 'claude',
      agentHomeDir: homeDir,
      spawnDir,
      agentId: AGENT_ID,
      logger,
    });
    expect(r.args).toEqual([]);
    expect(warns.length).toBeGreaterThan(0); // loud
  });

  it('unknown runtime: loud, returns [] (no silent ignore)', async () => {
    writeFileSync(
      join(homeDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { fs: { command: 'x' } } }),
    );
    const { logger, warns } = captureLogger();
    const r = await buildProfileMcpSpawnArgs({
      runtimeKind: 'cursor',
      agentHomeDir: homeDir,
      spawnDir,
      agentId: AGENT_ID,
      logger,
    });
    expect(r.args).toEqual([]);
    expect(warns.length).toBeGreaterThan(0);
  });

  it('hard read error (unreadable file): loud, returns []', async () => {
    if (process.getuid?.() === 0) return; // root bypasses perms
    const filePath = join(homeDir, 'mcp.json');
    writeFileSync(filePath, JSON.stringify({ mcpServers: {} }));
    chmodSync(filePath, 0o000);
    try {
      const { logger, warns } = captureLogger();
      const r = await buildProfileMcpSpawnArgs({
        runtimeKind: 'claude',
        agentHomeDir: homeDir,
        spawnDir,
        agentId: AGENT_ID,
        logger,
      });
      expect(r.args).toEqual([]);
      expect(warns.length).toBeGreaterThan(0);
    } finally {
      chmodSync(filePath, 0o644);
    }
  });
});
