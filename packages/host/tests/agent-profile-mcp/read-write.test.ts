import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentProfileMcpError,
  readAgentProfileMcp,
  writeAgentProfileMcp,
} from '../../src/daemon/agent-profile-mcp/index.js';

/**
 * Daemon read/write handlers for `agent_profile_mcp_*` (#task:1135). These
 * are the host-local truth behind `silverhand profile mcp get|set`:
 *  - read: raw text on present, `null` on absent (absent ≠ error).
 *  - write: re-validate fail-loud (`invalid_config`), then ATOMIC replace
 *    (tmp + rename) writing the raw bytes VERBATIM; bytes_written reported.
 *  - hard fs error → `fs_unavailable`.
 * No fs path crosses the wire — the dir is resolved from `agent_id` (I1).
 */

const AGENT_ID = 'aid-profile-mcp';

let agentHomeRootDir = '';
function agentDir(): string {
  return join(agentHomeRootDir, AGENT_ID);
}

describe('agent-profile-mcp daemon handlers', () => {
  beforeEach(() => {
    agentHomeRootDir = mkdtempSync(join(tmpdir(), 'pmcp-agents-'));
  });
  afterEach(() => {
    try {
      rmSync(agentHomeRootDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('read returns raw: null when no mcp.json exists', async () => {
    const r = await readAgentProfileMcp({ agent_id: AGENT_ID }, { agentHomeRootDir });
    expect(r).toEqual({ ok: true, raw: null });
  });

  it('read returns the verbatim raw text when present', async () => {
    const dir = agentDir();
    mkdirSync(dir, { recursive: true });
    const raw = '{\n  "mcpServers": {\n    "fs": { "command": "npx" }\n  }\n}';
    writeFileSync(join(dir, 'mcp.json'), raw);
    const r = await readAgentProfileMcp({ agent_id: AGENT_ID }, { agentHomeRootDir });
    expect(r).toEqual({ ok: true, raw });
  });

  it('write persists raw verbatim (formatting preserved) and reports bytes', async () => {
    // Intentionally idiosyncratic whitespace — the file is the truth the
    // pane shows back, so we must NOT re-serialize.
    const raw = '{   "mcpServers":{"fs":{"command":"npx","args":["-y","目录"]}}   }';
    const r = await writeAgentProfileMcp({ agent_id: AGENT_ID, raw }, { agentHomeRootDir });
    expect(r.ok).toBe(true);
    expect(r.bytes_written).toBe(Buffer.byteLength(raw, 'utf-8'));
    const onDisk = readFileSync(join(agentDir(), 'mcp.json'), 'utf-8');
    expect(onDisk).toBe(raw);
    expect(readdirSync(agentDir())).toEqual(['mcp.json']);
  });

  it('write rejects invalid config with invalid_config and persists nothing', async () => {
    const result = writeAgentProfileMcp(
      { agent_id: AGENT_ID, raw: '{ not valid json' },
      { agentHomeRootDir },
    );
    await expect(result).rejects.toMatchObject({ code: 'invalid_config' });
    await expect(result).rejects.toBeInstanceOf(AgentProfileMcpError);
    // Nothing written.
    const r = await readAgentProfileMcp({ agent_id: AGENT_ID }, { agentHomeRootDir });
    expect(r.raw).toBeNull();
  });

  it('write rejects an unknown server field (strict schema)', async () => {
    await expect(
      writeAgentProfileMcp(
        {
          agent_id: AGENT_ID,
          raw: JSON.stringify({
            mcpServers: { fs: { command: 'npx', bogus: true } },
          }),
        },
        { agentHomeRootDir },
      ),
    ).rejects.toMatchObject({ code: 'invalid_config' });
  });

  it('replaces an existing config with the new bytes', async () => {
    await writeAgentProfileMcp(
      { agent_id: AGENT_ID, raw: '{"mcpServers":{"a":{"command":"x"}}}' },
      { agentHomeRootDir },
    );
    await writeAgentProfileMcp(
      { agent_id: AGENT_ID, raw: '{"mcpServers":{"b":{"command":"y"}}}' },
      { agentHomeRootDir },
    );
    const onDisk = readFileSync(join(agentDir(), 'mcp.json'), 'utf-8');
    expect(onDisk).toBe('{"mcpServers":{"b":{"command":"y"}}}');
  });

  it.skipIf(process.getuid?.() === 0)(
    'read surfaces a hard fs error as fs_unavailable',
    async () => {
      const dir = agentDir();
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, 'mcp.json');
      writeFileSync(filePath, '{"mcpServers":{}}');
      chmodSync(filePath, 0o000);
      try {
        await expect(
          readAgentProfileMcp({ agent_id: AGENT_ID }, { agentHomeRootDir }),
        ).rejects.toMatchObject({ code: 'fs_unavailable' });
      } finally {
        chmodSync(filePath, 0o644);
      }
    },
  );
});
