import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { probeMcpServer } from '../../src/daemon/mcp-probe/index.js';

/**
 * Daemon handler for `mcp_probe` (#task:1137) — the live MCP diagnostic behind
 * `silverhand profile mcp probe` / the agent-pane Test connection · List tools.
 * Covered: the pure pre-connection phases (parse / not_found) against a real L1
 * `mcp.json`, the connect→initialize→tools walk against an in-memory MCP server
 * via the `buildTransport` seam, and that secrets never leak into a failure
 * message.
 */

const AGENT_ID = 'aid-mcp-probe';

let homeDir = '';
function writeConfig(raw: string): void {
  const dir = join(homeDir, '.silverhand', 'agents', AGENT_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mcp.json'), raw);
}

const source = { kind: 'profile', agent_id: AGENT_ID } as const;

describe('mcp_probe daemon handler', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'probe-home-'));
  });
  afterEach(() => {
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('not_found when the agent has no mcp.json', async () => {
    const r = await probeMcpServer(
      { source, server_name: 'whatever' },
      { homeDir },
    );
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('not_found');
  });

  it('parse when the config is invalid JSON', async () => {
    writeConfig('{ not json');
    const r = await probeMcpServer({ source, server_name: 'x' }, { homeDir });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('parse');
  });

  it('not_found when the named server is absent from the config', async () => {
    writeConfig('{"mcpServers":{"other":{"command":"npx"}}}');
    const r = await probeMcpServer(
      { source, server_name: 'missing' },
      { homeDir },
    );
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('not_found');
  });

  it('connects + initializes a live server (phase=initialize, server_info)', async () => {
    writeConfig('{"mcpServers":{"live":{"command":"unused"}}}');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'test-server', version: '9.9.9' });
    await server.connect(serverSide);

    const r = await probeMcpServer(
      { source, server_name: 'live' },
      { homeDir, buildTransport: () => clientSide },
    );
    expect(r.ok).toBe(true);
    expect(r.phase).toBe('initialize');
    expect(r.server_info).toEqual({ name: 'test-server', version: '9.9.9' });
    expect(r.tools).toBeUndefined();
    await server.close();
  });

  it('lists tools when include_tools is set (phase=tools)', async () => {
    writeConfig('{"mcpServers":{"live":{"command":"unused"}}}');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'test-server', version: '1' });
    server.registerTool(
      'ping',
      { description: 'ping tool' },
      async () => ({ content: [{ type: 'text', text: 'pong' }] }),
    );
    await server.connect(serverSide);

    const r = await probeMcpServer(
      { source, server_name: 'live', include_tools: true },
      { homeDir, buildTransport: () => clientSide },
    );
    expect(r.ok).toBe(true);
    expect(r.phase).toBe('tools');
    expect(r.tools).toEqual([{ name: 'ping', description: 'ping tool' }]);
    await server.close();
  });

  it('redacts URL query strings + bearer tokens from a connect failure', async () => {
    writeConfig('{"mcpServers":{"remote":{"type":"http","url":"https://x.test/mcp"}}}');
    const throwing = {
      async start() {
        throw new Error(
          'fetch failed connecting to https://evil.test/mcp?token=secret123 Bearer abc.def.ghi',
        );
      },
      async send() {},
      async close() {},
    } as unknown as Transport;

    const r = await probeMcpServer(
      { source, server_name: 'remote' },
      { homeDir, buildTransport: () => throwing },
    );
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('connect');
    expect(r.message).toBeDefined();
    expect(r.message).not.toContain('secret123');
    expect(r.message).not.toContain('abc.def.ghi');
    // The non-secret prefix of the URL survives so the diagnostic is useful.
    expect(r.message).toContain('https://evil.test/mcp');
  });
});
