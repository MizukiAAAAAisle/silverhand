import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type IncomingHttpHeaders, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { probeMcpServer } from '../../src/daemon/mcp-probe/index.js';

const AGENT_ID = 'aid-mcp-probe';
const source = { kind: 'profile', agent_id: AGENT_ID } as const;
let agentHomeRootDir = '';
const cleanup: Array<() => Promise<void>> = [];

function writeConfig(raw: string): void {
  const dir = join(agentHomeRootDir, AGENT_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mcp.json'), raw);
}

async function listen(handler: RequestListener): Promise<string> {
  const http = createServer(handler);
  cleanup.push(async () => {
    const closed = new Promise<void>((resolve, reject) =>
      http.close((err) => (err ? reject(err) : resolve())),
    );
    http.closeAllConnections();
    await closed;
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing local port');
  return `http://127.0.0.1:${address.port}`;
}

describe('mcp_probe daemon handler', () => {
  beforeEach(() => {
    const root = process.env.SILVERHAND_DIR;
    if (!root) throw new Error('This test requires isolated SILVERHAND_DIR');
    mkdirSync(root, { recursive: true });
    agentHomeRootDir = mkdtempSync(join(root, 'probe-agents-'));
  });
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    rmSync(agentHomeRootDir, { recursive: true, force: true });
  });

  it('not_found when the agent has no mcp.json', async () => {
    const r = await probeMcpServer({ source, server_name: 'whatever' }, { agentHomeRootDir });
    expect(r).toMatchObject({ ok: false, phase: 'not_found' });
  });

  it('parse when the config is invalid JSON', async () => {
    writeConfig('{ not json');
    const r = await probeMcpServer({ source, server_name: 'x' }, { agentHomeRootDir });
    expect(r).toMatchObject({ ok: false, phase: 'parse' });
  });

  it('not_found when the named server is absent from the config', async () => {
    writeConfig('{"mcpServers":{"other":{"command":"npx"}}}');
    const r = await probeMcpServer({ source, server_name: 'missing' }, { agentHomeRootDir });
    expect(r).toMatchObject({ ok: false, phase: 'not_found' });
  });

  it.each([false, true])(
    'initializes a real SSE server with protocol/user headers; include_tools=%s',
    async (includeTools) => {
      const server = new McpServer({ name: 'test-server', version: '9.9.9' });
      server.registerTool('ping', { description: 'ping tool' }, async () => ({
        content: [{ type: 'text', text: 'pong' }],
      }));
      let transport: SSEServerTransport | undefined;
      const gets: IncomingHttpHeaders[] = [];
      const posts: IncomingHttpHeaders[] = [];
      const errors: unknown[] = [];
      let peerClosed = false;
      const url = await listen((req, res) => {
        if (req.method === 'GET') {
          gets.push(req.headers);
          res.on('close', () => {
            peerClosed = true;
          });
          transport = new SSEServerTransport('/messages', res);
          void server.connect(transport).catch((err) => {
            errors.push(err);
            res.destroy();
          });
        } else if (req.method === 'POST' && transport) {
          posts.push(req.headers);
          void transport.handlePostMessage(req, res).catch((err) => {
            errors.push(err);
            res.destroy();
          });
        } else {
          res.writeHead(404).end();
        }
      });
      cleanup.push(() => server.close());
      writeConfig(
        JSON.stringify({
          mcpServers: {
            live: {
              type: 'sse',
              url,
              headers: { Authorization: 'Bearer fixture-token', 'X-Tenant': 'acme' },
            },
          },
        }),
      );
      const r = await probeMcpServer(
        { source, server_name: 'live', include_tools: includeTools },
        { agentHomeRootDir },
      );
      expect(r).toMatchObject({
        ok: true,
        phase: includeTools ? 'tools' : 'initialize',
        server_info: { name: 'test-server', version: '9.9.9' },
      });
      expect(r.tools).toEqual(
        includeTools ? [{ name: 'ping', description: 'ping tool' }] : undefined,
      );
      expect(gets).toHaveLength(1);
      expect(gets[0]).toMatchObject({
        accept: 'text/event-stream',
        authorization: 'Bearer fixture-token',
        'x-tenant': 'acme',
      });
      expect(posts.length).toBeGreaterThan(0);
      for (const headers of posts)
        expect(headers).toMatchObject({
          'content-type': 'application/json',
          authorization: 'Bearer fixture-token',
          'x-tenant': 'acme',
        });
      expect(errors).toEqual([]);
      await expect.poll(() => peerClosed).toBe(true);
    },
  );

  it('redacts URL query strings and bearer tokens from a real HTTP failure', async () => {
    const url = await listen((_req, res) => {
      res
        .writeHead(503)
        .end('fetch failed connecting to https://evil.test/mcp?token=secret123 Bearer abc.def.ghi');
    });
    writeConfig(JSON.stringify({ mcpServers: { remote: { type: 'http', url } } }));
    const r = await probeMcpServer({ source, server_name: 'remote' }, { agentHomeRootDir });
    expect(r).toMatchObject({ ok: false, phase: 'connect' });
    expect(r.message).toContain('https://evil.test/mcp');
    expect(r.message).not.toContain('secret123');
    expect(r.message).not.toContain('abc.def.ghi');
  });
});
