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
import {
  HOST_CONNECTION_CHANGED_EVENT,
  HOST_WS_CLOSE_REASON_DISCONNECTED,
  HOST_WS_CLOSE_REASON_REVOKED,
  HOST_WS_CLOSE_REASON_UPDATE_REQUIRED,
  apiPaths,
} from '@silverhand/shared';
import { HostTokenService } from '../../src/auth/host-token.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { BackendMetrics } from '../../src/observability/metrics.js';
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

  it('records a bounded protocol mismatch before rejecting an incompatible ready frame', async () => {
    t = buildTestApp();
    const metrics = new BackendMetrics('standalone');
    t.ctx.metrics = metrics;
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    ws.send(
      JSON.stringify({
        ...(readyFrame({ hostName: 'Old Mac' }) as Record<string, unknown>),
        protocol_version: OUTBOUND_PROTOCOL_VERSION + 1,
      }),
    );
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(1002);
    const body = await metrics.render();
    expect(body).toContain(
      `actual_version="${OUTBOUND_PROTOCOL_VERSION + 1}"`,
    );
    expect(body).toContain(
      `supported_version="${OUTBOUND_PROTOCOL_VERSION}"`,
    );
    metrics.close();
  });

  // #task:1631 — the metric above is fleet-wide and answers "how many stale
  // daemons are out there"; it cannot tell ONE user why THEIR Computer is
  // offline. These three pin the per-host fact: recorded on refusal, survives
  // the connection it came from, cleared only by a daemon that actually
  // speaks our version, and never invented from a malformed frame.
  it('keeps the refused version pair on the host after the incompatible connection is gone', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    // The generation about to be refused is deliberately NOT observable through
    // any public reader (#task:1966): pre-`ready` there is no attachment, so the
    // recorded fact is the only thing that names the socket it belongs to, and
    // the "is this refusal still the current story?" compare has to happen inside
    // the controller (pinned by the slot-conflict test below).
    expect(server.controller.connectionIdForHost(host.id)).toBeNull();

    ws.send(
      JSON.stringify({
        ...(readyFrame({ hostName: 'Old Mac' }) as Record<string, unknown>),
        protocol_version: OUTBOUND_PROTOCOL_VERSION - 1,
      }),
    );
    await waitForClose(ws);
    await waitFor(() => server!.controller.getAttachment(host.id) === null);

    // The connection is gone — which is exactly the state that needs
    // explaining, so the fact must outlive it.
    expect(server.controller.getAdmissionFailure(host.id)).toMatchObject({
      kind: 'protocol_mismatch',
      connectionId: expect.any(String),
      offeredProtocolVersion: OUTBOUND_PROTOCOL_VERSION - 1,
      expectedProtocolVersion: OUTBOUND_PROTOCOL_VERSION,
    });
    expect(
      server.controller.getAdmissionFailure(host.id)!.observedAt,
    ).toBeGreaterThan(0);
    expect(server.controller.getAdmissionFailure('other-host')).toBeNull();
  });

  it('clears a recorded refusal once the host sends a compatible ready frame', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });

    const stale = await connectHost(server.url, issued.hostToken);
    sockets.push(stale);
    stale.send(
      JSON.stringify({
        ...(readyFrame({ hostName: 'Old Mac' }) as Record<string, unknown>),
        protocol_version: OUTBOUND_PROTOCOL_VERSION - 1,
      }),
    );
    await waitForClose(stale);
    await waitFor(() => server!.controller.getAdmissionFailure(host.id) !== null);
    await waitFor(() => server!.controller.getAttachment(host.id) === null);

    // Same host, upgraded daemon: a schema-valid `ready` is the only thing
    // that resolves the reason.
    const upgraded = await connectHost(server.url, issued.hostToken);
    sockets.push(upgraded);
    upgraded.send(JSON.stringify(readyFrame({ hostName: 'Old Mac' })));
    await waitFor(
      () => server!.controller.getAttachment(host.id)?.hostname === 'Old Mac',
    );

    expect(server.controller.getAdmissionFailure(host.id)).toBeNull();
  });

  it('records no refusal for a ready frame whose protocol version is not a version', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    // A garbage `protocol_version` is a corrupt-dialer signal, not an
    // actionable "upgrade your daemon" fact — telling the user to upgrade
    // would be a guess.
    ws.send(
      JSON.stringify({
        ...(readyFrame({ hostName: 'Old Mac' }) as Record<string, unknown>),
        protocol_version: 'v-not-a-number',
      }),
    );
    const closed = await waitForClose(ws);

    expect(closed.code).toBe(1002);
    // ...and for the same reason the close stays RETRYABLE (#task:1966): a
    // corrupt dialer may well recover on its next attempt, so it must not get the
    // terminal reason that suppresses the daemon's reconnect.
    expect(closed.reason).not.toBe(HOST_WS_CLOSE_REASON_UPDATE_REQUIRED);
    expect(server.controller.getAdmissionFailure(host.id)).toBeNull();
  });

  // #task:1966 — the four tests below pin the compatibility GATE itself: what an
  // authenticated-but-unadmitted socket is allowed to be seen as, what the server
  // tells the daemon on refusal, and how often it tells the human.
  it('is invisible to the runtime data plane until a compatible ready frame lands', async () => {
    t = buildTestApp();
    server = await openServer(t, { pingIntervalMs: 0 });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);
    expect(server.controller.activeConnectionCount()).toBe(1);

    // @Cindy MUST FIX falsifier: the generation token, the readiness snapshot and
    // the command path must agree. A non-null `connectionIdForHost` here would
    // license `agent_materialize` and runtime commands into a socket this server
    // has not yet agreed to speak to.
    expect(server.controller.connectionIdForHost(host.id)).toBeNull();
    expect(server.controller.getAttachment(host.id)).toBeNull();
    expect(server.controller.connectedHostIds()).toEqual([]);
    await expect(
      server.controller.sendCommand(host.id, 'runtime_status', {}),
    ).rejects.toMatchObject({ code: 'transport_no_connection' });
    // Fail-fast, not write-and-drop: nothing reached the wire.
    await expect(noMessageWithin(ws, 25)).resolves.toBeUndefined();

    ws.send(JSON.stringify(readyFrame({ hostName: 'Studio Mac' })));
    await waitFor(() => server!.controller.getAttachment(host.id) !== null);

    expect(server.controller.connectionIdForHost(host.id)).toEqual(
      expect.any(String),
    );
    expect(server.controller.connectedHostIds()).toEqual([host.id]);
    const pending = server.controller.sendCommand(
      host.id,
      'runtime_status',
      {},
      { timeoutMs: 500 },
    );
    expect(await readJsonFrame(ws)).toMatchObject({
      type: 'command',
      kind: 'runtime_status',
    });
    await expect(pending).rejects.toMatchObject({ code: 'transport_timeout' });
  });

  it('never presents a refused generation to the runtime data plane', async () => {
    t = buildTestApp();
    server = await openServer(t, { pingIntervalMs: 0 });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    ws.send(
      JSON.stringify({
        ...(readyFrame({ hostName: 'Old Mac' }) as Record<string, unknown>),
        protocol_version: OUTBOUND_PROTOCOL_VERSION - 1,
      }),
    );
    const closed = await waitForClose(ws);

    // The refusal is TERMINAL for this daemon build, so the close must say so:
    // the daemon reads this reason to stop burning its reconnect floor.
    expect(closed).toMatchObject({
      code: 1002,
      reason: HOST_WS_CLOSE_REASON_UPDATE_REQUIRED,
    });
    // Only `updateAttachmentReady` writes the attachment registry and the gate
    // never reaches it, so no adapter could ever have seen a live generation for
    // this host.
    expect(server.controller.connectionIdForHost(host.id)).toBeNull();
    expect(server.controller.connectedHostIds()).toEqual([]);
    await expect(
      server.controller.sendCommand(host.id, 'runtime_status', {}),
    ).rejects.toMatchObject({ code: 'transport_no_connection' });
  });

  it('announces the non-self-healing transition once per episode, not once per reconnect', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const hosts = new HostRepo(t.ctx.db);
    const remote = hosts.createUserInvite({ userId: t.viewerUserId });
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: remote.id,
    });
    const ownerEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubOwner = t.ctx.events.subscribeScope(
      `viewer:${t.viewerUserId}`,
      event => ownerEvents.push({ kind: event.kind, payload: event.payload }),
    );

    try {
      // @Norman falsifier: the terminal reason has to arrive as a PUSH, or the
      // human sits behind a generic Offline until some unrelated invalidation.
      // But a stale daemon reconnects ~2/s, and one event per attempt would be
      // the refetch storm this task exists to kill — so it is deduped on the
      // record, which only a valid `ready` clears.
      for (const attempt of [1, 2, 3]) {
        const ws = await connectHost(server.url, issued.hostToken);
        sockets.push(ws);
        ws.send(
          JSON.stringify({
            ...(readyFrame({ hostName: `Old Mac ${attempt}` }) as Record<
              string,
              unknown
            >),
            protocol_version: OUTBOUND_PROTOCOL_VERSION - 1,
          }),
        );
        await waitForClose(ws);
        await waitFor(() => server!.controller.activeConnectionCount() === 0);
      }

      expect(ownerEvents).toEqual([
        {
          kind: HOST_CONNECTION_CHANGED_EVENT,
          payload: { host_id: remote.id },
        },
      ]);
      expect(server.controller.getAdmissionFailure(remote.id)).not.toBeNull();
    } finally {
      unsubOwner();
    }
  });

  it('withholds a recorded refusal while a different dialer holds the transport slot', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });

    const stale = await connectHost(server.url, issued.hostToken);
    sockets.push(stale);
    stale.send(
      JSON.stringify({
        ...(readyFrame({ hostName: 'Old Mac' }) as Record<string, unknown>),
        protocol_version: OUTBOUND_PROTOCOL_VERSION - 1,
      }),
    );
    await waitForClose(stale);
    await waitFor(() => server!.controller.getAdmissionFailure(host.id) !== null);
    await waitFor(() => server!.controller.activeConnectionCount() === 0);

    // A replacement dialer is mid-handshake: not an attachment yet, but the old
    // refusal no longer describes this host's state, so it must not be reported.
    // Under the gate this window is real (it lasts until `ready` lands), which is
    // why the generation compare reads the private transport slot rather than the
    // public readiness snapshot.
    const replacement = await connectHost(server.url, issued.hostToken);
    sockets.push(replacement);
    await waitFor(() => server!.controller.activeConnectionCount() === 1);
    expect(server.controller.getAttachment(host.id)).toBeNull();
    expect(server.controller.getAdmissionFailure(host.id)).toBeNull();
  });

  // relocation-v1 §7-4 (#task:1808) B2 — the registry demotion is a SEMANTIC
  // break with byte-identical frame shapes: an old daemon still DEPENDS on a
  // provision-established registry binding to resolve a regular workspace, but
  // a new backend no longer dispatches `workspace_provision`, so the peers
  // would silently disagree at business time. The epoch bump converts that
  // into a loud fail-at-attach. This pins the PRODUCTION admission gate: an old
  // daemon's ready frame is refused AND no business event it sends behind that
  // frame ever reaches a handler — the business plane is unreachable, not just
  // "eventually inconsistent". Relative to the constant, so a future bump is
  // zero-change here.
  it('an old daemon (one epoch below) is refused at attach and its business events never reach a handler', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    const events: Array<{ hostId: string; kind: string }> = [];
    server = await openServer(t, {
      eventSink: {
        onEvent: (hostId, event) => events.push({ hostId, kind: event.kind }),
      },
    });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    // Old daemon hello: correct shape, one epoch below the backend.
    ws.send(
      JSON.stringify({
        ...(readyFrame({ hostName: 'Old Mac' }) as Record<string, unknown>),
        protocol_version: OUTBOUND_PROTOCOL_VERSION - 1,
      }),
    );
    // A business event queued immediately behind the refused hello — the
    // thing an old daemon would actually try to do. It must be dropped, not
    // dispatched.
    ws.send(
      JSON.stringify({
        direction: 'daemon_to_server',
        type: 'event',
        kind: 'runtime_output_paused',
        conversation_id: 'c1',
        agent_id: 'a1',
      }),
    );

    const closed = await waitForClose(ws);
    expect(closed.code).toBe(1002);
    // Never ready-attached → server→daemon command dispatch can't target it
    // either. The transport slot taken at upgrade is released by the server's
    // own `close` handler, which runs independently of the CLIENT-observed
    // close `waitForClose` resolves on — so settle on the server fact first,
    // exactly like the other refusal cases above.
    await waitFor(() => server!.controller.getAttachment(host.id) === null);
    expect(server.controller.getAttachment(host.id)).toBeNull();
    expect(server.controller.getAdmissionFailure(host.id)).toMatchObject({
      kind: 'protocol_mismatch',
      offeredProtocolVersion: OUTBOUND_PROTOCOL_VERSION - 1,
      expectedProtocolVersion: OUTBOUND_PROTOCOL_VERSION,
    });
    // The business handler is unreachable: the refused connection's event
    // never fanned out.
    expect(events).toEqual([]);
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

  it('rejects non-user-managed remote hosts even with a valid host token', async () => {
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

  // #task:1966 — `activated_at` is the CREDENTIAL axis ("a machine holding this
  // token reached us"), so it is stamped on the authenticated upgrade, BEFORE the
  // compatibility gate. Deliberately not moved behind `ready`: the Add-computer
  // dialog advances on `status === 'attached'`, so gating it would strand that
  // dialog on "waiting for connection" for exactly the incompatible daemon whose
  // terminal reason the user needs to read.
  it('accepts a user-managed remote host token and activates on upgrade, before attachment', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const hosts = new HostRepo(t.ctx.db);
    const remote = hosts.createUserInvite({ userId: 'local' });
    expect(remote).toMatchObject({
      kind: 'remote',
      provisioning_source: 'user_invite',
      activated_at: null,
      finalized_at: null,
    });
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: remote.id,
    });

    const before = Date.now();
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);
    await waitFor(() => hosts.get(remote.id)?.activated_at !== null);

    // The SESSION axis has not opened: no `ready` frame has landed yet.
    expect(server.controller.getAttachment(remote.id)).toBeNull();

    const activated = hosts.get(remote.id);
    expect(activated?.activated_at).toEqual(expect.any(Number));
    expect(activated?.finalized_at).toBeNull();
    expect(activated!.activated_at!).toBeGreaterThanOrEqual(before);
    expect(activated?.last_seen_at).toBe(activated?.activated_at);
    expect(hosts.toDto(activated!)).toMatchObject({
      status: 'attached',
      placeable: false,
    });
  });

  it('publishes owner-scoped host connection changed events on attach and detach', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const hosts = new HostRepo(t.ctx.db);
    const remote = hosts.createUserInvite({ userId: t.viewerUserId });
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: remote.id,
    });
    const ownerEvents: Array<{ kind: string; payload: unknown }> = [];
    const teammateEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubOwner = t.ctx.events.subscribeScope(
      `viewer:${t.viewerUserId}`,
      event => ownerEvents.push({ kind: event.kind, payload: event.payload }),
    );
    const unsubTeammate = t.ctx.events.subscribeScope(
      'viewer:teammate',
      event => teammateEvents.push({ kind: event.kind, payload: event.payload }),
    );

    try {
      const ws = await connectHost(server.url, issued.hostToken);
      sockets.push(ws);

      // #task:1966 — the raw upgrade announces NOTHING. Publishing here is what
      // let the renderer see `host_connection_changed` before `capabilities`
      // existed, and it is what turned a stale daemon's reconnect loop into a
      // fleet-wide refetch storm.
      await expect(noMessageWithin(ws, 25)).resolves.toBeUndefined();
      expect(ownerEvents).toEqual([]);

      ws.send(JSON.stringify(readyFrame({ hostName: 'Studio Mac' })));
      await waitFor(() => ownerEvents.length === 1);
      expect(ownerEvents[0]).toEqual({
        kind: HOST_CONNECTION_CHANGED_EVENT,
        payload: { host_id: remote.id },
      });
      expect(teammateEvents).toEqual([]);

      ws.close();
      await waitForClose(ws);
      await waitFor(() => ownerEvents.length === 2);
      expect(ownerEvents[1]).toEqual({
        kind: HOST_CONNECTION_CHANGED_EVENT,
        payload: { host_id: remote.id },
      });
      expect(teammateEvents).toEqual([]);
    } finally {
      unsubOwner();
      unsubTeammate();
    }
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
    t = buildTestApp({ deploymentMode: 'standalone' });
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

  it('ignores embedded co-located host-ws daemon events even when a fanout sink is configured', async () => {
    t = buildTestApp();
    const events: Array<{ hostId: string; kind: string; connectionId: string }> = [];
    const disconnects: Array<{ hostId: string; connectionId: string }> = [];
    const infos: Array<{ meta: Record<string, unknown>; msg: string }> = [];
    t.ctx.logger = {
      info: (meta, msg) =>
        infos.push({
          meta: meta as Record<string, unknown>,
          msg: String(msg),
        }),
      warn() {},
      error() {},
    };
    server = await openServer(t, {
      pingIntervalMs: 0,
      eventSink: {
        onEvent: (hostId, event, connectionId) =>
          events.push({ hostId, kind: event.kind, connectionId }),
        onDisconnect: (hostId, connectionId) =>
          disconnects.push({ hostId, connectionId }),
      },
    });
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    expect(t.ctx.coLocatedHostId).toBe(host.id);
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

    const ignoredLogs = () =>
      infos.filter(line =>
        line.msg.startsWith('host-ws: outbound event ignored'),
      );
    await waitFor(() => ignoredLogs().length === 1);
    expect(ignoredLogs()[0]).toMatchObject({
      meta: {
        hostId: host.id,
        eventKind: 'ready',
        deploymentMode: 'embedded',
        coLocatedHostId: host.id,
      },
      msg: 'host-ws: outbound event ignored (embedded co-located host uses local outbound socket)',
    });
    expect(ignoredLogs()).toHaveLength(1);
    expect(events).toEqual([]);

    ws.close();
    await waitForClose(ws);
    expect(disconnects).toEqual([]);
  });

  it('forwards embedded user-managed daemon events to the configured fanout sink', async () => {
    t = buildTestApp();
    const events: Array<{ hostId: string; kind: string; connectionId: string }> = [];
    server = await openServer(t, {
      eventSink: {
        onEvent: (hostId, event, connectionId) =>
          events.push({ hostId, kind: event.kind, connectionId }),
      },
    });
    const hosts = new HostRepo(t.ctx.db);
    const remote = hosts.createUserInvite({ userId: 'local' });
    expect(remote.id).not.toBe(t.ctx.coLocatedHostId);
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: remote.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    ws.send(JSON.stringify({
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'ready',
      protocol_version: OUTBOUND_PROTOCOL_VERSION,
      daemon_version: '0.0.0-test',
      daemon_id: 'remote-1',
      instance_id: 'instance-1',
      host_descriptor: { name: 'remote', kind: 'remote' },
      capabilities: [...KNOWN_CAPABILITIES_V1],
      daemon_pid: 123,
      started_at: 1700000000000,
    }));

    await waitFor(() => events.length === 1);
    expect(events).toEqual([
      {
        hostId: remote.id,
        kind: 'ready',
        connectionId: server.controller.connectionIdForHost(remote.id),
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
      msg: 'host-ws: outbound event ignored (embedded co-located host uses local outbound socket)',
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
  // `eventSink.onEvent('ready', ...)`. Co-located embedded hosts ignore
  // host-ws runtime EVENTS, so this registry must not be a function of the
  // `eventSink` pipeline — but the `ready` FRAME does arrive on this websocket
  // for those hosts too, which is why gating attachment on it is safe (#task:1966).
  it('exposes a non-null attachment snapshot for attached hosts (no eventSink wired)', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });

    const t0 = Date.now();
    const ws = await attachHost(server, sockets, issued.hostToken, host.id);
    const t1 = Date.now();

    const attachment = server.controller.getAttachment(host.id);
    expect(attachment).not.toBeNull();
    expect(ws.readyState).toBe(WebSocket.OPEN);
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
    const ws = await attachHost(server, sockets, issued.hostToken, host.id);

    const closed = waitForClose(ws);
    ws.close(1000, 'test_done');
    await closed;

    await waitFor(() => server!.controller.getAttachment(host.id) === null);
    expect(server.controller.getAttachment(host.id)).toBeNull();
  });

  it('rejects a concurrent second connection without replacing the incumbent', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });

    const first = await attachHost(
      server,
      sockets,
      issued.hostToken,
      host.id,
      'Studio Mac',
    );
    const firstAttachment = server.controller.getAttachment(host.id)!;

    await expect(connectHostRejected(server.url, issued.hostToken)).resolves.toEqual({
      statusCode: 409,
      body: {
        error: 'computer already connected',
        error_code: 'computer_already_connected',
        connected_host_name: 'Studio Mac',
      },
    });

    expect(first.readyState).toBe(WebSocket.OPEN);
    expect(server.controller.getAttachment(host.id)).toMatchObject({
      connectionId: firstAttachment.connectionId,
      attachedAt: firstAttachment.attachedAt,
      hostname: 'Studio Mac',
    });
  });

  it('returns null from getAttachment for hosts that never connected', async () => {
    t = buildTestApp();
    server = await openServer(t);
    expect(server.controller.getAttachment('never-connected-host')).toBeNull();
  });

  it('does not notify the fanout sink when a concurrent connection is rejected', async () => {
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

    // The incumbent here is a bare transport slot — no `ready` yet, so no
    // attachment and no name to report. The slot, not the attachment, is the
    // conflict authority (#task:1966): a second dialer must still be refused
    // while the first socket's handshake is unresolved.
    await expect(connectHostRejected(server.url, issued.hostToken)).resolves.toEqual({
      statusCode: 409,
      body: {
        error: 'computer already connected',
        error_code: 'computer_already_connected',
        connected_host_name: null,
      },
    });

    expect(first.readyState).toBe(WebSocket.OPEN);
    expect(disconnects).toEqual([]);
  });

  // D4.c C2 — `disconnectHost` is the controller-level primitive
  // host lifecycle routes use to kick a daemon's outbound WS. Three
  // revoke-default behaviors to pin:
  //   1. With a live attachment: returns true, socket sees close
  //      code 1008 + reason `HOST_WS_CLOSE_REASON_REVOKED`, attachment registry
  //      clears on the same tick the close listener fires.
  //   2. With no attachment: returns false (idempotent — route
  //      can call this without checking attachment state first).
  //   3. After replacement: only the current connection is
  //      affected (registry replacement-safe).
  it('disconnectHost defaults to the revoke close reason', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });

    // No attachment yet → idempotent false.
    expect(server.controller.disconnectHost(host.id)).toBe(false);

    const ws = await attachHost(server, sockets, issued.hostToken, host.id);
    expect(server.controller.activeConnectionCount()).toBe(1);
    expect(server.controller.getAttachment(host.id)).not.toBeNull();

    const closed = waitForClose(ws);
    expect(server.controller.disconnectHost(host.id)).toBe(true);

    await expect(closed).resolves.toMatchObject({
      code: 1008,
      reason: HOST_WS_CLOSE_REASON_REVOKED,
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

  it('disconnectHost can send the availability-axis disconnect close reason', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await attachHost(server, sockets, issued.hostToken, host.id);
    expect(server.controller.getAttachment(host.id)).not.toBeNull();

    const closed = waitForClose(ws);
    expect(
      server.controller.disconnectHost(host.id, HOST_WS_CLOSE_REASON_DISCONNECTED),
    ).toBe(true);

    await expect(closed).resolves.toMatchObject({
      code: 1000,
      reason: HOST_WS_CLOSE_REASON_DISCONNECTED,
    });
    await waitFor(
      () =>
        server!.controller.activeConnectionCount() === 0 &&
        server!.controller.getAttachment(host.id) === null &&
        server!.controller.connectionIdForHost(host.id) === null,
    );
  });

  // #task:1966 — `disconnectHost` is the ONE public reader of the raw transport
  // slot, and this is why: revoke and availability kicks must be able to close a
  // socket that never passed the compatibility gate. Gating it on the attachment
  // would leave a revoked-but-incompatible daemon holding an authenticated socket
  // and the host's slot, so nothing could ever replace it.
  it('disconnectHost kicks an authenticated socket that never attached', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);
    expect(server.controller.getAttachment(host.id)).toBeNull();

    const closed = waitForClose(ws);
    expect(server.controller.disconnectHost(host.id)).toBe(true);

    await expect(closed).resolves.toMatchObject({
      code: 1008,
      reason: HOST_WS_CLOSE_REASON_REVOKED,
    });
    await waitFor(() => server!.controller.activeConnectionCount() === 0);
    expect(server.controller.disconnectHost(host.id)).toBe(false);
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
    const ws = await attachHost(server, sockets, issued.hostToken, host.id);
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
    const ws = await attachHost(server, sockets, issued.hostToken, host.id);
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
    const ws = await attachHost(server, sockets, issued.hostToken, host.id);

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
    const ws = await attachHost(server, sockets, issued.hostToken, host.id);
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
    const first = await attachHost(server, sockets, issued.hostToken, host.id);
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

    const second = await attachHost(server, sockets, issued.hostToken, host.id);
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
    const ws = await attachHost(server, sockets, issued.hostToken, host.id);

    await expect(
      server.controller.sendCommand(
        host.id,
        'runtime_deliver',
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
    const ws = await attachHost(server, sockets, issued.hostToken, host.id);
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

// #task:1966 — an authenticated upgrade is no longer an attachment: the business
// fact "this host is connected" is created by a COMPATIBLE `ready` frame. Tests
// that merely need an attached host go through here; the ones that pin the gate
// itself stop at `connectHost` on purpose. Registers the socket for teardown
// before waiting, so a gate regression fails as a timeout instead of leaking a
// live socket into the next test.
async function attachHost(
  server: TestHostWsServer,
  sockets: WebSocket[],
  token: string,
  hostId: string,
  hostName = 'Test Mac',
): Promise<WebSocket> {
  const ws = await connectHost(server.url, token);
  sockets.push(ws);
  ws.send(JSON.stringify(readyFrame({ hostName })));
  await waitFor(() => server.controller.getAttachment(hostId) !== null);
  return ws;
}

async function connectHostRejected(
  url: string,
  token: string | null,
): Promise<{ statusCode: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const ws = new WebSocket(url, { headers });
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('unexpected-response', onUnexpectedResponse);
    };
    const onOpen = () => {
      cleanup();
      ws.close();
      reject(new Error('expected websocket upgrade to be rejected'));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onUnexpectedResponse = (
      _req: unknown,
      res: NodeJS.ReadableStream & { statusCode?: number },
    ) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        cleanup();
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: res.statusCode ?? 0,
          body: raw ? JSON.parse(raw) as unknown : null,
        });
      });
      res.on('error', err => {
        cleanup();
        reject(err);
      });
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('unexpected-response', onUnexpectedResponse);
  });
}

function readyFrame(opts: { hostName: string }): unknown {
  return {
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'ready',
    protocol_version: OUTBOUND_PROTOCOL_VERSION,
    daemon_version: '0.0.0-test',
    daemon_id: opts.hostName,
    instance_id: 'instance-1',
    host_descriptor: { name: opts.hostName, kind: 'local' },
    capabilities: [...KNOWN_CAPABILITIES_V1],
    daemon_pid: 123,
    started_at: 1700000000000,
  };
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
      kind: 'runtime_deliver',
      params: {
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [1],
        kind: 'message',
        text: 'hello',
        spawn_options: runtimeStartOptions(),
      },
      result: { disposition: 'admitted', pid: 123, started_at: 1700000000000 },
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
