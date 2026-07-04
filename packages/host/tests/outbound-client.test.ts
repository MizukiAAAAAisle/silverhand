import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { apiPaths, DAEMON_HOST_CONFIG_FILENAME } from '@silverhand/shared';
import {
  KNOWN_CAPABILITIES_V1,
  type EventFrame,
} from '../src/protocol.js';
import {
  OUTBOUND_PROTOCOL_VERSION,
  encodeOutboundFrame,
} from '../src/outbound-protocol.js';
import {
  OutboundDaemonClient,
  hostConnectWebSocketUrl,
  type OutboundDaemonClientOptions,
} from '../src/daemon/outbound-client.js';
import {
  createDaemonLogControl,
  type DaemonLogger,
} from '../src/daemon/logger.js';

const cleanup: Array<() => Promise<void> | void> = [];

describe('outbound daemon websocket client', () => {
  afterEach(async () => {
    while (cleanup.length) {
      const fn = cleanup.pop();
      try {
        await fn?.();
      } catch {
        // best effort
      }
    }
  });

  it('converts host config server URLs to the websocket endpoint', () => {
    expect(hostConnectWebSocketUrl('http://127.0.0.1:1234')).toBe(
      'ws://127.0.0.1:1234/api/hosts/connect',
    );
    // D4.a Commit 2 origin-only invariant (§7.1) — the classifier
    // rejects URLs with non-trivial path / query / fragment, so the
    // daemon-side `hostConnectWebSocketUrl` only sees origin-shaped
    // inputs in production. Pin the loopback-https → wss conversion
    // with the canonical origin form (was previously
    // `https://localhost:1234/base`, but Commit 2 tightened the
    // classifier so subpath inputs no longer reach this helper).
    expect(hostConnectWebSocketUrl('https://localhost:1234')).toBe(
      'wss://localhost:1234/api/hosts/connect',
    );
    expect(() => hostConnectWebSocketUrl('http://example.test')).toThrow(
      'tls_required_for_non_loopback_host_ws',
    );
    expect(
      hostConnectWebSocketUrl('http://example.test:8080', {
        allowInsecureRemote: true,
      }),
    ).toBe('ws://example.test:8080/api/hosts/connect');
    // Remote HTTPS is the production remote attach path.
    expect(hostConnectWebSocketUrl('https://example.test')).toBe(
      'wss://example.test/api/hosts/connect',
    );
    // Obfuscated IPv4 form that `new URL().hostname` would normalize
    // to `127.0.0.1` — must still be rejected because the raw
    // authority host is not in the literal allowlist.
    expect(() => hostConnectWebSocketUrl('http://0x7f000001:1234')).toThrow(
      'tls_required_for_non_loopback_host_ws',
    );
    // ws:// is not a valid backend server URL — rejected as
    // unsupported scheme (the http→ws transformation lives inside
    // this function, callers pass http/https).
    expect(() => hostConnectWebSocketUrl('ws://127.0.0.1:1234')).toThrow(
      /unsupported_server_url_protocol/,
    );
    // Userinfo refusal (Cindy `#task:631` D3.c P1 round 2):
    // hand-edited daemon-config with `user[:pass]@host` must also
    // be rejected here, otherwise the success-path `URL.toString()`
    // would propagate the userinfo into the wsUrl the daemon
    // connects to (where ws:// Basic-auth semantics could collide
    // with our Bearer header).
    expect(() => hostConnectWebSocketUrl('http://user@localhost:1234')).toThrow(
      /invalid_server_url:malformed_url/,
    );
    expect(() =>
      hostConnectWebSocketUrl('http://api.example.com@localhost:1234'),
    ).toThrow(/invalid_server_url:malformed_url/);
  });

  it('reconnects with backoff after server shutdown without replaying a queue', async () => {
    const server = await FakeOutboundServer.start();
    cleanup.push(() => server.close());
    const { client, logger } = startClient(server.url, {
      backoff: { minDelayMs: 80, maxDelayMs: 80, factor: 2, jitterRatio: 0 },
    });
    cleanup.push(() => client.stop('test_done'));

    const first = await server.waitForConnectionCount(1);
    expect(first.request.headers.authorization).toBe('Bearer host-token');
    setTimeout(() => first.ws.close(1001, 'server_shutdown'), 5);

    const firstClose = await server.waitForCloseCount(1);
    await waitFor(() => !client.state().connected);
    expect(client.sendEvent({
      event: 'runtime_state',
      conversation_id: 'c1',
      agent_id: 'a1',
      state: {
        runId: 'r1',
        agentId: 'a1',
        conversationId: 'c1',
        status: 'thinking',
        startedAt: 1700000000000,
        updatedAt: 1700000000001,
        lastActivityAt: 1700000000001,
      },
      ts: 1700000000999,
    })).toBe('failed');
    const second = await server.waitForConnectionCount(2);
    expect(second.openedAt - firstClose.closedAt).toBeGreaterThanOrEqual(50);
    await delay(20);
    expect(
      server.frames.some(({ frame }) => frame.kind === 'runtime_state'),
    ).toBe(false);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'info',
        action: 'reconnect_scheduled',
        reason: 'close_going_away',
      }),
    );
  });

  it('reconnects when the server closes 1000 while daemon is still running', async () => {
    const server = await FakeOutboundServer.start();
    cleanup.push(() => server.close());
    const { client, logger } = startClient(server.url, {
      backoff: { minDelayMs: 20, maxDelayMs: 20, factor: 2, jitterRatio: 0 },
    });
    cleanup.push(() => client.stop('test_done'));

    const first = await server.waitForConnectionCount(1);
    setTimeout(() => first.ws.close(1000, 'server_test'), 5);

    await server.waitForCloseCount(1);
    await server.waitForConnectionCount(2);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'info',
        action: 'reconnect_scheduled',
        reason: 'close_normal',
      }),
    );
  });

  it('closes and reconnects after daemon heartbeat timeout', async () => {
    const server = await FakeOutboundServer.start();
    cleanup.push(() => server.close());
    const { client, logger } = startClient(server.url, {
      heartbeat: { pingIntervalMs: 10, pongTimeoutMs: 10 },
      backoff: { minDelayMs: 10, maxDelayMs: 10, factor: 2, jitterRatio: 0 },
    });
    cleanup.push(() => client.stop('test_done'));

    await server.waitForConnectionCount(1);
    const close = await server.waitForCloseCount(1);
    expect(close).toMatchObject({
      code: 1008,
      reason: 'heartbeat_timeout',
    });
    await server.waitForConnectionCount(2);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        action: 'heartbeat_timeout',
        timeout_ms: 10,
      }),
    );
  });

  it('responds to server heartbeat pings with app-level pongs', async () => {
    const server = await FakeOutboundServer.start();
    cleanup.push(() => server.close());
    const { client } = startClient(server.url);
    cleanup.push(() => client.stop('test_done'));

    const first = await server.waitForConnectionCount(1);
    first.ws.send(encodeOutboundFrame({
      direction: 'server_to_daemon',
      type: 'heartbeat',
      kind: 'ping',
      ts: 1700000000000,
    }));

    await expect(
      server.waitForFrame(frame =>
        frame.type === 'heartbeat' && frame.kind === 'pong',
      ),
    ).resolves.toMatchObject({
      direction: 'daemon_to_server',
      type: 'heartbeat',
      kind: 'pong',
      echo_ts: 1700000000000,
    });
  });

  it('dispatches server command frames and returns correlated responses', async () => {
    const server = await FakeOutboundServer.start();
    cleanup.push(() => server.close());
    const { client } = startClient(server.url, {
      dispatchCommand: async command => ({
        id: command.id,
        result: { runtimes: [] },
      }),
    });
    cleanup.push(() => client.stop('test_done'));

    const first = await server.waitForConnectionCount(1);
    first.ws.send(encodeOutboundFrame({
      direction: 'server_to_daemon',
      type: 'command',
      id: 'cmd-1',
      kind: 'runtime_status',
      params: {},
    }));

    await expect(
      server.waitForFrame(frame =>
        frame.type === 'command_response' && frame.id === 'cmd-1',
      ),
    ).resolves.toMatchObject({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-1',
      kind: 'runtime_status',
      result: { runtimes: [] },
    });
  });

  it('handles rotate_token by refreshing config, memory token, and next reconnect auth', async () => {
    const server = await FakeOutboundServer.start();
    cleanup.push(() => server.close());
    const now = 1_700_000_000_000;
    const { client, logger, dir } = startClient(server.url, {
      now: () => now,
      backoff: { minDelayMs: 10, maxDelayMs: 10, factor: 2, jitterRatio: 0 },
    });
    cleanup.push(() => client.stop('test_done'));

    const first = await server.waitForConnectionCount(1);
    expect(first.request.headers.authorization).toBe('Bearer host-token');
    first.ws.send(encodeOutboundFrame({
      direction: 'server_to_daemon',
      type: 'command',
      id: 'rotate-1',
      kind: 'rotate_token',
      params: {
        host_id: 'host-1',
        host_token: 'new-host-token',
        issued_at: now,
        grace_until: now + 60_000,
      },
    }));

    await expect(
      server.waitForFrame(frame =>
        frame.type === 'command_response' && frame.id === 'rotate-1',
      ),
    ).resolves.toMatchObject({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'rotate-1',
      kind: 'rotate_token',
      result: {
        rotated: true,
        host_id: 'host-1',
        config_refreshed_at: now,
      },
    });
    expect(readConfig(dir)).toMatchObject({
      server_url: server.url,
      host_id: 'host-1',
      host_token: 'new-host-token',
    });
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'info',
        action: 'rotate_token_refreshed',
        host_id: 'host-1',
      }),
    );

    first.ws.close(1001, 'force_reconnect');
    const second = await server.waitForConnectionCount(2);
    expect(second.request.headers.authorization).toBe('Bearer new-host-token');
  });

  it('nacks rotate_token write failure without switching reconnect token', async () => {
    const server = await FakeOutboundServer.start();
    cleanup.push(() => server.close());
    const { client, dir } = startClient(server.url, {
      writeHostConfig: () => {
        throw new Error('EACCES');
      },
      backoff: { minDelayMs: 10, maxDelayMs: 10, factor: 2, jitterRatio: 0 },
    });
    cleanup.push(() => client.stop('test_done'));

    const first = await server.waitForConnectionCount(1);
    first.ws.send(encodeOutboundFrame({
      direction: 'server_to_daemon',
      type: 'command',
      id: 'rotate-fail',
      kind: 'rotate_token',
      params: {
        host_id: 'host-1',
        host_token: 'new-host-token',
        issued_at: 1_700_000_000_000,
        grace_until: 1_700_000_060_000,
      },
    }));

    await expect(
      server.waitForFrame(frame =>
        frame.type === 'command_response' && frame.id === 'rotate-fail',
      ),
    ).resolves.toMatchObject({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'rotate-fail',
      kind: 'rotate_token',
      result: {
        rotated: false,
        reason: 'write_failed',
        message: 'EACCES',
      },
    });
    expect(readConfig(dir)).toMatchObject({
      host_token: 'host-token',
    });

    first.ws.close(1001, 'force_reconnect');
    const second = await server.waitForConnectionCount(2);
    expect(second.request.headers.authorization).toBe('Bearer host-token');
  });

  it('drops runtime_output on bounded-buffer pressure without closing', async () => {
    const server = await FakeOutboundServer.start();
    cleanup.push(() => server.close());
    const { client, logger } = startClient(server.url, {
      buffer: { maxFrames: 1024, maxBytes: 2_048 },
    });
    cleanup.push(() => client.stop('test_done'));

    const first = await server.waitForConnectionCount(1);
    await server.waitForFrame(frame => frame.type === 'event' && frame.kind === 'ready');

    const result = client.sendEvent({
      event: 'runtime_output',
      conversation_id: 'c1',
      agent_id: 'a1',
      stream: 'stdout',
      chunk: 'x'.repeat(4_096),
      ts: 1700000000001,
    });

    expect(result).toBe('dropped');
    await delay(25);
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
    expect(server.frames.some(({ frame }) => frame.kind === 'runtime_output')).toBe(false);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        action: 'runtime_output_dropped',
        event_kind: 'runtime_output',
        conversation_id: 'c1',
        agent_id: 'a1',
        ts: 1700000000001,
      }),
    );
  });

  it('fails loud on non-droppable bounded-buffer overflow with event metadata', async () => {
    const server = await FakeOutboundServer.start();
    cleanup.push(() => server.close());
    const { client, logger } = startClient(server.url, {
      buffer: { maxFrames: 1024, maxBytes: 2_048 },
      backoff: { minDelayMs: 1_000, maxDelayMs: 1_000, factor: 2, jitterRatio: 0 },
    });
    cleanup.push(() => client.stop('test_done'));

    await server.waitForConnectionCount(1);
    await server.waitForFrame(frame => frame.type === 'event' && frame.kind === 'ready');

    const result = client.sendEvent({
      event: 'runtime_state',
      conversation_id: 'c1',
      agent_id: 'a1',
      state: {
        runId: 'r1',
        agentId: 'a1',
        conversationId: 'c1',
        status: 'thinking',
        startedAt: 1700000000000,
        updatedAt: 1700000000001,
        lastActivityAt: 1700000000001,
        detail: 'x'.repeat(4_096),
      },
      ts: 1700000000002,
    });

    expect(result).toBe('overflow');
    await expect(server.waitForCloseCount(1)).resolves.toMatchObject({
      code: 1013,
      reason: 'outbound_buffer_overflow',
    });
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        action: 'buffer_overflow_close',
        event_kind: 'runtime_state',
        conversation_id: 'c1',
        agent_id: 'a1',
        ts: 1700000000002,
      }),
    );
  });

  it('does not reconnect after daemon-initiated shutdown', async () => {
    const server = await FakeOutboundServer.start();
    cleanup.push(() => server.close());
    const { client } = startClient(server.url, {
      backoff: { minDelayMs: 10, maxDelayMs: 10, factor: 2, jitterRatio: 0 },
    });

    await server.waitForConnectionCount(1);
    client.stop('test_shutdown');
    await server.waitForCloseCount(1);
    await delay(40);

    expect(server.connections).toHaveLength(1);
  });
});

function startClient(
  serverUrl: string,
  overrides: Partial<OutboundDaemonClientOptions> = {},
): { client: OutboundDaemonClient; logger: CapturingDaemonLogger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'silverhand-outbound-client-'));
  const configPath = join(dir, DAEMON_HOST_CONFIG_FILENAME);
  writeFileSync(
    configPath,
    JSON.stringify({
      server_url: serverUrl,
      host_id: 'host-1',
      host_token: 'host-token',
    }),
  );
  const logger = new CapturingDaemonLogger();
  const client = new OutboundDaemonClient({
    configPath,
    logger,
    readyEvent: testReadyEvent,
    configPollMs: 0,
    heartbeat: { pingIntervalMs: 0, pongTimeoutMs: 50 },
    backoff: { minDelayMs: 10, maxDelayMs: 10, factor: 2, jitterRatio: 0 },
    buffer: { maxFrames: 1024, maxBytes: 4 * 1024 * 1024 },
    ...overrides,
  });
  client.start();
  cleanup.push(() => {
    client.stop('test_cleanup');
    rmSync(dir, { recursive: true, force: true });
  });
  return { client, logger, dir };
}

function testReadyEvent(): Extract<EventFrame, { event: 'ready' }> {
  return {
    event: 'ready',
    protocol_version: OUTBOUND_PROTOCOL_VERSION,
    daemon_version: '0.0.0-test',
    daemon_id: 'local',
    instance_id: 'instance-1',
    host_descriptor: { name: 'local', kind: 'local' },
    capabilities: [...KNOWN_CAPABILITIES_V1],
    socket_path: '/tmp/silverhand-test.sock',
    daemon_pid: 123,
    started_at: 1700000000000,
  };
}

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dir, DAEMON_HOST_CONFIG_FILENAME), 'utf8'),
  ) as Record<string, unknown>;
}

class CapturingDaemonLogger implements DaemonLogger {
  readonly entries: Array<Record<string, unknown> & { level: string; msg?: string }> = [];
  readonly filePath = '/tmp/silverhand-outbound-client-test.log';
  readonly logControl = createDaemonLogControl('debug');

  debug(obj: unknown, msg?: string): void {
    this.push('debug', obj, msg);
  }

  info(obj: unknown, msg?: string): void {
    this.push('info', obj, msg);
  }

  warn(obj: unknown, msg?: string): void {
    this.push('warn', obj, msg);
  }

  error(obj: unknown, msg?: string): void {
    this.push('error', obj, msg);
  }

  async close(): Promise<void> {
    // no-op
  }

  private push(level: string, obj: unknown, msg?: string): void {
    const fields =
      obj && typeof obj === 'object' && !(obj instanceof Error)
        ? (obj as Record<string, unknown>)
        : { data: obj };
    this.entries.push({ level, msg, ...fields });
  }
}

interface FakeConnection {
  ws: WebSocket;
  request: IncomingMessage;
  openedAt: number;
}

interface FakeClose {
  code: number;
  reason: string;
  closedAt: number;
}

class FakeOutboundServer {
  readonly connections: FakeConnection[] = [];
  readonly closes: FakeClose[] = [];
  readonly frames: Array<{ ws: WebSocket; frame: Record<string, unknown> }> = [];

  private constructor(
    readonly url: string,
    private readonly httpServer: HttpServer,
    private readonly wss: WebSocketServer,
  ) {}

  static async start(): Promise<FakeOutboundServer> {
    const httpServer = createServer();
    const wss = new WebSocketServer({
      server: httpServer,
      path: apiPaths.hostConnect,
    });
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const server = new FakeOutboundServer(
      `http://127.0.0.1:${port}`,
      httpServer,
      wss,
    );
    wss.on('connection', (ws, request) => {
      server.connections.push({ ws, request, openedAt: Date.now() });
      ws.on('message', data => {
        const frame = parseFrame(data);
        if (frame) server.frames.push({ ws, frame });
      });
      ws.on('close', (code, reason) => {
        server.closes.push({
          code,
          reason: reason.toString(),
          closedAt: Date.now(),
        });
      });
    });
    return server;
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      if (connection.ws.readyState !== WebSocket.CLOSED) {
        connection.ws.terminate();
      }
    }
    await new Promise<void>(resolve => this.wss.close(() => resolve()));
    await new Promise<void>(resolve => this.httpServer.close(() => resolve()));
  }

  async waitForConnectionCount(count: number): Promise<FakeConnection> {
    await waitFor(() => this.connections.length >= count);
    return this.connections[count - 1]!;
  }

  async waitForCloseCount(count: number): Promise<FakeClose> {
    await waitFor(() => this.closes.length >= count);
    return this.closes[count - 1]!;
  }

  async waitForFrame(
    match: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    await waitFor(() => this.frames.some(({ frame }) => match(frame)));
    return this.frames.find(({ frame }) => match(frame))!.frame;
  }
}

function parseFrame(data: RawData): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawDataToString(data)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('timed out waiting for condition');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
