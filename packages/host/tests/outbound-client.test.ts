import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(hostConnectWebSocketUrl('https://example.test/base')).toBe(
      'wss://example.test/api/hosts/connect',
    );
    expect(() => hostConnectWebSocketUrl('http://example.test')).toThrow(
      'tls_required_for_non_loopback_host_ws',
    );
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
