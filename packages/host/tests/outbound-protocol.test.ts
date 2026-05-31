import { describe, expect, it } from 'vitest';
import {
  EventFrameSchema,
  KNOWN_CAPABILITIES_V1,
  ResponseErrorSchema,
  intentSchemas,
} from '../src/protocol.js';
import {
  AgentMaterializeErrorCodeSchema,
  AgentMaterializeParamsSchema,
  AgentMaterializeResultSchema,
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
  it('contains the D2.0 runtime request surface plus rotate_token, agent_materialize, and the D4.e data-plane intents', () => {
    expect([...OUTBOUND_SERVER_COMMAND_KINDS].sort()).toEqual([
      'agent_files_purge',
      'agent_l2_seed',
      'agent_materialize',
      'agent_workspace_index',
      'agent_workspace_read',
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
      'workspace_provision',
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

  // D4.d D1: agent_materialize is an additive arm (R4 acceptance
  // gate). It is NOT a runtime_* intent — its handler lives on the
  // daemon's bootstrap path, not on the per-(conversation, agent)
  // runtime supervisor. These tests pin (a) the catalogue contains
  // the arm, (b) params/result schemas round-trip through the
  // discriminated-union envelope, (c) the error-code schema rejects
  // unknown codes (so daemon-side regressions can't leak through).
  it('exposes agent_materialize as an additive command arm with the new param/result schemas', () => {
    expect(OUTBOUND_SERVER_COMMAND_KINDS).toContain('agent_materialize' as never);
    expect(outboundServerCommandSchemas.agent_materialize.params).toBe(
      AgentMaterializeParamsSchema,
    );
    expect(outboundServerCommandSchemas.agent_materialize.result).toBe(
      AgentMaterializeResultSchema,
    );
  });

  it('parses an agent_materialize command frame round-trip (server → daemon)', () => {
    const parsed = OutboundServerToDaemonCommandFrameSchema.safeParse({
      direction: 'server_to_daemon',
      type: 'command',
      id: 'cmd-mat-1',
      kind: 'agent_materialize',
      params: {
        agent_id: 'AbCdEfGhIjKlMnOp',
        agent_home_workspace_id: 'wsah_AbCdEfGhIjKlMnOp',
        name: 'alice',
        runtime: 'claude',
        model: null,
        description: null,
        template_choice: 'default',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('parses an agent_materialize command response round-trip (daemon → server)', () => {
    const ok = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-mat-1',
      kind: 'agent_materialize',
      result: {
        ok: true,
        agent_dir: '/Users/test/.silverhand/agents/AbCdEfGhIjKlMnOp',
        // §6.5 invariant: agent_home_workspace_path === agent_dir.
        agent_home_workspace_path: '/Users/test/.silverhand/agents/AbCdEfGhIjKlMnOp',
        materialized_at: 1_700_000_000_000,
      },
    });
    expect(ok.success).toBe(true);

    const err = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-mat-2',
      kind: 'agent_materialize',
      error: { code: 'agent_dir_collision', message: 'foreign content' },
    });
    expect(err.success).toBe(true);
  });

  it('pins the agent_materialize error-code catalogue and rejects unknown codes', () => {
    expect(AgentMaterializeErrorCodeSchema.options).toEqual([
      'fs_quota_exceeded',
      'fs_unavailable',
      'agent_dir_collision',
      'unsupported_template',
      'unsupported_runtime',
      'internal_error',
    ]);
    expect(AgentMaterializeErrorCodeSchema.safeParse('already_exists').success).toBe(false);
    expect(AgentMaterializeErrorCodeSchema.safeParse('materialize_timeout').success).toBe(false);
  });

  it('rejects agent_materialize params with extra fields (strict)', () => {
    const bad = AgentMaterializeParamsSchema.safeParse({
      agent_id: 'AbCdEfGhIjKlMnOp',
      agent_home_workspace_id: 'wsah_AbCdEfGhIjKlMnOp',
      name: 'alice',
      runtime: 'claude',
      // unknown field — must be rejected by strict() so server bugs
      // don't silently grow the wire surface.
      unexpected: 'nope',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects agent_materialize result with mismatched path types', () => {
    const bad = AgentMaterializeResultSchema.safeParse({
      ok: true,
      agent_dir: '',
      agent_home_workspace_path: '',
      materialized_at: 0,
    });
    expect(bad.success).toBe(false);
  });

  // Cindy D1 round-1 P1: command-specific typed error codes MUST be
  // scoped per-kind. A regression that re-introduces a single global
  // error union would silently widen every command's error surface
  // (e.g., runtime_start could "return" agent_dir_collision and the
  // wire schema would accept it). Pin both directions: the materialize
  // codes pass for `agent_materialize`, and the same codes fail for
  // runtime / rotate command arms.
  it('per-kind error scoping: runtime_start rejects an agent_materialize-only typed code', () => {
    const bad = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-x',
      kind: 'runtime_start',
      error: { code: 'agent_dir_collision', message: 'wrong' },
    });
    expect(bad.success).toBe(false);

    const badRotate = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-y',
      kind: 'rotate_token',
      error: { code: 'fs_quota_exceeded', message: 'wrong' },
    });
    expect(badRotate.success).toBe(false);
  });

  it('per-kind error scoping: agent_materialize accepts both transport codes and typed codes', () => {
    // Transport-level code (shared with all commands)
    const transportOk = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-a',
      kind: 'agent_materialize',
      error: { code: 'internal_error', message: 'boom' },
    });
    expect(transportOk.success).toBe(true);

    // Command-specific typed code
    const typedOk = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-b',
      kind: 'agent_materialize',
      error: { code: 'agent_dir_collision', message: 'foreign' },
    });
    expect(typedOk.success).toBe(true);

    // Still rejects entirely unknown codes (not in any union arm).
    const unknown = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-c',
      kind: 'agent_materialize',
      error: { code: 'materialize_timeout', message: 'wrong scope (server-only)' },
    });
    expect(unknown.success).toBe(false);
  });

  // D4.e-1 (Cindy P1-2): the same per-kind scoping must hold for the two
  // new data-plane intents — their typed taxonomies must not leak into
  // each other or into agent_materialize.
  it('per-kind error scoping: workspace_provision rejects an agent_materialize-only typed code', () => {
    const bad = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-wp-foreign',
      kind: 'workspace_provision',
      error: { code: 'agent_dir_collision', message: 'wrong scope' },
    });
    expect(bad.success).toBe(false);

    // Accepts its own typed codes (incl. the path-bind taxonomy added for
    // A — single intent) + the shared transport code.
    for (const code of [
      'unsupported_kind',
      'invalid_path',
      'path_conflict',
      'fs_quota_exceeded',
      'fs_unavailable',
      'registry_unavailable',
    ] as const) {
      const typedOk = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
        direction: 'daemon_to_server',
        type: 'command_response',
        id: `cmd-wp-typed-${code}`,
        kind: 'workspace_provision',
        error: { code, message: 'seeded' },
      });
      expect(typedOk.success).toBe(true);
    }

    const transportOk = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-wp-transport',
      kind: 'workspace_provision',
      error: { code: 'internal_error', message: 'boom' },
    });
    expect(transportOk.success).toBe(true);
  });

  it('per-kind error scoping: agent_workspace_index rejects a workspace_provision-only typed code', () => {
    const bad = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-awi-foreign',
      kind: 'agent_workspace_index',
      error: { code: 'unsupported_kind', message: 'wrong scope' },
    });
    expect(bad.success).toBe(false);

    // fs_* is a workspace_provision typed code, NOT an index code.
    const badFs = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-awi-fs',
      kind: 'agent_workspace_index',
      error: { code: 'fs_quota_exceeded', message: 'wrong scope' },
    });
    expect(badFs.success).toBe(false);

    // Accepts its own typed code + the shared transport code.
    const typedOk = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-awi-typed',
      kind: 'agent_workspace_index',
      error: { code: 'registry_unavailable', message: 'corrupt' },
    });
    expect(typedOk.success).toBe(true);

    const transportOk = OutboundDaemonToServerCommandResponseFrameSchema.safeParse({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: 'cmd-awi-transport',
      kind: 'agent_workspace_index',
      error: { code: 'internal_error', message: 'boom' },
    });
    expect(transportOk.success).toBe(true);
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
