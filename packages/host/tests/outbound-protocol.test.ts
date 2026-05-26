import { describe, expect, it } from 'vitest';
import {
  EventFrameSchema,
  KNOWN_CAPABILITIES_V1,
  ResponseErrorSchema,
  intentSchemas,
} from '../src/protocol.js';
import {
  OUTBOUND_DAEMON_EVENT_KINDS,
  OUTBOUND_PROTOCOL_VERSION,
  OUTBOUND_SERVER_COMMAND_KINDS,
  OutboundDaemonToServerCommandResponseFrameSchema,
  OutboundDaemonToServerEventFrameSchema,
  OutboundFrameSchema,
  OutboundHeartbeatFrameSchema,
  OutboundServerToDaemonCommandFrameSchema,
  RotateTokenParamsSchema,
  encodeOutboundFrame,
  outboundServerCommandSchemas,
} from '../src/outbound-protocol.js';

const RUN_STATE = {
  runId: 'r1',
  agentId: 'a1',
  conversationId: 'c1',
  status: 'idle' as const,
  startedAt: 0,
  updatedAt: 0,
  lastActivityAt: 0,
};

describe('outbound protocol — command catalogue', () => {
  it('contains the D2.0 runtime request surface plus rotate_token only', () => {
    expect([...OUTBOUND_SERVER_COMMAND_KINDS].sort()).toEqual([
      'rotate_token',
      'runtime_clear_session',
      'runtime_close_activity_log',
      'runtime_output_pause',
      'runtime_output_resume',
      'runtime_start',
      'runtime_status',
      'runtime_stop',
      'runtime_stop_all',
      'runtime_wake',
    ]);

    expect(OUTBOUND_SERVER_COMMAND_KINDS).not.toContain('hello' as never);
    expect(OUTBOUND_SERVER_COMMAND_KINDS).not.toContain('ping' as never);
    expect(OUTBOUND_SERVER_COMMAND_KINDS).not.toContain('echo' as never);
    expect(OUTBOUND_SERVER_COMMAND_KINDS).not.toContain('conversation_log_debug' as never);
  });

  it('reuses the existing runtime schemas as command params/results', () => {
    expect(outboundServerCommandSchemas.runtime_start.params).toBe(
      intentSchemas.runtime_start.params,
    );
    expect(outboundServerCommandSchemas.runtime_start.result).toBe(
      intentSchemas.runtime_start.result,
    );
    expect(outboundServerCommandSchemas.runtime_wake.params).toBe(
      intentSchemas.runtime_wake.params,
    );
    expect(outboundServerCommandSchemas.runtime_wake.result).toBe(
      intentSchemas.runtime_wake.result,
    );
  });

  it('keeps every runtime_* intent reachable through the outbound command catalogue', () => {
    const runtimeIntentKinds = Object.keys(intentSchemas)
      .filter(kind => kind.startsWith('runtime_'))
      .sort();
    const outboundRuntimeCommandKinds = OUTBOUND_SERVER_COMMAND_KINDS
      .filter(kind => kind.startsWith('runtime_'))
      .sort();

    expect(outboundRuntimeCommandKinds).toEqual(runtimeIntentKinds);
  });

  it('parses a server_to_daemon runtime command frame', () => {
    const parsed = OutboundServerToDaemonCommandFrameSchema.safeParse({
      direction: 'server_to_daemon',
      type: 'command',
      id: 'cmd-1',
      kind: 'runtime_wake',
      params: {
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [1, 2],
        kind: 'message',
        text: 'hello',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses rotate_token with a strictly future grace window', () => {
    expect(
      RotateTokenParamsSchema.safeParse({
        host_id: 'h1',
        host_token: 'new-token',
        issued_at: 1000,
        grace_until: 61_000,
      }).success,
    ).toBe(true);

    expect(
      RotateTokenParamsSchema.safeParse({
        host_id: 'h1',
        host_token: 'new-token',
        issued_at: 1000,
        grace_until: 1000,
      }).success,
    ).toBe(false);
  });

  it('parses daemon command responses without mixing them with event arms', () => {
    const ok = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-1',
      kind: 'runtime_wake',
      result: { delivered: true, delivery_ids: [1] },
    });
    expect(ok.success).toBe(true);

    const err = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-2',
      kind: 'runtime_wake',
      error: { code: 'internal_error', message: 'boom' },
    });
    expect(err.success).toBe(true);
    expect(ResponseErrorSchema.safeParse(err.success ? err.data.error : null).success).toBe(true);
  });
});

describe('outbound protocol — daemon event catalogue', () => {
  it('pins daemon event arms separately from server command arms', () => {
    expect([...OUTBOUND_DAEMON_EVENT_KINDS].sort()).toEqual([
      'ready',
      'runtime_compaction_stale',
      'runtime_exit',
      'runtime_init_cooldown',
      'runtime_init_retrying',
      'runtime_init_timeout',
      'runtime_output',
      'runtime_output_dropped',
      'runtime_output_paused',
      'runtime_output_resumed',
      'runtime_parsed_event',
      'runtime_parsed_event_dropped',
      'runtime_ready_for_drain',
      'runtime_startup_delivery_consumed',
      'runtime_startup_delivery_failed',
      'runtime_state',
      'shutting_down',
    ]);
    expect(OUTBOUND_DAEMON_EVENT_KINDS).not.toContain('rotate_token' as never);
  });

  it('keeps outbound event names in lockstep with the daemon event surface', () => {
    const daemonEventNames = EventFrameSchema.options
      .map(option => option.shape.event.value)
      .sort();

    expect([...OUTBOUND_DAEMON_EVENT_KINDS].sort()).toEqual(daemonEventNames);
  });

  it('parses outbound ready without the Unix-socket-only socket_path field', () => {
    const parsed = OutboundDaemonToServerEventFrameSchema.safeParse({
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
    });

    expect(parsed.success).toBe(true);
  });

  it('parses runtime events with kind as the event discriminator', () => {
    const parsed = OutboundDaemonToServerEventFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'runtime_state',
      conversation_id: 'c1',
      agent_id: 'a1',
      state: RUN_STATE,
      ts: 1700000000000,
    });

    expect(parsed.success).toBe(true);
  });
});

describe('outbound protocol — frame envelope', () => {
  it('uses direction/type/kind to reject wrong-way frames', () => {
    expect(
      OutboundFrameSchema.safeParse({
        direction: 'server_to_daemon',
        type: 'event',
        kind: 'runtime_state',
        conversation_id: 'c1',
        agent_id: 'a1',
        state: RUN_STATE,
        ts: 1700000000000,
      }).success,
    ).toBe(false);
  });

  it('parses bidirectional app-level heartbeat frames', () => {
    expect(
      OutboundHeartbeatFrameSchema.safeParse({
        direction: 'daemon_to_server',
        type: 'heartbeat',
        kind: 'ping',
        ts: 1700000000000,
      }).success,
    ).toBe(true);

    expect(
      OutboundHeartbeatFrameSchema.safeParse({
        direction: 'server_to_daemon',
        type: 'heartbeat',
        kind: 'pong',
        ts: 1700000000100,
        echo_ts: 1700000000000,
      }).success,
    ).toBe(true);
  });

  it('encodes a single JSON frame and enforces the shared frame cap', () => {
    const encoded = encodeOutboundFrame({
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
    });

    expect(encoded.endsWith('\n')).toBe(false);
    expect(JSON.parse(encoded)).toMatchObject({
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'ready',
    });
  });
});
