/**
 * Daemon ↔ HostClient wire fixtures — source of truth for the bytes
 * that travel on the NDJSON socket.
 *
 * See `./README.md` for the layering contract and authority order.
 *
 * ## Maintenance contract
 *
 * Each fixture is one literal NDJSON line (no trailing `\n` — the
 * round-trip test appends it via `encodeFrame`). The `frame` string
 * MUST be parseable by `JSON.parse` AND validate against the schema
 * implied by `kind`:
 *
 *   - `request`            → `RequestFrameSchema` + `intentSchemas[intent].params`
 *   - `response_success`   → `ResponseFrameSchema` + `intentSchemas[intent].result`
 *   - `response_error`     → `ResponseFrameSchema` (error variant only)
 *   - `event`              → `EventFrameSchema`
 *
 * Adding a new fixture: pick the smallest meaningful variant the
 * catalogue does not already cover (new discriminated arm, new enum
 * slot, new optional-field combination). Don't grow this file with
 * stress payloads — those belong in unit tests against the schemas.
 */

import type { z } from 'zod';
import {
  EventFrameSchema,
  intentSchemas,
  LooseResponseFrameSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  type IntentName,
} from '../../../src/protocol.js';
import { testStartOptions } from '../../_helpers/runtime-start-options.js';

export type WireFixtureKind =
  | { kind: 'request'; intent: IntentName }
  | { kind: 'response_success'; intent: IntentName }
  | { kind: 'response_error' }
  /**
   * Per-intent typed-error response fixtures (Cindy D2 P2-1).
   *
   * The generic `response_error` fixture kind validates against
   * `ResponseFrameSchema`, which narrows `error.code` to the 5
   * transport-level codes — too narrow for `agent_materialize`'s
   * typed taxonomy (`agent_dir_collision`, `fs_quota_exceeded`,
   * etc.). `response_error_typed` carries the intent name so the
   * round-trip test can validate the bytes through:
   *   1. `LooseResponseFrameSchema` (transport layer accepts the
   *      typed code as `string`), AND
   *   2. `intentSchemas[intent].error` (the per-intent typed
   *      taxonomy, when defined; otherwise the generic schema —
   *      keeps the kind general-purpose).
   *
   * The wire-contract catalogue test pins that every code in an
   * intent's typed error taxonomy has at least one fixture, so a
   * future addition (new typed code, new typed intent) cannot
   * land without a byte-level pin.
   */
  | { kind: 'response_error_typed'; intent: IntentName }
  | { kind: 'event' };

export interface WireFixture {
  /** Path-style identifier — categorises the fixture without forcing a
   *  separate file per variant. Stable id; never reuse. */
  name: string;
  /** Why this variant exists. Sentence-or-two. */
  description: string;
  /** The literal NDJSON line bytes (no trailing `\n`). Must be valid
   *  JSON; must validate against the schema implied by `kind`. */
  frame: string;
  kind: WireFixtureKind;
}

// ── Helper canonical scalars (kept identical across fixtures so a
//    diff highlights the structural variation, not the field values).
const C = 'c1';
const A = 'a1';
const TS = 1_700_000_000_000;
const COOLDOWN = 1_700_000_300_000;
const PID = 12345;
const DELIVERY_IDS = [101, 102];
const RUNTIME_START_OPTIONS = testStartOptions({
  conversationId: C,
  agentId: A,
  agentName: 'agent-fixture',
  runtime: 'codex',
  workspacePath: '/Users/shiki/workspace/silverhand',
  agentHomeDir: '/Users/shiki/.silverhand/agents/a1',
  model: 'gpt-5',
});

// ── Helper: re-emit a parsed object as a stable single-line frame.
//    Lets us keep the registry source readable while ensuring every
//    fixture is real JSON the schemas can parse. We DO NOT use this
//    for round-trip canonicalisation — the test consumes `frame` as-is.
const enc = (o: unknown): string => JSON.stringify(o);

// ── Request fixtures ───────────────────────────────────────────────
//    One per intent, plus discriminated-union arms where the request
//    schema admits multiple shapes.

const REQUESTS: WireFixture[] = [
  {
    name: 'request/hello',
    description: 'PR-1 lifecycle handshake — empty params, version-agnostic.',
    frame: enc({ id: 'req-hello', intent: 'hello', params: {} }),
    kind: { kind: 'request', intent: 'hello' },
  },
  {
    name: 'request/ping',
    description: 'PR-1 liveness probe — empty params.',
    frame: enc({ id: 'req-ping', intent: 'ping', params: {} }),
    kind: { kind: 'request', intent: 'ping' },
  },
  {
    name: 'request/status',
    description: 'PR-1 status probe — empty params; result is the rich shape.',
    frame: enc({ id: 'req-status', intent: 'status', params: {} }),
    kind: { kind: 'request', intent: 'status' },
  },
  {
    name: 'request/echo',
    description: 'PR-1 round-trip probe with structured payload.',
    frame: enc({ id: 'req-echo', intent: 'echo', params: { message: 'hello' } }),
    kind: { kind: 'request', intent: 'echo' },
  },
  {
    name: 'request/conversation_log_debug-enable',
    description:
      'Conversation log debug toggle — enabled arm carries expires_at.',
    frame: enc({
      id: 'req-cld-on',
      intent: 'conversation_log_debug',
      params: { conversation_id: C, enabled: true, expires_at: TS + 60_000 },
    }),
    kind: { kind: 'request', intent: 'conversation_log_debug' },
  },
  {
    name: 'request/conversation_log_debug-disable',
    description:
      'Conversation log debug toggle — disabled arm omits expires_at.',
    frame: enc({
      id: 'req-cld-off',
      intent: 'conversation_log_debug',
      params: { conversation_id: C, enabled: false },
    }),
    kind: { kind: 'request', intent: 'conversation_log_debug' },
  },
  {
    name: 'request/runtime_start-bare',
    description:
      'D2.g canonical runtime_start: typed metadata only, no derived cwd/spawn/env/prompt bytes.',
    frame: enc({
      id: 'req-start-1',
      intent: 'runtime_start',
      params: { conversation_id: C, agent_id: A, options: RUNTIME_START_OPTIONS },
    }),
    kind: { kind: 'request', intent: 'runtime_start' },
  },
  {
    name: 'request/runtime_start-with-startup-delivery',
    description:
      'runtime_start with batched startup_delivery — daemon encodes (Option A v2).',
    frame: enc({
      id: 'req-start-2',
      intent: 'runtime_start',
      params: {
        conversation_id: C,
        agent_id: A,
        options: RUNTIME_START_OPTIONS,
        startup_delivery: { delivery_ids: DELIVERY_IDS, text: 'queued user message' },
      },
    }),
    kind: { kind: 'request', intent: 'runtime_start' },
  },
  {
    name: 'request/runtime_stop-hard',
    description: 'Hard stop — SIGTERM 5s → SIGKILL cascade. No directive.',
    frame: enc({
      id: 'req-stop-hard',
      intent: 'runtime_stop',
      params: { conversation_id: C, agent_id: A, mode: 'hard' },
    }),
    kind: { kind: 'request', intent: 'runtime_stop' },
  },
  {
    name: 'request/runtime_stop-soft',
    description: 'Soft stop — daemon writes directive text into stdin.',
    frame: enc({
      id: 'req-stop-soft',
      intent: 'runtime_stop',
      params: {
        conversation_id: C,
        agent_id: A,
        mode: 'soft',
        soft_directive: '[the user wants you to stop]',
      },
    }),
    kind: { kind: 'request', intent: 'runtime_stop' },
  },
  {
    name: 'request/runtime_wake-message',
    description: 'Live-delivery wake — kind=message, batch of delivery_ids.',
    frame: enc({
      id: 'req-wake-1',
      intent: 'runtime_wake',
      params: {
        conversation_id: C,
        agent_id: A,
        delivery_ids: DELIVERY_IDS,
        kind: 'message',
        text: 'hi',
      },
    }),
    kind: { kind: 'request', intent: 'runtime_wake' },
  },
  {
    name: 'request/runtime_wake-schedule_fire',
    description: 'Live-delivery wake — kind=schedule_fire (timer-driven).',
    frame: enc({
      id: 'req-wake-2',
      intent: 'runtime_wake',
      params: {
        conversation_id: C,
        agent_id: A,
        delivery_ids: [201],
        kind: 'schedule_fire',
        text: 'scheduled wake',
      },
    }),
    kind: { kind: 'request', intent: 'runtime_wake' },
  },
  {
    name: 'request/runtime_status-no-filters',
    description: 'runtime_status with no filters — daemon returns all runtimes.',
    frame: enc({ id: 'req-status-all', intent: 'runtime_status', params: {} }),
    kind: { kind: 'request', intent: 'runtime_status' },
  },
  {
    name: 'request/runtime_status-with-filters',
    description: 'runtime_status filtered to one (conv, agent) pair.',
    frame: enc({
      id: 'req-status-pair',
      intent: 'runtime_status',
      params: { conversation_id: C, agent_id: A },
    }),
    kind: { kind: 'request', intent: 'runtime_status' },
  },
  {
    name: 'request/runtime_clear_session',
    description:
      'runtime_clear_session — drop driver-side session id (e.g. claude resume).',
    frame: enc({
      id: 'req-clear',
      intent: 'runtime_clear_session',
      params: { conversation_id: C, agent_id: A },
    }),
    kind: { kind: 'request', intent: 'runtime_clear_session' },
  },
  {
    name: 'request/runtime_stop_all',
    description: 'Daemon-wide stop — empty params.',
    frame: enc({ id: 'req-stopall', intent: 'runtime_stop_all', params: {} }),
    kind: { kind: 'request', intent: 'runtime_stop_all' },
  },
  {
    name: 'request/runtime_close_activity_log',
    description: 'Flush + close the daemon activity log JSONL writer.',
    frame: enc({
      id: 'req-close-act',
      intent: 'runtime_close_activity_log',
      params: {},
    }),
    kind: { kind: 'request', intent: 'runtime_close_activity_log' },
  },
  {
    name: 'request/runtime_output_pause',
    description: 'Pause droppable runtime_output stream for a (conv, agent).',
    frame: enc({
      id: 'req-pause',
      intent: 'runtime_output_pause',
      params: { conversation_id: C, agent_id: A },
    }),
    kind: { kind: 'request', intent: 'runtime_output_pause' },
  },
  {
    name: 'request/runtime_output_resume',
    description: 'Resume droppable runtime_output stream for a (conv, agent).',
    frame: enc({
      id: 'req-resume',
      intent: 'runtime_output_resume',
      params: { conversation_id: C, agent_id: A },
    }),
    kind: { kind: 'request', intent: 'runtime_output_resume' },
  },
  {
    name: 'request/host_outbound_attach',
    description:
      'Late-attach the daemon outbound WS to a daemon-config.json (D3.a Commit 3).',
    frame: enc({
      id: 'req-outbound-attach',
      intent: 'host_outbound_attach',
      params: { config_path: '/var/silverhand/daemon-config.json' },
    }),
    kind: { kind: 'request', intent: 'host_outbound_attach' },
  },
  {
    name: 'request/host_outbound_detach',
    description:
      'Best-effort detach hint sent from desktop before-quit cleanup (D3.b Commit 3). Empty params; result has no failure arm.',
    frame: enc({
      id: 'req-outbound-detach',
      intent: 'host_outbound_detach',
      params: {},
    }),
    kind: { kind: 'request', intent: 'host_outbound_detach' },
  },
  {
    name: 'request/host_outbound_reload',
    description:
      'Reload the SAME daemon-config.json the daemon is currently attached to after Settings atomically rewrote the file (D3.c Commit 2). Empty params; daemon re-reads its current configPath.',
    frame: enc({
      id: 'req-outbound-reload',
      intent: 'host_outbound_reload',
      params: {},
    }),
    kind: { kind: 'request', intent: 'host_outbound_reload' },
  },
  {
    name: 'request/agent_materialize-default',
    description:
      'D4.d D2: server asks daemon to materialize an agent home (L1 dir). Server-allocated agent_id + workspace id, default template, claude runtime. agent_materialize is server↔daemon formal semantics — unlike runtime_*/host_outbound_* this carries business state, not transport plumbing.',
    frame: enc({
      id: 'req-agent-materialize-1',
      intent: 'agent_materialize',
      params: {
        agent_id: 'aid_FpzaAEM',
        agent_home_workspace_id: 'wsah_aid_FpzaAEM',
        name: 'Materialize Test Agent',
        runtime: 'claude',
        template_choice: 'default',
      },
    }),
    kind: { kind: 'request', intent: 'agent_materialize' },
  },
];

// ── Successful response fixtures ───────────────────────────────────
//    Every intent's success-arm; for discriminated unions every arm.

const RESPONSES_SUCCESS: WireFixture[] = [
  {
    name: 'response/hello',
    description:
      'v1 hello result — protocol_version + daemon identity + capabilities.',
    frame: enc({
      id: 'req-hello',
      result: {
        protocol_version: 1,
        daemon_version: '0.1.0',
        daemon_id: 'local',
        instance_id: 'inst-fixture',
        host_descriptor: { name: 'local', kind: 'local' },
        capabilities: [
          'runtime.claude',
          'runtime.codex',
          'runtime.cursor',
          'transport.unix_socket',
          'fs.local',
          'proxy.env_inherit',
        ],
      },
    }),
    kind: { kind: 'response_success', intent: 'hello' },
  },
  {
    name: 'response/ping',
    description: 'v1 ping result — pong literal + daemon liveness scalars.',
    frame: enc({
      id: 'req-ping',
      result: {
        pong: true,
        daemon_pid: PID,
        daemon_version: '0.1.0',
        started_at: TS,
      },
    }),
    kind: { kind: 'response_success', intent: 'ping' },
  },
  {
    name: 'response/status-empty-runtimes',
    description: 'status result with no live runtimes (PR-1 baseline).',
    frame: enc({
      id: 'req-status',
      result: {
        daemon_pid: PID,
        daemon_version: '0.1.0',
        started_at: TS,
        uptime_ms: 60_000,
        intent_count: 7,
        runtimes: [],
      },
    }),
    kind: { kind: 'response_success', intent: 'status' },
  },
  {
    name: 'response/echo',
    description: 'echo result — one-field round-trip.',
    frame: enc({ id: 'req-echo', result: { echoed: 'hello' } }),
    kind: { kind: 'response_success', intent: 'echo' },
  },
  {
    name: 'response/conversation_log_debug-enabled',
    description:
      'Conversation log debug result — enabled with future expires_at.',
    frame: enc({
      id: 'req-cld-on',
      result: { ok: true, enabled: true, expires_at: TS + 60_000 },
    }),
    kind: { kind: 'response_success', intent: 'conversation_log_debug' },
  },
  {
    name: 'response/conversation_log_debug-disabled',
    description:
      'Conversation log debug result — disabled, expires_at:null.',
    frame: enc({
      id: 'req-cld-off',
      result: { ok: true, enabled: false, expires_at: null },
    }),
    kind: { kind: 'response_success', intent: 'conversation_log_debug' },
  },
  {
    name: 'response/runtime_start-success',
    description: 'runtime_start success arm — started:true + pid + ts.',
    frame: enc({
      id: 'req-start-1',
      result: { started: true, pid: PID, started_at: TS },
    }),
    kind: { kind: 'response_success', intent: 'runtime_start' },
  },
  {
    name: 'response/runtime_start-success-with-delivery-accepted',
    description:
      'runtime_start success arm — startup_delivery_accepted=true (delivery batch will land).',
    frame: enc({
      id: 'req-start-2',
      result: {
        started: true,
        pid: PID,
        started_at: TS,
        startup_delivery_accepted: true,
      },
    }),
    kind: { kind: 'response_success', intent: 'runtime_start' },
  },
  {
    name: 'response/runtime_start-cooldown',
    description:
      'runtime_start cooldown arm — started:false + reason=init_cooldown (Cindy 3c).',
    frame: enc({
      id: 'req-start-3',
      result: {
        started: false,
        reason: 'init_cooldown',
        cooldown_until: COOLDOWN,
      },
    }),
    kind: { kind: 'response_success', intent: 'runtime_start' },
  },
  {
    name: 'response/runtime_stop-hard-stopped',
    description: 'Hard stop result — process actually got the signal.',
    frame: enc({
      id: 'req-stop-hard',
      result: { mode: 'hard', stopped: true, exit_code: 137 },
    }),
    kind: { kind: 'response_success', intent: 'runtime_stop' },
  },
  {
    name: 'response/runtime_stop-hard-not-running',
    description: 'Hard stop result — nothing to stop, exit_code:null.',
    frame: enc({
      id: 'req-stop-hard-nr',
      result: { mode: 'hard', stopped: false, exit_code: null },
    }),
    kind: { kind: 'response_success', intent: 'runtime_stop' },
  },
  {
    name: 'response/runtime_stop-soft-delivered',
    description: 'Soft stop result — directive line written, no reason.',
    frame: enc({
      id: 'req-stop-soft',
      result: { mode: 'soft', directive_delivered: true },
    }),
    kind: { kind: 'response_success', intent: 'runtime_stop' },
  },
  {
    name: 'response/runtime_stop-soft-not_running',
    description: 'Soft stop result — runtime not live; directive not delivered.',
    frame: enc({
      id: 'req-stop-soft-nr',
      result: {
        mode: 'soft',
        directive_delivered: false,
        reason: 'not_running',
      },
    }),
    kind: { kind: 'response_success', intent: 'runtime_stop' },
  },
  {
    name: 'response/runtime_stop-soft-write_failed',
    description: 'Soft stop result — stdin write failed mid-directive.',
    frame: enc({
      id: 'req-stop-soft-wf',
      result: {
        mode: 'soft',
        directive_delivered: false,
        reason: 'write_failed',
      },
    }),
    kind: { kind: 'response_success', intent: 'runtime_stop' },
  },
  {
    name: 'response/runtime_stop-soft-driver_refused',
    description:
      'Soft stop result — driver returned null encode (config / programming error).',
    frame: enc({
      id: 'req-stop-soft-dr',
      result: {
        mode: 'soft',
        directive_delivered: false,
        reason: 'driver_refused',
      },
    }),
    kind: { kind: 'response_success', intent: 'runtime_stop' },
  },
  {
    name: 'response/runtime_wake-delivered',
    description:
      'Live-delivery success — same delivery_ids returned for markDelivered.',
    frame: enc({
      id: 'req-wake-1',
      result: { delivered: true, delivery_ids: DELIVERY_IDS },
    }),
    kind: { kind: 'response_success', intent: 'runtime_wake' },
  },
  {
    name: 'response/runtime_wake-not_running',
    description: 'Wake refused — runtime not live; row stays pending.',
    frame: enc({
      id: 'req-wake-nr',
      result: {
        delivered: false,
        reason: 'not_running',
        delivery_ids: DELIVERY_IDS,
      },
    }),
    kind: { kind: 'response_success', intent: 'runtime_wake' },
  },
  {
    name: 'response/runtime_wake-not_initialized',
    description:
      'Wake refused — runtime live but pre-init (e.g. claude pre-system_init).',
    frame: enc({
      id: 'req-wake-ni',
      result: {
        delivered: false,
        reason: 'not_initialized',
        delivery_ids: DELIVERY_IDS,
      },
    }),
    kind: { kind: 'response_success', intent: 'runtime_wake' },
  },
  {
    name: 'response/runtime_wake-startup_pending',
    description:
      'Wake refused — startup_delivery still draining; daemon serializes after.',
    frame: enc({
      id: 'req-wake-sp',
      result: {
        delivered: false,
        reason: 'startup_pending',
        delivery_ids: DELIVERY_IDS,
      },
    }),
    kind: { kind: 'response_success', intent: 'runtime_wake' },
  },
  {
    name: 'response/runtime_wake-draining',
    description: 'Wake refused — runtime is in draining phase, no new writes.',
    frame: enc({
      id: 'req-wake-dr',
      result: {
        delivered: false,
        reason: 'draining',
        delivery_ids: DELIVERY_IDS,
      },
    }),
    kind: { kind: 'response_success', intent: 'runtime_wake' },
  },
  {
    name: 'response/runtime_wake-driver_not_ready',
    description:
      'Wake refused — recoverable: driver readyToEncode()=false (Option A v2).',
    frame: enc({
      id: 'req-wake-dnr',
      result: {
        delivered: false,
        reason: 'driver_not_ready',
        delivery_ids: DELIVERY_IDS,
      },
    }),
    kind: { kind: 'response_success', intent: 'runtime_wake' },
  },
  {
    name: 'response/runtime_wake-driver_refused',
    description:
      'Wake refused — fail-loud: encodeStdinMessage returned null AFTER ready.',
    frame: enc({
      id: 'req-wake-drr',
      result: {
        delivered: false,
        reason: 'driver_refused',
        delivery_ids: DELIVERY_IDS,
      },
    }),
    kind: { kind: 'response_success', intent: 'runtime_wake' },
  },
  {
    name: 'response/runtime_status-empty',
    description: 'runtime_status result — no runtimes tracked.',
    frame: enc({ id: 'req-status-all', result: { runtimes: [] } }),
    kind: { kind: 'response_success', intent: 'runtime_status' },
  },
  {
    name: 'response/runtime_status-one-runtime',
    description: 'runtime_status result — one (conv, agent) live in ready phase.',
    frame: enc({
      id: 'req-status-pair',
      result: {
        runtimes: [
          {
            conversation_id: C,
            agent_id: A,
            pid: PID,
            phase: 'ready',
            run_state: {
              runId: 'r1',
              agentId: A,
              conversationId: C,
              status: 'idle',
              startedAt: TS,
              updatedAt: TS,
              lastActivityAt: TS,
            },
            started_at: TS,
          },
        ],
      },
    }),
    kind: { kind: 'response_success', intent: 'runtime_status' },
  },
  {
    name: 'response/runtime_clear_session-cleared',
    description: 'clear_session result — driver state was cleared.',
    frame: enc({ id: 'req-clear', result: { cleared: true } }),
    kind: { kind: 'response_success', intent: 'runtime_clear_session' },
  },
  {
    name: 'response/runtime_stop_all-zero',
    description: 'stop_all result — no runtimes were live.',
    frame: enc({ id: 'req-stopall', result: { stopped_count: 0 } }),
    kind: { kind: 'response_success', intent: 'runtime_stop_all' },
  },
  {
    name: 'response/runtime_stop_all-many',
    description: 'stop_all result — multiple runtimes terminated.',
    frame: enc({ id: 'req-stopall-many', result: { stopped_count: 4 } }),
    kind: { kind: 'response_success', intent: 'runtime_stop_all' },
  },
  {
    name: 'response/runtime_close_activity_log-flushed',
    description: 'close_activity_log result — buffered entries flushed to disk.',
    frame: enc({ id: 'req-close-act', result: { flushed: true } }),
    kind: { kind: 'response_success', intent: 'runtime_close_activity_log' },
  },
  {
    name: 'response/runtime_output_pause-true',
    description: 'output_pause result — droppable stream is now paused.',
    frame: enc({ id: 'req-pause', result: { paused: true } }),
    kind: { kind: 'response_success', intent: 'runtime_output_pause' },
  },
  {
    name: 'response/runtime_output_resume-true',
    description: 'output_resume result — droppable stream is now flowing.',
    frame: enc({ id: 'req-resume', result: { resumed: true } }),
    kind: { kind: 'response_success', intent: 'runtime_output_resume' },
  },
  {
    name: 'response/host_outbound_attach-started',
    description:
      'Late-attach success first time: action=started, fresh outbound client spawned.',
    frame: enc({
      id: 'req-outbound-attach',
      result: {
        attached: true,
        config_path: '/var/silverhand/daemon-config.json',
        action: 'started',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_attach' },
  },
  {
    name: 'response/host_outbound_attach-noop',
    description:
      'Late-attach success on same path with live client: action=noop, no respawn.',
    frame: enc({
      id: 'req-outbound-attach',
      result: {
        attached: true,
        config_path: '/var/silverhand/daemon-config.json',
        action: 'noop',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_attach' },
  },
  {
    name: 'response/host_outbound_attach-switched',
    description:
      'Late-attach success on a different path: prior client stopped, new client started.',
    frame: enc({
      id: 'req-outbound-attach',
      result: {
        attached: true,
        config_path: '/var/silverhand/daemon-config-v2.json',
        action: 'switched',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_attach' },
  },
  {
    name: 'response/host_outbound_attach-failed-path_not_absolute',
    description:
      'Late-attach refusal: config_path must be absolute. Existing client untouched.',
    frame: enc({
      id: 'req-outbound-attach',
      result: {
        attached: false,
        reason: 'path_not_absolute',
        message: 'config_path must be absolute: daemon-config.json',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_attach' },
  },
  {
    name: 'response/host_outbound_attach-failed-path_not_found',
    description:
      'Late-attach refusal: config_path does not exist on disk. Existing client untouched.',
    frame: enc({
      id: 'req-outbound-attach',
      result: {
        attached: false,
        reason: 'path_not_found',
        message: 'ENOENT: no such file or directory',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_attach' },
  },
  {
    name: 'response/host_outbound_attach-failed-path_not_a_file',
    description:
      'Late-attach refusal: config_path resolves to a directory. Existing client untouched.',
    frame: enc({
      id: 'req-outbound-attach',
      result: {
        attached: false,
        reason: 'path_not_a_file',
        message: 'config_path is a directory: /var/silverhand',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_attach' },
  },
  {
    name: 'response/host_outbound_attach-failed-parse_failed',
    description:
      'Late-attach refusal: config JSON is unparseable or shape-invalid. Existing client untouched.',
    frame: enc({
      id: 'req-outbound-attach',
      result: {
        attached: false,
        reason: 'parse_failed',
        message: 'Unexpected token { in JSON at position 1',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_attach' },
  },
  {
    name: 'response/host_outbound_attach-failed-invalid_server_url',
    description:
      'Late-attach refusal: server_url rejected by WS resolver (e.g. non-loopback http). Existing client untouched.',
    frame: enc({
      id: 'req-outbound-attach',
      result: {
        attached: false,
        reason: 'invalid_server_url',
        message: 'tls_required for non-loopback http server_url',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_attach' },
  },
  {
    name: 'response/host_outbound_detach-detached',
    description:
      'Detach hint with an active outbound client: action=detached, client stopped cleanly (D3.b Commit 3).',
    frame: enc({
      id: 'req-outbound-detach',
      result: {
        detached: true,
        action: 'detached',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_detach' },
  },
  {
    name: 'response/host_outbound_detach-noop',
    description:
      'Detach hint with no active client (pre-attach state or already detached): action=noop, harmless.',
    frame: enc({
      id: 'req-outbound-detach',
      result: {
        detached: true,
        action: 'noop',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_detach' },
  },
  {
    name: 'response/host_outbound_reload-reloaded',
    description:
      'Reload swapped to fresh config bytes (D3.c Commit 2): old client stopped, new client started, action=reloaded. WS handshake not yet complete — caller verifies via backend attachment freshness.',
    frame: enc({
      id: 'req-outbound-reload',
      result: {
        reloaded: true,
        action: 'reloaded',
        config_path: '/var/silverhand/daemon-config.json',
        host_id: 'host-loopback-1',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_reload' },
  },
  {
    name: 'response/host_outbound_reload-unchanged',
    description:
      'Reload no-op: new config bytes fingerprint identically to in-memory ones (D3.c Commit 2). Old client kept; no WS bounce.',
    frame: enc({
      id: 'req-outbound-reload',
      result: {
        reloaded: true,
        action: 'unchanged',
        config_path: '/var/silverhand/daemon-config.json',
        host_id: 'host-loopback-1',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_reload' },
  },
  {
    name: 'response/host_outbound_reload-failed-not_attached',
    description:
      'Hard reject (D3.c Commit 2 lock B): no current outbound client — caller must use host_outbound_attach to bootstrap. Reload MUST NOT silently fall through to attach.',
    frame: enc({
      id: 'req-outbound-reload',
      result: {
        reloaded: false,
        reason: 'not_attached',
        message: 'no current outbound client; use host_outbound_attach to bootstrap',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_reload' },
  },
  {
    name: 'response/host_outbound_reload-failed-config_unreadable',
    description:
      'Reload refusal: configured path now ENOENT / unreadable (e.g. atomic-rename clobbered mid-write). Old client untouched.',
    frame: enc({
      id: 'req-outbound-reload',
      result: {
        reloaded: false,
        reason: 'config_unreadable',
        message: 'missing',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_reload' },
  },
  {
    name: 'response/host_outbound_reload-failed-parse_failed',
    description:
      'Reload refusal: config JSON / shape invalid (partial write, hand-edit). Old client untouched.',
    frame: enc({
      id: 'req-outbound-reload',
      result: {
        reloaded: false,
        reason: 'parse_failed',
        message: 'invalid_json',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_reload' },
  },
  {
    name: 'response/host_outbound_reload-failed-invalid_server_url',
    description:
      'Reload refusal: new server_url failed loopback policy gate (e.g. user hand-edited to a non-loopback host bypassing Settings UI). Old client untouched.',
    frame: enc({
      id: 'req-outbound-reload',
      result: {
        reloaded: false,
        reason: 'invalid_server_url',
        message: 'tls_required_for_non_loopback_host_ws',
      },
    }),
    kind: { kind: 'response_success', intent: 'host_outbound_reload' },
  },
  {
    name: 'response/agent_materialize-ok',
    description:
      'D4.d D2: daemon materialized the agent home — sentinel written, template seeded. agent_home_workspace_path equals agent_dir (§6.5 invariant: the DM workspace path IS the L1 dir).',
    frame: enc({
      id: 'req-agent-materialize-1',
      result: {
        ok: true,
        agent_dir: '/home/silverhand/.silverhand/agents/aid_FpzaAEM',
        agent_home_workspace_path:
          '/home/silverhand/.silverhand/agents/aid_FpzaAEM',
        materialized_at: 1_730_000_000_000,
      },
    }),
    kind: { kind: 'response_success', intent: 'agent_materialize' },
  },
];

// ── Error response fixtures ────────────────────────────────────────
//    One per ResponseErrorSchema enum slot.

const RESPONSES_ERROR: WireFixture[] = [
  {
    name: 'response/error-unknown_intent',
    description:
      'Daemon received an intent name not in the registry (typo / version skew).',
    frame: enc({
      id: 'req-bogus',
      error: { code: 'unknown_intent', message: 'unknown intent: foo' },
    }),
    kind: { kind: 'response_error' },
  },
  {
    name: 'response/error-invalid_params',
    description: 'Params failed zod validation at the daemon dispatcher.',
    frame: enc({
      id: 'req-malformed',
      error: { code: 'invalid_params', message: 'expected string at .text' },
    }),
    kind: { kind: 'response_error' },
  },
  {
    name: 'response/error-internal_error',
    description:
      'Handler threw / returned an unexpected error (programming bug, not business state).',
    frame: enc({
      id: 'req-broken',
      error: { code: 'internal_error', message: 'driver crashed' },
    }),
    kind: { kind: 'response_error' },
  },
  {
    name: 'response/error-shutting_down',
    description:
      'Request landed after the daemon caught SIGTERM/SIGINT and stopped accepting new work.',
    frame: enc({
      id: 'req-late',
      error: { code: 'shutting_down', message: 'daemon is draining' },
    }),
    kind: { kind: 'response_error' },
  },
  {
    name: 'response/error-request_too_large',
    description:
      'Incoming frame exceeded MAX_FRAME_BYTES — splitter signalled overflow.',
    frame: enc({
      id: 'req-huge',
      error: { code: 'request_too_large', message: 'frame > 1 MiB' },
    }),
    kind: { kind: 'response_error' },
  },
];

// ── Per-intent typed error response fixtures (Cindy D2 P2-1) ─────
//    One per intent × typed-error-code pairing. Currently only
//    `agent_materialize` exposes typed codes; the wire-contract
//    catalogue test asserts every typed code in every typed intent
//    has a fixture, so a future addition (new typed code, new
//    typed intent) cannot land without a byte-level pin.

const RESPONSES_ERROR_TYPED: WireFixture[] = [
  {
    name: 'response/agent_materialize-error-agent_dir_collision',
    description:
      'Daemon refused to seed because the agent_dir is populated by foreign content (no sentinel) or carries a sentinel whose (agent_id, template_choice, runtime) triple does not match the request. §4.6 collision arms.',
    frame: enc({
      id: 'req-agent-materialize-1',
      error: {
        code: 'agent_dir_collision',
        message: 'agent_dir already materialized with mismatched metadata; sentinel.runtime=codex but request.runtime=claude',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_materialize' },
  },
  {
    name: 'response/agent_materialize-error-fs_quota_exceeded',
    description:
      'Recoverable fs failure — ENOSPC / EDQUOT mapped to fs_quota_exceeded so the route layer can return 507 + operator runbook hint (Cindy D2 pre-gate #3).',
    frame: enc({
      id: 'req-agent-materialize-1',
      error: {
        code: 'fs_quota_exceeded',
        message: 'failed to seed template under /home/silverhand/.silverhand/agents/aid_X: ENOSPC: no space left on device',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_materialize' },
  },
  {
    name: 'response/agent_materialize-error-fs_unavailable',
    description:
      'Recoverable fs failure — EACCES / EPERM / EROFS mapped to fs_unavailable so the route layer can return 503 + retry-after hint.',
    frame: enc({
      id: 'req-agent-materialize-1',
      error: {
        code: 'fs_unavailable',
        message: 'failed to read /home/silverhand/.silverhand/agents: EACCES: permission denied',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_materialize' },
  },
  {
    name: 'response/agent_materialize-error-unsupported_template',
    description:
      'template_choice is structurally valid (passes the wire enum) but the daemon has no template entry for it. D2 ships `default` only; `onboarding`/`minimal` reserved.',
    frame: enc({
      id: 'req-agent-materialize-1',
      error: {
        code: 'unsupported_template',
        message: "daemon does not have a template definition for template_choice='onboarding'",
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_materialize' },
  },
  {
    name: 'response/agent_materialize-error-unsupported_runtime',
    description:
      'runtime is structurally valid (passes the wire enum) but the daemon has no support for it on this host. Reserved arm — emitted by future runtime-capability gating; included here for forward-compat byte pinning.',
    frame: enc({
      id: 'req-agent-materialize-1',
      error: {
        code: 'unsupported_runtime',
        message: 'this daemon does not support runtime=cursor on the host platform',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_materialize' },
  },
  {
    name: 'response/agent_materialize-error-internal_error',
    description:
      'Catch-all for unrecognized fs errno (default arm of classifyFsError). Travels via the typed arm because IPC `ResponseError` is also a legal subset of `AgentMaterializeIpcErrorSchema`.',
    frame: enc({
      id: 'req-agent-materialize-1',
      error: {
        code: 'internal_error',
        message: 'failed to seed template under /home/silverhand/.silverhand/agents/aid_X: EIO: i/o error',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_materialize' },
  },
];

// ── Event fixtures ─────────────────────────────────────────────────
//    Every arm of EventFrameSchema; for discriminated arms (init
//    timeout reasons, parsed event kinds) every enum slot.

const EVENTS: WireFixture[] = [
  {
    name: 'event/ready',
    description:
      'Daemon socket bound — handshake mirror. Carries the same identity fields as hello result plus socket_path / daemon_pid / started_at.',
    frame: enc({
      event: 'ready',
      protocol_version: 1,
      daemon_version: '0.1.0',
      daemon_id: 'local',
      instance_id: 'inst-fixture',
      host_descriptor: { name: 'local', kind: 'local' },
      capabilities: ['runtime.claude', 'transport.unix_socket'],
      socket_path: '/tmp/silverhand-daemon.sock',
      daemon_pid: PID,
      started_at: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/shutting_down',
    description: 'Daemon caught SIGTERM/SIGINT and is draining outstanding work.',
    frame: enc({ event: 'shutting_down', reason: 'SIGTERM' }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_state-idle',
    description:
      'Driver emitted a run-state transition; daemon broadcasts to backend.',
    frame: enc({
      event: 'runtime_state',
      conversation_id: C,
      agent_id: A,
      state: {
        runId: 'r1',
        agentId: A,
        conversationId: C,
        status: 'idle',
        startedAt: TS,
        updatedAt: TS,
        lastActivityAt: TS,
      },
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_output-stdout',
    description: 'Droppable raw stdout chunk from child runtime.',
    frame: enc({
      event: 'runtime_output',
      conversation_id: C,
      agent_id: A,
      stream: 'stdout',
      chunk: 'hello world\n',
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_output-stderr',
    description: 'Droppable raw stderr chunk from child runtime.',
    frame: enc({
      event: 'runtime_output',
      conversation_id: C,
      agent_id: A,
      stream: 'stderr',
      chunk: 'warning: deprecated flag\n',
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_exit-clean',
    description: 'Child exited intentionally with code 0.',
    frame: enc({
      event: 'runtime_exit',
      conversation_id: C,
      agent_id: A,
      code: 0,
      intentional: true,
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_exit-crash',
    description: 'Child died unintentionally; exit code unknown (signal kill).',
    frame: enc({
      event: 'runtime_exit',
      conversation_id: C,
      agent_id: A,
      code: null,
      intentional: false,
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_ready_for_drain',
    description:
      'Driver signalled readiness to receive deferred deliveries (claude post-system_init, codex post-thread_started).',
    frame: enc({
      event: 'runtime_ready_for_drain',
      conversation_id: C,
      agent_id: A,
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_startup_delivery_consumed',
    description:
      'Daemon successfully wrote the startup_delivery batch to stdin; backend may markDelivered.',
    frame: enc({
      event: 'runtime_startup_delivery_consumed',
      conversation_id: C,
      agent_id: A,
      delivery_ids: DELIVERY_IDS,
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_startup_delivery_failed-child_exit',
    description:
      'Startup delivery batch lost because the child exited before drain completed.',
    frame: enc({
      event: 'runtime_startup_delivery_failed',
      conversation_id: C,
      agent_id: A,
      delivery_ids: DELIVERY_IDS,
      reason: 'child_exit',
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_startup_delivery_failed-init_watchdog',
    description:
      'Init watchdog fired before the driver became ready; batch released.',
    frame: enc({
      event: 'runtime_startup_delivery_failed',
      conversation_id: C,
      agent_id: A,
      delivery_ids: DELIVERY_IDS,
      reason: 'init_watchdog',
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_startup_delivery_failed-write_failed',
    description: 'Batch was being written but stdin write failed.',
    frame: enc({
      event: 'runtime_startup_delivery_failed',
      conversation_id: C,
      agent_id: A,
      delivery_ids: DELIVERY_IDS,
      reason: 'write_failed',
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_startup_delivery_failed-driver_refused',
    description:
      'Driver refused the encoded payload (config / programming error, not transport).',
    frame: enc({
      event: 'runtime_startup_delivery_failed',
      conversation_id: C,
      agent_id: A,
      delivery_ids: DELIVERY_IDS,
      reason: 'driver_refused',
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_init_timeout-silence',
    description:
      'Tier 1 watchdog: silence between bytes for too long. Retrying.',
    frame: enc({
      event: 'runtime_init_timeout',
      conversation_id: C,
      agent_id: A,
      timeout_reason: 'silence',
      elapsed_ms: 2_000,
      timeout_ms: 1_000,
      retrying: true,
      retry_attempt: 0,
      max_retries: 3,
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_init_timeout-pre_protocol_cap',
    description:
      'Tier 2 watchdog: hit the pre-protocol cap before driver said hello. Retrying.',
    frame: enc({
      event: 'runtime_init_timeout',
      conversation_id: C,
      agent_id: A,
      timeout_reason: 'pre_protocol_cap',
      elapsed_ms: 4_000,
      timeout_ms: 5_000,
      retrying: true,
      retry_attempt: 1,
      max_retries: 3,
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_init_timeout-post_protocol-final-cooldown',
    description:
      'Tier 3 watchdog: post-protocol stall on the final attempt. retrying:false + cooldown_until carried inline (Cindy 4CJATqU0DdbsGVXW).',
    frame: enc({
      event: 'runtime_init_timeout',
      conversation_id: C,
      agent_id: A,
      timeout_reason: 'post_protocol',
      elapsed_ms: 60_000,
      timeout_ms: 30_000,
      retrying: false,
      retry_attempt: 2,
      max_retries: 3,
      cooldown_until: COOLDOWN,
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_init_retrying',
    description: 'Daemon scheduled a respawn; carries delay + next attempt.',
    frame: enc({
      event: 'runtime_init_retrying',
      conversation_id: C,
      agent_id: A,
      retry_attempt: 1,
      max_retries: 3,
      delay_ms: 500,
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_init_cooldown',
    description: 'Retry budget exhausted; cooldown engaged with epoch deadline.',
    frame: enc({
      event: 'runtime_init_cooldown',
      conversation_id: C,
      agent_id: A,
      cooldown_until: COOLDOWN,
      attempts_exhausted: 3,
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_compaction_stale',
    description:
      'Compaction watchdog fired (5 min) — observational only; daemon does NOT change phase or kill child (Cindy 3c).',
    frame: enc({
      event: 'runtime_compaction_stale',
      conversation_id: C,
      agent_id: A,
      elapsed_ms: 300_000,
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_output_dropped',
    description:
      'Daemon shed runtime_output bytes to enforce per-(conv,agent) buffer cap.',
    frame: enc({
      event: 'runtime_output_dropped',
      conversation_id: C,
      agent_id: A,
      dropped_count: 5,
      bytes_dropped: 1024,
      since_ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_output_paused',
    description: 'Output stream paused via runtime_output_pause intent.',
    frame: enc({
      event: 'runtime_output_paused',
      conversation_id: C,
      agent_id: A,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_output_resumed',
    description: 'Output stream resumed via runtime_output_resume intent.',
    frame: enc({
      event: 'runtime_output_resumed',
      conversation_id: C,
      agent_id: A,
    }),
    kind: { kind: 'event' },
  },
  // ── runtime_parsed_event — one fixture per ParsedEvent kind ──────
  {
    name: 'event/runtime_parsed_event-session_init',
    description: 'ParsedEvent fanout — driver session_init recognized.',
    frame: enc({
      event: 'runtime_parsed_event',
      conversation_id: C,
      agent_id: A,
      parsed: { kind: 'session_init', sessionId: 'sess-1' },
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_parsed_event-thinking',
    description: 'ParsedEvent fanout — driver thinking text.',
    frame: enc({
      event: 'runtime_parsed_event',
      conversation_id: C,
      agent_id: A,
      parsed: { kind: 'thinking', text: 'pondering' },
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_parsed_event-text',
    description: 'ParsedEvent fanout — assistant text chunk.',
    frame: enc({
      event: 'runtime_parsed_event',
      conversation_id: C,
      agent_id: A,
      parsed: { kind: 'text', text: 'hello' },
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_parsed_event-tool_call',
    description:
      'ParsedEvent fanout — tool_call with required-but-opaque input ({} is the common case).',
    frame: enc({
      event: 'runtime_parsed_event',
      conversation_id: C,
      agent_id: A,
      parsed: {
        kind: 'tool_call',
        name: 'Bash',
        input: { command: 'ls' },
        toolCallId: 'tc-1',
      },
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_parsed_event-tool_output',
    description: 'ParsedEvent fanout — tool_output (name + tool_call_id optional).',
    frame: enc({
      event: 'runtime_parsed_event',
      conversation_id: C,
      agent_id: A,
      parsed: { kind: 'tool_output', name: 'Bash', toolCallId: 'tc-1' },
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_parsed_event-turn_end',
    description: 'ParsedEvent fanout — driver turn_end.',
    frame: enc({
      event: 'runtime_parsed_event',
      conversation_id: C,
      agent_id: A,
      parsed: { kind: 'turn_end', sessionId: 'sess-1' },
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_parsed_event-compaction_started',
    description: 'ParsedEvent fanout — compaction_started signal (no payload).',
    frame: enc({
      event: 'runtime_parsed_event',
      conversation_id: C,
      agent_id: A,
      parsed: { kind: 'compaction_started' },
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_parsed_event-compaction_finished',
    description: 'ParsedEvent fanout — compaction_finished signal (no payload).',
    frame: enc({
      event: 'runtime_parsed_event',
      conversation_id: C,
      agent_id: A,
      parsed: { kind: 'compaction_finished' },
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_parsed_event-error',
    description: 'ParsedEvent fanout — driver-side error with optional code/fatal.',
    frame: enc({
      event: 'runtime_parsed_event',
      conversation_id: C,
      agent_id: A,
      parsed: { kind: 'error', message: 'boom', code: 'E_BOOM', fatal: true },
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_parsed_event-unknown',
    description:
      'ParsedEvent fanout — unrecognized line; raw bytes preserved here only (NEVER on _dropped).',
    frame: enc({
      event: 'runtime_parsed_event',
      conversation_id: C,
      agent_id: A,
      parsed: { kind: 'unknown', raw: '<<unparseable line>>' },
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_parsed_event_dropped',
    description:
      'Metadata-only safety valve when an encoded ParsedEvent exceeds MAX_FRAME_BYTES. NO payload — explicitly NO raw / input / text (Cindy C2BZGDbQWfnq-bKJ).',
    frame: enc({
      event: 'runtime_parsed_event_dropped',
      conversation_id: C,
      agent_id: A,
      parsed_kind: 'tool_call',
      encoded_bytes: 2_000_000,
      reason: 'frame_too_large',
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
];

export const wireFixtures: readonly WireFixture[] = [
  ...REQUESTS,
  ...RESPONSES_SUCCESS,
  ...RESPONSES_ERROR,
  ...RESPONSES_ERROR_TYPED,
  ...EVENTS,
];

/** Resolve the schema implied by a fixture kind. Used by the
 *  round-trip test; kept here so the registry and the schema lookup
 *  stay co-located. */
export function schemaForFixture(kind: WireFixtureKind): {
  frame: z.ZodTypeAny;
  inner?: z.ZodTypeAny;
} {
  switch (kind.kind) {
    case 'request':
      return { frame: RequestFrameSchema, inner: intentSchemas[kind.intent].params };
    case 'response_success':
      return { frame: ResponseFrameSchema, inner: intentSchemas[kind.intent].result };
    case 'response_error':
      return { frame: ResponseFrameSchema };
    case 'response_error_typed': {
      // Per-intent typed error fixtures (Cindy D2 P2-1) validate
      // against the LOOSE frame schema (transport-level acceptance)
      // plus the intent's `error` schema as the `inner` validator
      // (per-intent typed-code taxonomy).
      //
      // Cindy D2 round-2 P2: throw if the intent has NO `error`
      // entry. The `response_error_typed` kind's semantics are
      // "this intent declares typed codes beyond the generic
      // ResponseError enum"; using it for an intent without a typed
      // taxonomy would silently fall back to no inner validation
      // and let drift land. The wire-contract catalogue test also
      // pins the same invariant from the opposite direction so a
      // missing schema fails at test-discovery time too.
      const entry = intentSchemas[kind.intent] as { error?: z.ZodTypeAny };
      if (entry.error === undefined) {
        throw new Error(
          `response_error_typed fixture used for intent '${kind.intent}' which has no per-intent 'error' schema in intentSchemas; either declare one or use kind:'response_error' for the generic taxonomy.`,
        );
      }
      return { frame: LooseResponseFrameSchema, inner: entry.error };
    }
    case 'event':
      return { frame: EventFrameSchema };
  }
}
