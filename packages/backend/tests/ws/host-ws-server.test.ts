import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import {
  KNOWN_CAPABILITIES_V1,
  OUTBOUND_PROTOCOL_VERSION,
  encodeOutboundFrame,
  type OutboundServerCommandKind,
} from '@silverhand/host';
import { apiPaths } from '@silverhand/shared';
import { HostTokenService } from '../../src/auth/host-token.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import {
  HOST_WS_PATH,
  HostWsCommandTransportError,
  installHostWebSocketServer,
  type HostWsServerController,
  type HostWsServerOptions,
} from '../../src/ws/host-ws-server.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

interface TestHostWsServer {
  url: string;
  controller: HostWsServerController;
  close(): Promise<void>;
}

describe('host outbound WebSocket server', () => {
  let t: TestApp | null = null;
  let server: TestHostWsServer | null = null;
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
    sockets = [];
    await server?.close();
    server = null;
    t?.cleanup();
    t = null;
  });

  it('exposes a non-upgrade route that does not accept user-session auth', async () => {
    t = buildTestApp();

    const res = await http(t).get(apiPaths.hostConnect);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'host websocket requires a websocket upgrade',
    });
  });

  it('accepts a valid long-lived local host token on upgrade', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local');
    expect(host).not.toBeNull();
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host!.id,
    });

    const before = new HostRepo(t.ctx.db).get(host!.id)!.last_seen_at;
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    expect(server.controller.activeConnectionCount()).toBe(1);
    const after = new HostRepo(t.ctx.db).get(host!.id)!.last_seen_at;
    expect(after).not.toBeNull();
    expect(after!).toBeGreaterThanOrEqual(before ?? 0);
  });

  it('rejects missing, unknown, and revoked host tokens before upgrade', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    new HostTokenService(t.ctx.db).revokeCredential(issued.credential.id);

    await expect(connectHost(server.url, null)).rejects.toThrow(
      /unexpected response 401/,
    );
    await expect(connectHost(server.url, 'not-a-token')).rejects.toThrow(
      /unexpected response 401/,
    );
    await expect(connectHost(server.url, issued.hostToken)).rejects.toThrow(
      /unexpected response 401/,
    );
  });

  it('rejects user-session bearer tokens before upgrade', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const userSessionToken = t.ctx.authSessions.issueSession({
      userId: 'local',
    }).userToken;

    await expect(connectHost(server.url, userSessionToken)).rejects.toThrow(
      /unexpected response 401/,
    );
  });

  it('rejects non-local hosts even with a valid host token', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const remote = new HostRepo(t.ctx.db).create('future-remote', 'remote', {
      userId: 'local',
      installationId: 'remote-install',
    });
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: remote.id,
    });

    await expect(connectHost(server.url, issued.hostToken)).rejects.toThrow(
      /unexpected response 403/,
    );
  });

  it('gates daemon-to-server frame shape after authentication', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    ws.send(JSON.stringify({
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'ready',
      protocol_version: OUTBOUND_PROTOCOL_VERSION,
      daemon_version: '0.0.0-test',
      daemon_id: 'local',
      instance_id: 'instance-1',
      host_descriptor: { name: 'local', kind: 'local' },
      capabilities: [...KNOWN_CAPABILITIES_V1],
      daemon_pid: 123,
      started_at: 1700000000000,
    }));

    await expect(noCloseWithin(ws, 25)).resolves.toBeUndefined();

    ws.send(JSON.stringify({
      direction: 'server_to_daemon',
      type: 'event',
      kind: 'runtime_state',
    }));

    const closed = await waitForClose(ws);
    expect(closed.code).toBe(1002);
  });

  it('forwards authenticated daemon event frames to the configured fanout sink once', async () => {
    t = buildTestApp();
    const events: Array<{ hostId: string; kind: string; connectionId: string }> = [];
    server = await openServer(t, {
      eventSink: {
        onEvent: (hostId, event, connectionId) =>
          events.push({ hostId, kind: event.kind, connectionId }),
      },
    });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    ws.send(JSON.stringify({
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'ready',
      protocol_version: OUTBOUND_PROTOCOL_VERSION,
      daemon_version: '0.0.0-test',
      daemon_id: 'local',
      instance_id: 'instance-1',
      host_descriptor: { name: 'local', kind: 'local' },
      capabilities: [...KNOWN_CAPABILITIES_V1],
      daemon_pid: 123,
      started_at: 1700000000000,
    }));

    await waitFor(() => events.length === 1);
    expect(events).toEqual([
      {
        hostId: host.id,
        kind: 'ready',
        connectionId: server.controller.connectionIdForHost(host.id),
      },
    ]);
  });

  it('logs info-not-warn once when embedded mode receives outbound daemon events without a fanout sink', async () => {
    t = buildTestApp();
    const warnings: Array<{ meta: Record<string, unknown>; msg: string }> = [];
    const infos: Array<{ meta: Record<string, unknown>; msg: string }> = [];
    t.ctx.logger = {
      info: (meta, msg) =>
        infos.push({
          meta: meta as Record<string, unknown>,
          msg: String(msg),
        }),
      warn: (meta, msg) =>
        warnings.push({
          meta: meta as Record<string, unknown>,
          msg: String(msg),
        }),
      error() {},
    };
    server = await openServer(t, { pingIntervalMs: 0 });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    ws.send(JSON.stringify({
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'ready',
      protocol_version: OUTBOUND_PROTOCOL_VERSION,
      daemon_version: '0.0.0-test',
      daemon_id: 'local',
      instance_id: 'instance-1',
      host_descriptor: { name: 'local', kind: 'local' },
      capabilities: [...KNOWN_CAPABILITIES_V1],
      daemon_pid: 123,
      started_at: 1700000000000,
    }));
    ws.send(JSON.stringify({
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'runtime_output_paused',
      conversation_id: 'c1',
      agent_id: 'a1',
    }));

    // Filter to the dropped-event log message specifically because
    // `info` also captures the `host-ws: connected` registration line.
    const droppedLogs = () =>
      infos.filter(line =>
        line.msg.startsWith('host-ws: outbound event ignored'),
      );
    await waitFor(() => droppedLogs().length === 1);
    expect(droppedLogs()[0]).toMatchObject({
      meta: {
        hostId: host.id,
        eventKind: 'ready',
        deploymentMode: 'embedded',
      },
      msg: 'host-ws: outbound event ignored (embedded: runtime events flow via IPC; WS reserved for control)',
    });
    expect(droppedLogs()).toHaveLength(1);
    // Embedded mode must NOT warn — that semantics is reserved for
    // standalone backends where a missing sink is a real config bug.
    expect(warnings).toEqual([]);
  });

  it('warns once when standalone mode receives outbound daemon events without a fanout sink', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    const warnings: Array<{ meta: Record<string, unknown>; msg: string }> = [];
    t.ctx.logger = {
      info() {},
      warn: (meta, msg) =>
        warnings.push({
          meta: meta as Record<string, unknown>,
          msg: String(msg),
        }),
      error() {},
    };
    server = await openServer(t, { pingIntervalMs: 0 });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    ws.send(JSON.stringify({
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'ready',
      protocol_version: OUTBOUND_PROTOCOL_VERSION,
      daemon_version: '0.0.0-test',
      daemon_id: 'local',
      instance_id: 'instance-1',
      host_descriptor: { name: 'local', kind: 'local' },
      capabilities: [...KNOWN_CAPABILITIES_V1],
      daemon_pid: 123,
      started_at: 1700000000000,
    }));
    ws.send(JSON.stringify({
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'runtime_output_paused',
      conversation_id: 'c1',
      agent_id: 'a1',
    }));

    await waitFor(() => warnings.length === 1);
    expect(warnings[0]).toMatchObject({
      meta: {
        hostId: host.id,
        eventKind: 'ready',
        deploymentMode: 'standalone',
      },
      msg: 'host-ws: outbound daemon event received without fanout sink; backend is misconfigured',
    });
    expect(warnings).toHaveLength(1);
  });

  // ── Attachment registry (D3.a Commit 1) ──────────────────────────
  // The controller exposes `getAttachment(hostId)` so D3.a phase-2
  // boot can wait for daemon outbound WS attached without relying on
  // `eventSink.onEvent('ready', ...)`. Embedded backend has no event
  // sink wired, so this registry must update from the connection
  // lifecycle alone.

  it('exposes a non-null attachment snapshot for connected hosts (no eventSink wired)', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });

    const t0 = Date.now();
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);
    // Allow upgrade tick to register the connection in the controller.
    await waitFor(() => server!.controller.getAttachment(host.id) !== null);
    const t1 = Date.now();

    const attachment = server.controller.getAttachment(host.id);
    expect(attachment).not.toBeNull();
    expect(attachment!.hostId).toBe(host.id);
    expect(attachment!.connectionId).toBe(
      server.controller.connectionIdForHost(host.id),
    );
    expect(attachment!.attachedAt).toBeGreaterThanOrEqual(t0);
    expect(attachment!.attachedAt).toBeLessThanOrEqual(t1);
  });

  it('clears the attachment snapshot when the connection closes', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);
    await waitFor(() => server!.controller.getAttachment(host.id) !== null);

    const closed = waitForClose(ws);
    ws.close(1000, 'test_done');
    await closed;

    await waitFor(() => server!.controller.getAttachment(host.id) === null);
    expect(server.controller.getAttachment(host.id)).toBeNull();
  });

  it('replacement-safe: stale close from the replaced connection does not wipe the fresh attachment', async () => {
    // Regression contract: when conn B replaces conn A for the same
    // host, A's deferred `close` handler must compare its captured
    // `connectionId` against the registry and skip the delete when
    // the slot has moved on to B. Without this, the replaced
    // connection's cleanup could erase the live attachment record
    // moments after it was created.
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });

    const first = await connectHost(server.url, issued.hostToken);
    sockets.push(first);
    await waitFor(() => server!.controller.getAttachment(host.id) !== null);
    const firstAttachment = server.controller.getAttachment(host.id)!;

    const firstClosed = waitForClose(first);
    const second = await connectHost(server.url, issued.hostToken);
    sockets.push(second);
    // The replacement-safe assertion: by the time the second connection
    // is open the controller's snapshot must already point at the new
    // connection id (not null, not the old id).
    await waitFor(() => {
      const cur = server!.controller.getAttachment(host.id);
      return cur !== null && cur.connectionId !== firstAttachment.connectionId;
    });
    const secondAttachment = server.controller.getAttachment(host.id)!;
    expect(secondAttachment.connectionId).not.toBe(firstAttachment.connectionId);

    // Wait for the displaced first connection to finish closing so its
    // deferred `close` handler runs; if the handler isn't connectionId-
    // guarded, this is exactly when it would erase B's entry.
    await firstClosed;
    // Give the close listener a couple of ticks to actually execute.
    await new Promise(resolve => setTimeout(resolve, 10));

    const after = server.controller.getAttachment(host.id);
    expect(after).not.toBeNull();
    expect(after!.connectionId).toBe(secondAttachment.connectionId);
    expect(after!.attachedAt).toBe(secondAttachment.attachedAt);
  });

  it('returns null from getAttachment for hosts that never connected', async () => {
    t = buildTestApp();
    server = await openServer(t);
    expect(server.controller.getAttachment('never-connected-host')).toBeNull();
  });

  it('notifies the fanout sink of a replaced connection disconnect once', async () => {
    t = buildTestApp();
    const disconnects: string[] = [];
    server = await openServer(t, {
      eventSink: {
        onEvent: () => {},
        onDisconnect: hostId => disconnects.push(hostId),
      },
    });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const first = await connectHost(server.url, issued.hostToken);
    sockets.push(first);

    const firstClosed = waitForClose(first);
    const second = await connectHost(server.url, issued.hostToken);
    sockets.push(second);
    await expect(firstClosed).resolves.toMatchObject({
      code: 1000,
      reason: 'host_connection_replaced',
    });

    expect(disconnects).toEqual([host.id]);
  });

  // D4.c C2 — `disconnectHost` is the controller-level primitive
  // the host-revoke route uses to kick a daemon's outbound WS the
  // moment its credential is revoked. Three behaviors to pin:
  //   1. With a live attachment: returns true, socket sees close
  //      code 1008 + reason `host_revoked`, attachment registry
  //      clears on the same tick the close listener fires.
  //   2. With no attachment: returns false (idempotent — route
  //      can call this without checking attachment state first).
  //   3. After replacement: only the current connection is
  //      affected (registry replacement-safe).
  it('disconnectHost kicks the live attachment with code 1008 / host_revoked (D4.c C2)', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });

    // No attachment yet → idempotent false.
    expect(server.controller.disconnectHost(host.id)).toBe(false);

    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);
    expect(server.controller.activeConnectionCount()).toBe(1);
    expect(server.controller.getAttachment(host.id)).not.toBeNull();

    const closed = waitForClose(ws);
    expect(server.controller.disconnectHost(host.id)).toBe(true);

    await expect(closed).resolves.toMatchObject({
      code: 1008,
      reason: 'host_revoked',
    });
    // D4.c C9-1: server-side cleanup is asynchronous (the
    // controller's `'close'` listener clears
    // `connections` / `connectionsByHost` / `attachmentsByHost` on
    // the next event-loop tick). The client-side `closed` promise
    // resolves as soon as the close frame round-trips, which can
    // race ahead of the listener; the previous synchronous
    // `expect(activeConnectionCount === 0)` was the source of a
    // pre-existing flake on this test (Cindy `Acsun_kzRmpNmXZo`).
    // Wait on ALL three observable state fields simultaneously —
    // `activeConnectionCount` reads `connections.size`,
    // `getAttachment` reads `attachmentsByHost`, and
    // `connectionIdForHost` reads `connectionsByHost`; the three
    // maps are populated/cleared independently, so all three must
    // flip before the assertion holds. Bounded wait, no sleep.
    await waitFor(
      () =>
        server!.controller.activeConnectionCount() === 0 &&
        server!.controller.getAttachment(host.id) === null &&
        server!.controller.connectionIdForHost(host.id) === null,
    );

    // Idempotent on already-disconnected hosts.
    expect(server.controller.disconnectHost(host.id)).toBe(false);
    // And on hosts that never attached at all.
    expect(server.controller.disconnectHost('phantom-host')).toBe(false);
  });

  it('responds to app-level daemon heartbeat pings', async () => {
    t = buildTestApp();
    server = await openServer(t, { pingIntervalMs: 0 });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    ws.send(encodeOutboundFrame({
      direction: 'daemon_to_server',
      type: 'heartbeat',
      kind: 'ping',
      ts: 1700000000000,
    }));

    await expect(readJsonFrame(ws)).resolves.toMatchObject({
      direction: 'server_to_daemon',
      type: 'heartbeat',
      kind: 'pong',
      echo_ts: 1700000000000,
    });
  });

  it('closes when daemon misses a server heartbeat pong', async () => {
    t = buildTestApp();
    server = await openServer(t, { pingIntervalMs: 10, pongTimeoutMs: 10 });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    await expect(readJsonFrame(ws)).resolves.toMatchObject({
      direction: 'server_to_daemon',
      type: 'heartbeat',
      kind: 'ping',
    });

    const closed = await waitForClose(ws);
    expect(closed).toMatchObject({
      code: 1008,
      reason: 'heartbeat_timeout',
    });
  });

  it('round-trips every server command with correlated command_response frames', async () => {
    t = buildTestApp();
    server = await openServer(t, { pingIntervalMs: 0 });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);
    const cases = commandCases(host.id);
    const received: Array<{ id: string; kind: string }> = [];
    const results = [];

    for (const testCase of cases) {
      const pending = sendTestCommand(server.controller, host.id, testCase);
      const frame = await readJsonFrame(ws) as Record<string, unknown>;
      expect(frame.type).toBe('command');
      received.push({ id: String(frame.id), kind: String(frame.kind) });
      const match = cases.find(c => c.kind === frame.kind)!;
      ws.send(encodeOutboundFrame({
        direction: 'daemon_to_server',
        type: 'command_response',
        id: String(frame.id),
        kind: match.kind,
        result: match.result,
      } as never));
      results.push(await pending);
    }

    expect(received.map(c => c.kind)).toEqual(cases.map(c => c.kind));
    expect(results).toEqual(cases.map(c => c.result));
    for (const [index, command] of received.entries()) {
      expect(command.id).toMatch(new RegExp(`-${index + 1}$`));
    }
  });

  it('demuxes multiple in-flight command responses by id, not arrival order', async () => {
    t = buildTestApp();
    server = await openServer(t, { pingIntervalMs: 0 });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);
    const first = server.controller.sendCommand(
      host.id,
      'runtime_status',
      { conversation_id: 'c1', agent_id: 'a1' },
      { timeoutMs: 500 },
    );
    const firstFrame = await readJsonFrame(ws) as Record<string, unknown>;
    const second = server.controller.sendCommand(
      host.id,
      'runtime_status',
      { conversation_id: 'c1', agent_id: 'a2' },
      { timeoutMs: 500 },
    );
    const secondFrame = await readJsonFrame(ws) as Record<string, unknown>;
    ws.send(runtimeStatusResponse(String(secondFrame.id), 'a2'));
    ws.send(runtimeStatusResponse(String(firstFrame.id), 'a1'));

    await expect(first).resolves.toMatchObject({
      runtimes: [{ agent_id: 'a1' }],
    });
    await expect(second).resolves.toMatchObject({
      runtimes: [{ agent_id: 'a2' }],
    });
  });

  it('fails fast with transport_timeout when daemon does not respond', async () => {
    t = buildTestApp();
    server = await openServer(t, { pingIntervalMs: 0 });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    const pending = server.controller.sendCommand(
      host.id,
      'runtime_status',
      {},
      { timeoutMs: 10 },
    );
    await readJsonFrame(ws);

    await expect(pending).rejects.toMatchObject({
      code: 'transport_timeout',
    });
  });

  it('fails fast with transport_disconnected when socket closes mid-command', async () => {
    t = buildTestApp();
    server = await openServer(t, { pingIntervalMs: 0 });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);
    const pending = server.controller.sendCommand(
      host.id,
      'runtime_status',
      {},
      { timeoutMs: 500 },
    );
    await readJsonFrame(ws);
    ws.close(1001, 'test_disconnect');

    await expect(pending).rejects.toMatchObject({
      code: 'transport_disconnected',
    });
  });

  it('does not replay non-delivery commands after reconnect', async () => {
    t = buildTestApp();
    server = await openServer(t, { pingIntervalMs: 0 });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const first = await connectHost(server.url, issued.hostToken);
    sockets.push(first);
    const pending = server.controller.sendCommand(
      host.id,
      'runtime_status',
      {},
      { timeoutMs: 500 },
    );
    await readJsonFrame(first);
    first.close(1001, 'test_disconnect');

    await expect(pending).rejects.toMatchObject({
      code: 'transport_disconnected',
    });

    const second = await connectHost(server.url, issued.hostToken);
    sockets.push(second);
    await expect(noMessageWithin(second, 25)).resolves.toBeUndefined();
  });

  it('fails fast before wire send when no host connection exists', async () => {
    t = buildTestApp();
    server = await openServer(t, { pingIntervalMs: 0 });

    await expect(
      server.controller.sendCommand('missing-host', 'runtime_status', {}),
    ).rejects.toBeInstanceOf(HostWsCommandTransportError);
    await expect(
      server.controller.sendCommand('missing-host', 'runtime_status', {}),
    ).rejects.toMatchObject({
      code: 'transport_no_connection',
    });
  });

  it('fails fast with transport_invalid_command before writing invalid params', async () => {
    t = buildTestApp();
    server = await openServer(t, { pingIntervalMs: 0 });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    await expect(
      server.controller.sendCommand(
        host.id,
        'runtime_wake',
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          delivery_ids: [],
          kind: 'message',
          text: 'hello',
        } as never,
      ),
    ).rejects.toMatchObject({ code: 'transport_invalid_command' });
    await expect(noMessageWithin(ws, 25)).resolves.toBeUndefined();
  });

  it('fails fast with transport_response_mismatch and closes on wrong response kind', async () => {
    t = buildTestApp();
    server = await openServer(t, { pingIntervalMs: 0 });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);
    const pending = server.controller.sendCommand(
      host.id,
      'runtime_status',
      {},
      { timeoutMs: 500 },
    );
    const frame = await readJsonFrame(ws) as Record<string, unknown>;

    ws.send(encodeOutboundFrame({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: String(frame.id),
      kind: 'runtime_stop',
      result: { mode: 'hard', stopped: true, exit_code: 0 },
    }));

    await expect(pending).rejects.toMatchObject({
      code: 'transport_response_mismatch',
    });
    await expect(waitForClose(ws)).resolves.toMatchObject({
      code: 1002,
      reason: 'command_response_kind_mismatch',
    });
  });
});

async function openServer(
  t: TestApp,
  opts: HostWsServerOptions = {},
): Promise<TestHostWsServer> {
  const httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const controller = installHostWebSocketServer(httpServer, t.ctx, opts);
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  t.ctx.serverConfig = { ...t.ctx.serverConfig, url: `http://127.0.0.1:${port}` };
  return {
    url: `ws://127.0.0.1:${port}${HOST_WS_PATH}`,
    controller,
    close: async () => {
      await controller.close();
      await closeHttpServer(httpServer);
    },
  };
}

async function connectHost(url: string, token: string | null): Promise<WebSocket> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const ws = new WebSocket(url, { headers });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('unexpected-response', onUnexpectedResponse);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onUnexpectedResponse = (_req: unknown, res: { statusCode?: number }) => {
      cleanup();
      reject(new Error(`unexpected response ${res.statusCode ?? 'unknown'}`));
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('unexpected-response', onUnexpectedResponse);
  });
  return ws;
}

async function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  if (ws.readyState === WebSocket.CLOSED) return { code: 1000, reason: '' };
  return new Promise(resolve => {
    ws.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function readJsonFrame(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData) => {
      cleanup();
      try {
        resolve(JSON.parse(data.toString('utf8')) as unknown);
      } catch (err) {
        reject(err);
      }
    };
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`closed before message ${code}`));
    };
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };
    ws.once('message', onMessage);
    ws.once('close', onClose);
  });
}

async function noCloseWithin(ws: WebSocket, ms: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`closed early ${code}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('close', onClose);
    };
    ws.once('close', onClose);
  });
}

async function noMessageWithin(ws: WebSocket, ms: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onMessage = () => {
      cleanup();
      reject(new Error('received unexpected message'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
    };
    ws.once('message', onMessage);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

interface CommandCase {
  kind: OutboundServerCommandKind;
  params: unknown;
  result: unknown;
}

function commandCases(hostId: string): CommandCase[] {
  return [
    {
      kind: 'runtime_start',
      params: {
        conversation_id: 'c1',
        agent_id: 'a1',
        options: runtimeStartOptions(),
      },
      result: { started: true, pid: 123, started_at: 1700000000000 },
    },
    {
      kind: 'runtime_stop',
      params: { conversation_id: 'c1', agent_id: 'a1', mode: 'hard' },
      result: { mode: 'hard', stopped: true, exit_code: 0 },
    },
    {
      kind: 'runtime_wake',
      params: {
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [1],
        kind: 'message',
        text: 'hello',
      },
      result: { delivered: true, delivery_ids: [1] },
    },
    {
      kind: 'runtime_status',
      params: { conversation_id: 'c1', agent_id: 'a1' },
      result: { runtimes: [] },
    },
    {
      kind: 'runtime_clear_session',
      params: { conversation_id: 'c1', agent_id: 'a1' },
      result: { cleared: true },
    },
    {
      kind: 'runtime_stop_all',
      params: {},
      result: { stopped_count: 1 },
    },
    {
      kind: 'runtime_close_activity_log',
      params: {},
      result: { flushed: true },
    },
    {
      kind: 'runtime_output_pause',
      params: { conversation_id: 'c1', agent_id: 'a1' },
      result: { paused: true },
    },
    {
      kind: 'runtime_output_resume',
      params: { conversation_id: 'c1', agent_id: 'a1' },
      result: { resumed: true },
    },
    {
      kind: 'rotate_token',
      params: {
        host_id: hostId,
        host_token: 'new-host-token',
        issued_at: 1700000000000,
        grace_until: 1700000060000,
      },
      result: {
        rotated: true,
        host_id: hostId,
        config_refreshed_at: 1700000000100,
      },
    },
  ];
}

function runtimeStartOptions(): unknown {
  return {
    // D4.e-6: SEMANTIC refs only — no `home_dir`/`path` crosses the wire.
    agent: {
      id: 'a1',
      name: 'alice',
    },
    workspace: {
      id: 'w1',
      name: 'workspace',
      kind: 'regular',
    },
    workspace_memory_index: [
      {
        id: 'w1',
        name: 'workspace',
        kind: 'regular',
      },
    ],
    session: {
      conversation_id: 'c1',
      kind: 'channel',
      title: 'workspace',
      parent_conversation_id: null,
      parent_title: null,
      spawned_by_agent_id: null,
      members: [
        {
          kind: 'agent',
          agent_id: 'a1',
          name: 'alice',
          display_name: 'Alice',
          runtime: 'codex',
        },
      ],
    },
    driver: {
      kind: 'codex',
      cli_session_id: null,
      model: null,
      reasoning_effort: null,
      fast_mode: null,
    },
    env_policy: {
      silverhand: {
        auth_token: 'agent-token',
      },
      silverhand_cli: {
        command: 'silverhand',
        args: [],
      },
    },
  };
}

function sendTestCommand(
  controller: HostWsServerController,
  hostId: string,
  testCase: CommandCase,
): Promise<unknown> {
  return controller.sendCommand(
    hostId,
    testCase.kind as never,
    testCase.params as never,
    { timeoutMs: 500 },
  );
}

function runtimeStatusResponse(id: string, agentId: string): string {
  return encodeOutboundFrame({
    direction: 'daemon_to_server',
    type: 'command_response',
    id,
    kind: 'runtime_status',
    result: {
      runtimes: [
        {
          conversation_id: 'c1',
          agent_id: agentId,
          pid: null,
          phase: 'idle',
          run_state: null,
          started_at: null,
        },
      ],
    },
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}
