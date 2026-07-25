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
    name: 'request/host_status',
    description:
      '#task:808 — empty-params snapshot powering the ComputerPane (OS, daemon version, active agent_ids).',
    frame: enc({ id: 'req-host-status', intent: 'host_status', params: {} }),
    kind: { kind: 'request', intent: 'host_status' },
  },
  {
    name: 'request/host_runtime_catalog',
    description:
      '#task:1375 — force-refresh per-host runtime catalog probe; daemon answers with one explicit state per selectable runtime.',
    frame: enc({
      id: 'req-host-runtime-catalog',
      intent: 'host_runtime_catalog',
      params: { force: true },
    }),
    kind: { kind: 'request', intent: 'host_runtime_catalog' },
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
    name: 'request/runtime_deliver-message',
    description:
      '#task:1417 Stage 2 daemon-authoritative delivery — kind=message, batch of delivery_ids, carries spawn_options for the no-handle spawn arm.',
    frame: enc({
      id: 'req-deliver-1',
      intent: 'runtime_deliver',
      params: {
        conversation_id: C,
        agent_id: A,
        delivery_ids: DELIVERY_IDS,
        kind: 'message',
        text: 'hi',
        spawn_options: RUNTIME_START_OPTIONS,
      },
    }),
    kind: { kind: 'request', intent: 'runtime_deliver' },
  },
  {
    name: 'request/runtime_deliver-schedule_fire',
    description:
      '#task:1417 Stage 2 delivery — kind=schedule_fire (timer-driven).',
    frame: enc({
      id: 'req-deliver-2',
      intent: 'runtime_deliver',
      params: {
        conversation_id: C,
        agent_id: A,
        delivery_ids: [201],
        kind: 'schedule_fire',
        text: 'scheduled delivery',
        spawn_options: RUNTIME_START_OPTIONS,
      },
    }),
    kind: { kind: 'request', intent: 'runtime_deliver' },
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
    name: 'request/host_proxy_config_get',
    description:
      'Read daemon-local proxy config from the physical host. Empty params; no server-held proxy bytes exist.',
    frame: enc({
      id: 'req-host-proxy-get',
      intent: 'host_proxy_config_get',
      params: {},
    }),
    kind: { kind: 'request', intent: 'host_proxy_config_get' },
  },
  {
    name: 'request/host_proxy_config_set',
    description:
      'Write daemon-local proxy config on the physical host. Runtime allowlist is explicit per CLI runtime.',
    frame: enc({
      id: 'req-host-proxy-set',
      intent: 'host_proxy_config_set',
      params: {
        proxy_url: 'http://127.0.0.1:7890',
        proxy_runtimes: ['codex'],
      },
    }),
    kind: { kind: 'request', intent: 'host_proxy_config_set' },
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
  {
    name: 'request/workspace_provision-regular',
    description:
      'D4.e-1: server asks daemon to bind a regular workspace into its registry and create its .silverhand skeleton. NO requested_path → daemon self-picks a deterministic managed path (the zero-choice default). Only workspace_id + kind cross the wire. workspace_provision is server↔daemon data-plane semantics: the daemon is the sole authority for host-local workspace paths (invariant I1).',
    frame: enc({
      id: 'req-workspace-provision-1',
      intent: 'workspace_provision',
      params: {
        workspace_id: 'ws_8K2nQ',
        kind: 'regular',
      },
    }),
    kind: { kind: 'request', intent: 'workspace_provision' },
  },
  {
    name: 'request/agent_workspace_index-mixed',
    description:
      'D4.e-1: route-time agent_dir resolver. Backend sends only {agent_id, workspace_ids} (already ACL/DB-authorized) — no path, no kind. The daemon resolves each agent_dir host-side (agent-home → L1 dir; regular → registry), so the backend never assembles a path from workspace_path.',
    frame: enc({
      id: 'req-agent-workspace-index-1',
      intent: 'agent_workspace_index',
      params: {
        agent_id: 'aid_FpzaAEM',
        workspace_ids: ['wsah_aid_FpzaAEM', 'ws_8K2nQ', 'ws_missing'],
      },
    }),
    kind: { kind: 'request', intent: 'agent_workspace_index' },
  },
  {
    name: 'request/agent_workspace_tree',
    description:
      "#task:811: flat tree of every visible file/directory under the agent home dir. Backend sends ONLY {agent_id} — no path. The daemon walks computeAgentDir(agent_id, homedir), filters dotfiles + symlinks (intermediate or leaf), and emits `nodes` ordered (parent dir, kind=directory-first, name). A brand-new agent (no L1 dir yet) returns `{ nodes: [] }` gracefully — never an error.",
    frame: enc({
      id: 'req-agent-workspace-tree-1',
      intent: 'agent_workspace_tree',
      params: {
        agent_id: 'aid_FpzaAEM',
      },
    }),
    kind: { kind: 'request', intent: 'agent_workspace_tree' },
  },
  {
    name: 'request/agent_workspace_file_read',
    description:
      "#task:811: read one file from the agent home dir by virtual path. Backend forwards a /-joined virtual path (no leading or trailing slash, no `.`/`..`/dotfile/NUL/backslash segments); the daemon enforces those rules + a per-segment lstat walk (refuses symlinks intermediate or leaf) + a final realpath boundary check against the agent-home base. 64KB preview cap; `truncated` is set when exceeded.",
    frame: enc({
      id: 'req-agent-workspace-file-read-1',
      intent: 'agent_workspace_file_read',
      params: {
        agent_id: 'aid_FpzaAEM',
        path: 'notes/work-log.md',
      },
    }),
    kind: { kind: 'request', intent: 'agent_workspace_file_read' },
  },
  {
    name: 'request/agent_l2_seed',
    description:
      "D4.e-3: seed a member agent's L2 (per-workspace) memory dir on the owning host. Backend sends ONLY {agent_id, workspace_id, template_choice} — no path, no kind. The daemon resolves the regular workspace's host-local path from its registry (fail-closed when not provisioned) and writes <workspace>/.silverhand/agents/<agent_id>/{MEMORY.md, notes/…} — the L1 template MINUS system_prompt.md (L1-only). Idempotent: existing files are preserved. Replaces backend seedAgentL2 (I1/I6).",
    frame: enc({
      id: 'req-agent-l2-seed-1',
      intent: 'agent_l2_seed',
      params: {
        agent_id: 'aid_FpzaAEM',
        workspace_id: 'ws_custom_7',
        template_choice: 'default',
      },
    }),
    kind: { kind: 'request', intent: 'agent_l2_seed' },
  },
  {
    name: 'request/agent_files_purge',
    description:
      "D4.e-4: remove an agent's host-local files on the owning host. Backend sends ONLY {agent_id, scope, workspace_ids} — no path. The daemon resolves L1 (its homedir) and each L2 (workspace path from the registry) itself. scope:'all' purges L1 + the listed workspaces' L2; scope:'l2' only the L2. Replaces the backend DELETE fs.rm block (I1/I6).",
    frame: enc({
      id: 'req-agent-files-purge-1',
      intent: 'agent_files_purge',
      params: {
        agent_id: 'aid_FpzaAEM',
        scope: 'all',
        workspace_ids: ['ws_custom_7', 'ws_custom_8'],
      },
    }),
    kind: { kind: 'request', intent: 'agent_files_purge' },
  },
  {
    name: 'request/agent_profile_mcp_read',
    description:
      "#task:1135: read the agent's L1 mcp.json (the host-local truth behind `silverhand profile mcp get`). Backend sends ONLY {agent_id} — no path; the daemon resolves the L1 dir from agent_id (I1).",
    frame: enc({
      id: 'req-agent-profile-mcp-read-1',
      intent: 'agent_profile_mcp_read',
      params: {
        agent_id: 'aid_FpzaAEM',
      },
    }),
    kind: { kind: 'request', intent: 'agent_profile_mcp_read' },
  },
  {
    name: 'request/agent_profile_mcp_write',
    description:
      "#task:1135: replace the agent's L1 mcp.json (behind `silverhand profile mcp set`). Backend sends {agent_id, raw}; the daemon re-validates fail-loud then writes atomically. raw is the verbatim JSON text.",
    frame: enc({
      id: 'req-agent-profile-mcp-write-1',
      intent: 'agent_profile_mcp_write',
      params: {
        agent_id: 'aid_FpzaAEM',
        raw: '{"mcpServers":{"fs":{"command":"npx","args":["-y","server-fs"]}}}',
      },
    }),
    kind: { kind: 'request', intent: 'agent_profile_mcp_write' },
  },
  {
    name: 'request/mcp_probe',
    description:
      "#task:1137: live-probe one of the agent's profile MCP servers. Backend sends the scope-keyed source ({kind:'profile', agent_id}), the raw server_name, and include_tools; the daemon opens a one-shot connection and resolves the server config itself (I1).",
    frame: enc({
      id: 'req-mcp-probe-1',
      intent: 'mcp_probe',
      params: {
        source: { kind: 'profile', agent_id: 'aid_FpzaAEM' },
        server_name: 'github',
        include_tools: true,
      },
    }),
    kind: { kind: 'request', intent: 'mcp_probe' },
  },
  {
    name: 'request/agent_message_send',
    description:
      'Agent runtime asks the daemon to send a visible message; daemon owns freshness boundary stamping before backend side-effect.',
    frame: enc({
      id: 'req-agent-message-send-1',
      intent: 'agent_message_send',
      params: {
        conversation_id: 'conv_A',
        agent_id: 'agent_A',
        content: 'hello',
        stale_resolution_reason: 'revised',
      },
    }),
    kind: { kind: 'request', intent: 'agent_message_send' },
  },
  {
    name: 'request/agent_stale_resolve',
    description:
      'Agent runtime asks the daemon to resolve the current pending stale event as obsolete without sending a message.',
    frame: enc({
      id: 'req-agent-stale-resolve-1',
      intent: 'agent_stale_resolve',
      params: {
        conversation_id: 'conv_A',
        agent_id: 'agent_A',
        resolution_reason: 'obsolete',
      },
    }),
    kind: { kind: 'request', intent: 'agent_stale_resolve' },
  },
  {
    name: 'request/agent_stream_observed',
    description:
      'Agent runtime tells the daemon it observed a reply cluster via an HTTP pull (history --target thread:<root>); daemon advances the thread:<root> observed boundary and records the surfaced ids as known reply targets. Daemon-local, no backend call.',
    frame: enc({
      id: 'req-agent-stream-observed-1',
      intent: 'agent_stream_observed',
      params: {
        conversation_id: 'conv_A',
        agent_id: 'agent_A',
        thread_root_id: 'msg_root',
        observed_seq: 14,
        reply_target_messages: ['msg_root', 'msg_reply_1', 'msg_reply_2'],
      },
    }),
    kind: { kind: 'request', intent: 'agent_stream_observed' },
  },
  {
    name: 'request/agent_stale_receive',
    description:
      '#task:1614 deferred pull: after a message_stale 409 the agent asks the daemon for the deferred delivery batch as a tool result, with a bounded wait window. Custody arbitration is daemon-side (same lifecycle lock / bounded FIFO prefix as the auto-flush).',
    frame: enc({
      id: 'req-agent-stale-receive-1',
      intent: 'agent_stale_receive',
      params: {
        conversation_id: 'conv_A',
        agent_id: 'agent_A',
        wait_ms: 20_000,
      },
    }),
    kind: { kind: 'request', intent: 'agent_stale_receive' },
  },
  {
    name: 'request/workspace_provision-with-requested-path',
    description:
      'D4.e-1 (A — single intent): the SAME workspace_provision command, but carrying an OPTIONAL caller-proposed requested_path (M1 desktop folder picker / sandbox typed path unify here). The daemon RE-VALIDATES the path host-side (absolute / not root / not home / not inside the managed root / not already bound) before binding — it never blindly trusts the backend. The authoritative result is bound_workspace_path, not this field.',
    frame: enc({
      id: 'req-workspace-provision-2',
      intent: 'workspace_provision',
      params: {
        workspace_id: 'ws_custom_7',
        kind: 'regular',
        requested_path: '/Users/alice/work/my-workspace',
      },
    }),
    kind: { kind: 'request', intent: 'workspace_provision' },
  },
];

// ── Successful response fixtures ───────────────────────────────────
//    Every intent's success-arm; for discriminated unions every arm.

const RESPONSES_SUCCESS: WireFixture[] = [
  {
    name: 'response/hello',
    description:
      'v8 hello result — protocol_version + daemon identity + capabilities.',
    frame: enc({
      id: 'req-hello',
      result: {
        protocol_version: 9,
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
          'agent.freshness_authority',
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
    name: 'response/host_status',
    description:
      '#task:808 — host snapshot. OS string composed daemon-side; active_agent_ids enables backend online-state join.',
    frame: enc({
      id: 'req-host-status',
      result: {
        os: 'macOS 14.5',
        os_arch: 'arm64',
        daemon_pid: PID,
        daemon_version: '0.1.0',
        started_at: TS,
        uptime_ms: 60_000,
        active_agent_ids: ['a1', 'a2'],
      },
    }),
    kind: { kind: 'response_success', intent: 'host_status' },
  },
  {
    name: 'response/host_runtime_catalog',
    description:
      '#task:1375 — explicit per-selectable-runtime availability states from the host-side resolver.',
    frame: enc({
      id: 'req-host-runtime-catalog',
      result: {
        detected_at: TS,
        runtimes: [
          {
            kind: 'claude',
            state: 'present',
            reason: 'resolved',
            installed: true,
            binary: '/usr/local/bin/claude',
            version: '1.2.3',
          },
          {
            kind: 'codex',
            state: 'present_unverified',
            reason: 'version_unavailable',
            installed: true,
            binary: '/usr/local/bin/codex',
            version: null,
          },
          {
            kind: 'qoder',
            state: 'absent',
            reason: 'not_found',
            installed: false,
            binary: null,
            version: null,
          },
        ],
      },
    }),
    kind: { kind: 'response_success', intent: 'host_runtime_catalog' },
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
    name: 'response/agent_message_send-success',
    description:
      'Daemon-owned freshness send success returns backend message id and seq.',
    frame: enc({
      id: 'req-agent-message-send-1',
      result: { ok: true, message_id: 'msg_123', message_seq: 14 },
    }),
    kind: { kind: 'response_success', intent: 'agent_message_send' },
  },
  {
    name: 'response/agent_stale_resolve-success',
    description:
      'Daemon-owned stale resolution consumed the pending event and recorded obsolete.',
    frame: enc({
      id: 'req-agent-stale-resolve-1',
      result: { ok: true, resolved: true },
    }),
    kind: { kind: 'response_success', intent: 'agent_stale_resolve' },
  },
  {
    name: 'response/agent_stream_observed-success',
    description:
      'Daemon acked the pull-observe: per-stream observed boundary advanced and reply-target ids recorded. Daemon-local state only.',
    frame: enc({
      id: 'req-agent-stream-observed-1',
      result: { ok: true },
    }),
    kind: { kind: 'response_success', intent: 'agent_stream_observed' },
  },
  {
    name: 'response/agent_stale_receive-batch_covered',
    description:
      '#task:1614 pull took the next bounded FIFO prefix and its per-stream coverage reaches the stale head. Text is the verbatim combined batch the turn_end flush would have written.',
    frame: enc({
      id: 'req-agent-stale-receive-1',
      result: {
        ok: true,
        outcome: 'batch_covered',
        stale_event_id: 'stale-evt-1',
        text: '[msg from @alice] the newer message body',
        delivery_ids: [201, 202],
        covered_seq_by_stream: [['main', 30]],
      },
    }),
    kind: { kind: 'response_success', intent: 'agent_stale_receive' },
  },
  {
    name: 'response/agent_stale_receive-batch_partial_armed',
    description:
      '#task:1614 pull took the prefix but the stale head is NOT covered; the stale event stays armed. Observed advances only by the actual coverage.',
    frame: enc({
      id: 'req-agent-stale-receive-1',
      result: {
        ok: true,
        outcome: 'batch_partial_armed',
        stale_event_id: 'stale-evt-1',
        text: '[msg from @alice] an earlier message body',
        delivery_ids: [201],
        covered_seq_by_stream: [['main', 21]],
      },
    }),
    kind: { kind: 'response_success', intent: 'agent_stale_receive' },
  },
  {
    name: 'response/agent_stale_receive-no_pending_stale',
    description: '#task:1614 typed no-op: no unresolved message_stale for this agent.',
    frame: enc({
      id: 'req-agent-stale-receive-1',
      result: { ok: true, outcome: 'no_pending_stale' },
    }),
    kind: { kind: 'response_success', intent: 'agent_stale_receive' },
  },
  {
    name: 'response/agent_stale_receive-already_admitted',
    description:
      '#task:1614 the observed cursor already covers the ORIGINAL stale head (proves only that; a newer head may exist — the send CAS stays authoritative).',
    frame: enc({
      id: 'req-agent-stale-receive-1',
      result: {
        ok: true,
        outcome: 'already_admitted',
        stale_event_id: 'stale-evt-1',
        stale_current_seq: 30,
        observed_seq: 31,
      },
    }),
    kind: { kind: 'response_success', intent: 'agent_stale_receive' },
  },
  {
    name: 'response/agent_stale_receive-normal_delivery_in_progress',
    description:
      '#task:1614 the covering content already entered normal release/admission (stdin write in flight or parked mid-turn admission); the pull takes nothing back.',
    frame: enc({
      id: 'req-agent-stale-receive-1',
      result: {
        ok: true,
        outcome: 'normal_delivery_in_progress',
        stale_event_id: 'stale-evt-1',
      },
    }),
    kind: { kind: 'response_success', intent: 'agent_stale_receive' },
  },
  {
    name: 'response/agent_stale_receive-timeout',
    description:
      '#task:1614 no matching daemon batch was obtained in the wait window. States nothing else: custody and the stale event are unchanged, no cause is inferred.',
    frame: enc({
      id: 'req-agent-stale-receive-1',
      result: {
        ok: true,
        outcome: 'timeout',
        stale_event_id: 'stale-evt-1',
        waited_ms: 20_000,
      },
    }),
    kind: { kind: 'response_success', intent: 'agent_stale_receive' },
  },
  {
    name: 'response/runtime_start-success',
    description: 'runtime_start success arm — pure lifecycle: started:true + pid + started_at.',
    frame: enc({
      id: 'req-start-1',
      result: { started: true, pid: PID, started_at: TS },
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
    name: 'response/runtime_deliver-spawning',
    description:
      '#task:1417 Stage 2 — no live handle: daemon spawned, batch is the startup delivery. Custody transferred (no ack).',
    frame: enc({
      id: 'req-deliver-1',
      result: { disposition: 'spawning', pid: PID, started_at: TS },
    }),
    kind: { kind: 'response_success', intent: 'runtime_deliver' },
  },
  {
    name: 'response/runtime_deliver-admitted',
    description:
      '#task:1417 Stage 2 — ready handle: daemon encoded + wrote stdin. Custody transferred; delivered_at rides the async runtime_delivery_consumed.',
    frame: enc({
      id: 'req-deliver-1',
      result: { disposition: 'admitted', pid: PID, started_at: TS },
    }),
    kind: { kind: 'response_success', intent: 'runtime_deliver' },
  },
  {
    name: 'response/runtime_deliver-refused-startup_pending',
    description:
      '#task:1417 Stage 2 — handle not yet drainable (pending startup batch / still spawning / driver not ready). Backend keeps rows pending, retries on ready_for_drain.',
    frame: enc({
      id: 'req-deliver-1',
      result: { disposition: 'refused', reason: 'startup_pending' },
    }),
    kind: { kind: 'response_success', intent: 'runtime_deliver' },
  },
  {
    name: 'response/runtime_deliver-refused-draining',
    description: '#task:1417 Stage 2 — handle draining (hard stop in flight).',
    frame: enc({
      id: 'req-deliver-1',
      result: { disposition: 'refused', reason: 'draining' },
    }),
    kind: { kind: 'response_success', intent: 'runtime_deliver' },
  },
  {
    name: 'response/runtime_deliver-refused-cooldown',
    description:
      '#task:1417 Stage 2 — spawn arm hit the init-failure cooldown gate; cooldown_until present ONLY on this reason.',
    frame: enc({
      id: 'req-deliver-1',
      result: {
        disposition: 'refused',
        reason: 'cooldown',
        cooldown_until: TS,
      },
    }),
    kind: { kind: 'response_success', intent: 'runtime_deliver' },
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
      'Reload refusal: new server_url failed daemon WS policy gate (e.g. user hand-edited to insecure remote HTTP). Old client untouched.',
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
    name: 'response/host_proxy_config_get',
    description:
      'Daemon-local proxy config read result. Server settings never carry these bytes.',
    frame: enc({
      id: 'req-host-proxy-get',
      result: {
        config: {
          proxy_url: 'http://127.0.0.1:7890',
          proxy_runtimes: ['codex'],
        },
      },
    }),
    kind: { kind: 'response_success', intent: 'host_proxy_config_get' },
  },
  {
    name: 'response/host_proxy_config_set',
    description:
      'Daemon-local proxy config write result echoes the normalized config.',
    frame: enc({
      id: 'req-host-proxy-set',
      result: {
        config: {
          proxy_url: null,
          proxy_runtimes: [],
        },
      },
    }),
    kind: { kind: 'response_success', intent: 'host_proxy_config_set' },
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
  {
    name: 'response/workspace_provision-ok',
    description:
      'D4.e-1: daemon bound the workspace (newly provisioned) and created its .silverhand skeleton. provisioned=true on first bind. bound_workspace_path is the daemon-authoritative path (here a managed default); it is a TRANSITIONAL seam the backend may cache into the legacy workspace_path column only — never interpret to assemble agent_dir.',
    frame: enc({
      id: 'req-workspace-provision-1',
      result: {
        ok: true,
        provisioned: true,
        bound_workspace_path:
          '/home/silverhand/.silverhand/daemon/3b1c.../workspaces/9f2a...',
      },
    }),
    kind: { kind: 'response_success', intent: 'workspace_provision' },
  },
  {
    name: 'response/workspace_provision-with-path-ok',
    description:
      'D4.e-1 (A): daemon accepted+validated a caller-proposed requested_path and bound it. bound_workspace_path echoes the validated (resolved) path — the authoritative value the backend caches; the proposed input is never trusted as-is.',
    frame: enc({
      id: 'req-workspace-provision-2',
      result: {
        ok: true,
        provisioned: true,
        bound_workspace_path: '/Users/alice/work/my-workspace',
      },
    }),
    kind: { kind: 'response_success', intent: 'workspace_provision' },
  },
  {
    name: 'response/agent_workspace_index-mixed',
    description:
      'D4.e-1: daemon stamped each agent_dir host-side. agent-home resolves to the L1 dir; the provisioned regular workspace resolves under the managed root; the never-provisioned id comes back in unresolved (read fail-closed — the backend MUST NOT fall back to a workspace_path-derived path).',
    frame: enc({
      id: 'req-agent-workspace-index-1',
      result: {
        ok: true,
        entries: [
          {
            workspace_id: 'wsah_aid_FpzaAEM',
            agent_dir: '/home/silverhand/.silverhand/agents/aid_FpzaAEM',
          },
          {
            workspace_id: 'ws_8K2nQ',
            agent_dir:
              '/home/silverhand/.silverhand/daemon/3b1c.../workspaces/9f2a.../.silverhand/agents/aid_FpzaAEM',
          },
        ],
        unresolved: ['ws_missing'],
      },
    }),
    kind: { kind: 'response_success', intent: 'agent_workspace_index' },
  },
  {
    name: 'response/agent_workspace_tree',
    description:
      '#task:811: daemon walked the agent home dir host-side and returned the flat tree — every visible entry, dotfiles + symlinks filtered, ordered (parent dir, kind=directory-first, name).',
    frame: enc({
      id: 'req-agent-workspace-tree-1',
      result: {
        ok: true,
        tree: {
          nodes: [
            {
              path: 'notes',
              kind: 'directory',
              size: 0,
              mtime: 1_780_000_000_000,
            },
            {
              path: 'MEMORY.md',
              kind: 'file',
              size: 9,
              mtime: 1_780_000_000_001,
            },
            {
              path: 'system_prompt.md',
              kind: 'file',
              size: 12,
              mtime: 1_780_000_000_000,
            },
            {
              path: 'notes/project.md',
              kind: 'file',
              size: 128,
              mtime: 1_780_000_000_010,
            },
            {
              path: 'notes/work-log.md',
              kind: 'file',
              size: 240,
              mtime: 1_780_000_000_050,
            },
          ],
        },
      },
    }),
    kind: { kind: 'response_success', intent: 'agent_workspace_tree' },
  },
  {
    name: 'response/agent_workspace_file_read',
    description:
      '#task:811: daemon read one file under the agent home dir host-side and returned `{path, content, size, mtime, truncated}`. `path` echoes the caller-supplied virtual path verbatim for cache-key stability; `truncated:false` here (≤64KB).',
    frame: enc({
      id: 'req-agent-workspace-file-read-1',
      result: {
        ok: true,
        file: {
          path: 'notes/work-log.md',
          content: '## entry\nworked on slice 4',
          size: 28,
          mtime: 1_780_000_000_050,
          truncated: false,
        },
      },
    }),
    kind: { kind: 'response_success', intent: 'agent_workspace_file_read' },
  },
  {
    name: 'response/agent_l2_seed',
    description:
      'D4.e-3: daemon seeded the member agent L2 dir under the resolved workspace path and returned the outcome. seeded:true = at least one new file written; l2_present:true = MEMORY.md exists post-call. An idempotent re-seed returns seeded:false / l2_present:true.',
    frame: enc({
      id: 'req-agent-l2-seed-1',
      result: {
        ok: true,
        seeded: true,
        l2_present: true,
      },
    }),
    kind: { kind: 'response_success', intent: 'agent_l2_seed' },
  },
  {
    name: 'response/agent_files_purge',
    description:
      'D4.e-4: daemon removed the agent L1 + listed L2 dirs and returned the outcome. purged_count = dirs that existed and were removed; skipped_unprovisioned = listed workspaces with no registry binding (no daemon-managed L2 dir to purge).',
    frame: enc({
      id: 'req-agent-files-purge-1',
      result: {
        ok: true,
        purged_count: 3,
        skipped_unprovisioned: 0,
      },
    }),
    kind: { kind: 'response_success', intent: 'agent_files_purge' },
  },
  {
    name: 'response/agent_profile_mcp_read',
    description:
      '#task:1135: daemon returned the raw mcp.json text. raw:null is the normal "no MCP configured" case (absent file), NOT an error.',
    frame: enc({
      id: 'req-agent-profile-mcp-read-1',
      result: {
        ok: true,
        raw: '{"mcpServers":{"fs":{"command":"npx"}}}',
      },
    }),
    kind: { kind: 'response_success', intent: 'agent_profile_mcp_read' },
  },
  {
    name: 'response/agent_profile_mcp_write',
    description:
      '#task:1135: daemon atomically replaced mcp.json and returned the byte count written.',
    frame: enc({
      id: 'req-agent-profile-mcp-write-1',
      result: {
        ok: true,
        bytes_written: 63,
      },
    }),
    kind: { kind: 'response_success', intent: 'agent_profile_mcp_write' },
  },
  {
    name: 'response/mcp_probe',
    description:
      '#task:1137: daemon connected + initialized + listed tools, then closed the one-shot connection. Connection/handshake/tools failures ride in the result body (ok:false + phase), not as a typed error.',
    frame: enc({
      id: 'req-mcp-probe-1',
      result: {
        ok: true,
        phase: 'tools',
        server_info: { name: 'github-mcp', version: '1.2.3' },
        tools: [{ name: 'list_issues', description: 'List issues' }],
      },
    }),
    kind: { kind: 'response_success', intent: 'mcp_probe' },
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
      'Daemon refused to seed because the agent_dir is populated by foreign content (no sentinel) or carries a sentinel whose (agent_id, template_choice) identity does not match the request. §4.6 collision arms.',
    frame: enc({
      id: 'req-agent-materialize-1',
      error: {
        code: 'agent_dir_collision',
        message: 'agent_dir already materialized with mismatched metadata; sentinel.template_choice=minimal but request.template_choice=default',
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
  // #task:1614 agent_stale_receive non-custody arbitration failures —
  // each states "this call cannot arbitrate", never a custody fact
  // (custody facts travel only in the result outcomes).
  {
    name: 'response/agent_stale_receive-error-pull_already_active',
    description:
      'One waiter/reservation per handle: a second concurrent pull is refused; the first call is unaffected.',
    frame: enc({
      id: 'req-agent-stale-receive-1',
      error: {
        code: 'pull_already_active',
        message: 'another stale-receive pull is already active for this runtime',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_stale_receive' },
  },
  {
    name: 'response/agent_stale_receive-error-stale_event_replaced',
    description:
      'The pending stale event changed identity after this call bound to it; the old waiter is invalid by contract — re-issue against the new event.',
    frame: enc({
      id: 'req-agent-stale-receive-1',
      error: {
        code: 'stale_event_replaced',
        message: 'pending stale event changed while the pull was waiting; re-issue against the new event',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_stale_receive' },
  },
  {
    name: 'response/agent_stale_receive-error-runtime_replaced',
    description:
      'The runtime handle this call bound to exited or was respawned while waiting; zero custody was taken.',
    frame: enc({
      id: 'req-agent-stale-receive-1',
      error: {
        code: 'runtime_replaced',
        message: 'runtime handle exited or was replaced while the pull was waiting',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_stale_receive' },
  },
  {
    name: 'response/agent_stale_receive-error-handoff_unsupported',
    description:
      'Fail closed before any custody decision: only the control-socket ingress can prove a response transport handoff; any other ingress is refused.',
    frame: enc({
      id: 'req-agent-stale-receive-1',
      error: {
        code: 'handoff_unsupported',
        message: 'agent_stale_receive requires an ingress that proves response transport handoff (control socket only)',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_stale_receive' },
  },
];

// D4.e-1 workspace_provision typed errors — server↔daemon data-plane
// formal error surface. One fixture per WorkspaceProvisionErrorCodeSchema
// slot so cross-implementation byte pins exist (Cindy P1-2).
const WORKSPACE_PROVISION_ERROR_FIXTURES: WireFixture[] = [
  {
    name: 'response/workspace_provision-error-unsupported_kind',
    description:
      'Backend routed a kind=agent_home workspace to workspace_provision. agent_home is materialized via agent_materialize (owns the L1 dir), never here — backend misuse, surfaced typed.',
    frame: enc({
      id: 'req-workspace-provision-1',
      error: {
        code: 'unsupported_kind',
        message:
          'agent_home workspaces are materialized via agent_materialize, not workspace_provision',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'workspace_provision' },
  },
  {
    name: 'response/workspace_provision-error-invalid_path',
    description:
      'A caller-supplied requested_path failed daemon-side validation (relative / root / home / inside the managed root). Cannot occur on the no-path default branch. The daemon never blindly trusts a backend path.',
    frame: enc({
      id: 'req-workspace-provision-2',
      error: {
        code: 'invalid_path',
        message: 'requested path cannot be the home directory',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'workspace_provision' },
  },
  {
    name: 'response/workspace_provision-error-path_conflict',
    description:
      'Path-vs-id binding conflict: the id is already bound to a different path, OR the requested_path is already bound to another workspace. Refused, never silently overwritten (same id→same path is idempotent, not a conflict).',
    frame: enc({
      id: 'req-workspace-provision-2',
      error: {
        code: 'path_conflict',
        message:
          'path /Users/alice/work/my-workspace is already bound to workspace ws_other',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'workspace_provision' },
  },
  {
    name: 'response/workspace_provision-error-fs_quota_exceeded',
    description:
      'Recoverable fs failure during registry write or skeleton create — ENOSPC/EDQUOT mapped to fs_quota_exceeded (same classifier for both stages; Cindy P1-1).',
    frame: enc({
      id: 'req-workspace-provision-1',
      error: {
        code: 'fs_quota_exceeded',
        message: 'ENOSPC: no space left on device, write registry tmp',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'workspace_provision' },
  },
  {
    name: 'response/workspace_provision-error-fs_unavailable',
    description:
      'Recoverable fs failure — EACCES/EPERM/EROFS/ENOENT mapped to fs_unavailable so the route layer can return 503 + retry-after.',
    frame: enc({
      id: 'req-workspace-provision-1',
      error: {
        code: 'fs_unavailable',
        message: 'EACCES: permission denied, mkdir managed workspaces root',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'workspace_provision' },
  },
  {
    name: 'response/workspace_provision-error-registry_unavailable',
    description:
      'Daemon registry is foreign (bound to a different control plane) or corrupt — fail closed; the workspace is NOT bound.',
    frame: enc({
      id: 'req-workspace-provision-1',
      error: {
        code: 'registry_unavailable',
        message:
          'registry is bound to https://other.example.com/host_z, not the current binding',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'workspace_provision' },
  },
  {
    name: 'response/workspace_provision-error-internal_error',
    description:
      'Catch-all for an unrecognized errno (default arm of the shared fs classifier) or an unexpected registry invariant breach.',
    frame: enc({
      id: 'req-workspace-provision-1',
      error: {
        code: 'internal_error',
        message: 'EIO: i/o error during registry rename',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'workspace_provision' },
  },
];

// D4.e-1 agent_workspace_index typed errors. Note: a never-provisioned
// regular workspace is NOT an error — it comes back in `result.unresolved`
// (read fail-closed). The only typed errors are whole-call failures.
const AGENT_WORKSPACE_INDEX_ERROR_FIXTURES: WireFixture[] = [
  {
    name: 'response/agent_workspace_index-error-registry_unavailable',
    description:
      'Daemon registry foreign/corrupt — the whole index call fails typed (not a per-workspace unresolved entry).',
    frame: enc({
      id: 'req-agent-workspace-index-1',
      error: {
        code: 'registry_unavailable',
        message: 'registry file is corrupt: unexpected end of JSON input',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_workspace_index' },
  },
  {
    name: 'response/agent_workspace_index-error-internal_error',
    description:
      'Catch-all for an unexpected failure while resolving agent_dir entries.',
    frame: enc({
      id: 'req-agent-workspace-index-1',
      error: { code: 'internal_error', message: 'unexpected resolver failure' },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_workspace_index' },
  },
];
// #task:811 agent_workspace_tree typed errors. Same taxonomy as the
// sibling agent_workspace_file_read intent (`AgentWorkspaceFsError`):
// forbidden_path / not_found / workspace_not_provisioned /
// registry_unavailable / fs_unavailable / internal_error. The two
// registry codes (#task:1190) only fire for a scoped `workspace_id`;
// the home (unscoped) tree never resolves a registry binding.
// `forbidden_path` here is mostly defensive — the tree handler walks
// from the agent home dir downward and never accepts a caller-supplied
// path — but the wire taxonomy is shared so the renderer can write one
// translation table for both intents.
const AGENT_WORKSPACE_TREE_ERROR_FIXTURES: WireFixture[] = [
  {
    name: 'response/agent_workspace_tree-error-forbidden_path',
    description:
      'A future path-bearing variant (e.g. sub-tree under a virtual path) would surface this when the resolver rejects shape OR detects a symlink in the chain. Today the tree handler walks from the agent home root and this code is reserved for forward-compat.',
    frame: enc({
      id: 'req-agent-workspace-tree-1',
      error: {
        code: 'forbidden_path',
        message: 'path is not a readable subtree under the agent home dir',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_workspace_tree' },
  },
  {
    name: 'response/agent_workspace_tree-error-not_found',
    description:
      'A future path-bearing variant would surface this when an intermediate directory along the requested sub-tree path is missing. Today the tree handler returns `{ nodes: [] }` for a brand-new agent dir gracefully (never an error).',
    frame: enc({
      id: 'req-agent-workspace-tree-1',
      error: { code: 'not_found', message: 'path not found' },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_workspace_tree' },
  },
  {
    name: 'response/agent_workspace_tree-error-workspace_not_provisioned',
    description:
      'A scoped regular workspace id has no daemon registry binding, so the daemon refuses to guess a path rather than silently fall back to the agent home dir. Surfaced when the tree is requested for a workspace_id this daemon has never provisioned (never established on this computer). Maps to HTTP 409 at the route layer.',
    frame: enc({
      id: 'req-agent-workspace-tree-1',
      error: {
        code: 'workspace_not_provisioned',
        message: 'workspace is not provisioned on this daemon',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_workspace_tree' },
  },
  {
    name: 'response/agent_workspace_tree-error-registry_unavailable',
    description:
      'The daemon cannot consult its registry at all (missing control-plane binding, foreign/corrupt registry file) so it cannot resolve any workspace_id. Hard fail, distinct from workspace_not_provisioned (which is retryable). Maps to HTTP 503.',
    frame: enc({
      id: 'req-agent-workspace-tree-1',
      error: {
        code: 'registry_unavailable',
        message: 'daemon registry is unavailable',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_workspace_tree' },
  },
  {
    name: 'response/agent_workspace_tree-error-fs_unavailable',
    description:
      'Host-local readdir/lstat failed hard (perm/IO/EROFS) while walking the agent home dir. Surfaced fail-closed; the daemon never falls back to a server-side path or silently degrades to an empty tree.',
    frame: enc({
      id: 'req-agent-workspace-tree-1',
      error: {
        code: 'fs_unavailable',
        message: "EACCES: permission denied, scandir 'notes'",
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_workspace_tree' },
  },
  {
    name: 'response/agent_workspace_tree-error-internal_error',
    description:
      'Catch-all for an unexpected failure while walking the agent home dir.',
    frame: enc({
      id: 'req-agent-workspace-tree-1',
      error: { code: 'internal_error', message: 'unexpected walk failure' },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_workspace_tree' },
  },
];
// #task:811 agent_workspace_file_read typed errors. The daemon never
// distinguishes "your path was malformed" from "you tried to escape"
// on the wire — both look like `forbidden_path` so a probe can't use
// the error class to enumerate filesystem layout.
const AGENT_WORKSPACE_FILE_READ_ERROR_FIXTURES: WireFixture[] = [
  {
    name: 'response/agent_workspace_file_read-error-forbidden_path',
    description:
      "Caller-supplied path was shape-rejected (empty / leading or trailing `/` / `.` / `..` / dotfile / NUL / backslash) OR resolution would escape the agent home base (symlink in chain, realpath crossed the boundary). Surfaced opaquely: the daemon doesn't tell the client which rule fired so the error class can't be used as a layout probe.",
    frame: enc({
      id: 'req-agent-workspace-file-read-1',
      error: {
        code: 'forbidden_path',
        message: 'path is not a readable file under the agent home dir',
      },
    }),
    kind: {
      kind: 'response_error_typed',
      intent: 'agent_workspace_file_read',
    },
  },
  {
    name: 'response/agent_workspace_file_read-error-not_found',
    description:
      'Graceful missing along the walk (ENOENT/ENOTDIR on a non-leaf, the leaf is a directory when the read endpoint asked for a file, etc).',
    frame: enc({
      id: 'req-agent-workspace-file-read-1',
      error: { code: 'not_found', message: 'path not found' },
    }),
    kind: {
      kind: 'response_error_typed',
      intent: 'agent_workspace_file_read',
    },
  },
  {
    name: 'response/agent_workspace_file_read-error-workspace_not_provisioned',
    description:
      'A scoped regular workspace id has no daemon registry binding, so the daemon refuses to guess a path rather than silently fall back to the agent home dir (never established on this computer). Maps to HTTP 409 at the route layer.',
    frame: enc({
      id: 'req-agent-workspace-file-read-1',
      error: {
        code: 'workspace_not_provisioned',
        message: 'workspace is not provisioned on this daemon',
      },
    }),
    kind: {
      kind: 'response_error_typed',
      intent: 'agent_workspace_file_read',
    },
  },
  {
    name: 'response/agent_workspace_file_read-error-registry_unavailable',
    description:
      'The daemon cannot consult its registry at all (missing control-plane binding, foreign/corrupt registry file) so it cannot resolve any workspace_id. Hard fail, distinct from workspace_not_provisioned (which is retryable). Maps to HTTP 503.',
    frame: enc({
      id: 'req-agent-workspace-file-read-1',
      error: {
        code: 'registry_unavailable',
        message: 'daemon registry is unavailable',
      },
    }),
    kind: {
      kind: 'response_error_typed',
      intent: 'agent_workspace_file_read',
    },
  },
  {
    name: 'response/agent_workspace_file_read-error-fs_unavailable',
    description:
      'Host-local read failed hard (perm/IO/EROFS). Surfaced fail-closed; the daemon never falls back to a server-side path.',
    frame: enc({
      id: 'req-agent-workspace-file-read-1',
      error: {
        code: 'fs_unavailable',
        message: "EACCES: permission denied, open 'system_prompt.md'",
      },
    }),
    kind: {
      kind: 'response_error_typed',
      intent: 'agent_workspace_file_read',
    },
  },
  {
    name: 'response/agent_workspace_file_read-error-internal_error',
    description:
      'Catch-all for an unexpected failure while reading one file from the agent home dir.',
    frame: enc({
      id: 'req-agent-workspace-file-read-1',
      error: { code: 'internal_error', message: 'unexpected read failure' },
    }),
    kind: {
      kind: 'response_error_typed',
      intent: 'agent_workspace_file_read',
    },
  },
];
// D4.e-3 agent_l2_seed typed errors. One per AgentL2SeedErrorCode slot.
const AGENT_L2_SEED_ERROR_FIXTURES: WireFixture[] = [
  {
    name: 'response/agent_l2_seed-error-workspace_not_provisioned',
    description:
      'The workspace has no registry binding (never provisioned / adopted) — fail-closed. The daemon never derives a path from a backend-supplied value, so the L2 seed cannot proceed.',
    frame: enc({
      id: 'req-agent-l2-seed-1',
      error: {
        code: 'workspace_not_provisioned',
        message: 'workspace ws_custom_7 is not provisioned; cannot seed L2',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_l2_seed' },
  },
  {
    name: 'response/agent_l2_seed-error-registry_unavailable',
    description:
      'Whole-registry failure: the registry file is foreign (identity mismatch) or corrupt.',
    frame: enc({
      id: 'req-agent-l2-seed-1',
      error: {
        code: 'registry_unavailable',
        message: 'registry identity mismatch; refusing foreign registry',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_l2_seed' },
  },
  {
    name: 'response/agent_l2_seed-error-unsupported_template',
    description:
      'template_choice is structurally valid (passed the wire enum) but has no host-side L2 entry yet.',
    frame: enc({
      id: 'req-agent-l2-seed-1',
      error: {
        code: 'unsupported_template',
        message: "template 'minimal' has no host-side L2 entry",
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_l2_seed' },
  },
  {
    name: 'response/agent_l2_seed-error-fs_unavailable',
    description:
      'A host-local fs write failed hard (perm/IO/EROFS/ENOSPC) while seeding the L2 dir. Fail-closed; the daemon never falls back to a server-side path.',
    frame: enc({
      id: 'req-agent-l2-seed-1',
      error: {
        code: 'fs_unavailable',
        message: "EACCES: permission denied, mkdir '.silverhand/agents'",
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_l2_seed' },
  },
  {
    name: 'response/agent_l2_seed-error-internal_error',
    description:
      'Catch-all for an unexpected failure while seeding the L2 dir.',
    frame: enc({
      id: 'req-agent-l2-seed-1',
      error: { code: 'internal_error', message: 'unexpected seed failure' },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_l2_seed' },
  },
];
// D4.e-4 agent_files_purge typed errors. One per AgentFilesPurgeErrorCode slot.
const AGENT_FILES_PURGE_ERROR_FIXTURES: WireFixture[] = [
  {
    name: 'response/agent_files_purge-error-partial_purge',
    description:
      'One or more target dirs could not be removed because of a HARD fs error (perm/IO/EROFS/ENOSPC — not ENOENT). Fail-closed (§3.3): the route keeps the DB row so a retry has its routing anchor.',
    frame: enc({
      id: 'req-agent-files-purge-1',
      error: {
        code: 'partial_purge',
        message:
          "failed to remove 1 target(s): /home/.silverhand/agents/aid_FpzaAEM: EACCES: permission denied",
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_files_purge' },
  },
  {
    name: 'response/agent_files_purge-error-registry_unavailable',
    description:
      'Whole-registry failure: the registry file is foreign (identity mismatch) or corrupt, so no L2 path can be safely resolved.',
    frame: enc({
      id: 'req-agent-files-purge-1',
      error: {
        code: 'registry_unavailable',
        message: 'registry identity mismatch; refusing foreign registry',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_files_purge' },
  },
  {
    name: 'response/agent_files_purge-error-internal_error',
    description:
      'Catch-all for an unexpected failure while purging the agent files.',
    frame: enc({
      id: 'req-agent-files-purge-1',
      error: { code: 'internal_error', message: 'unexpected purge failure' },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_files_purge' },
  },
];
// D4.e-6 runtime_start typed errors. The carve-out that let host paths cross
// the runtime_start wire is revoked; the daemon now resolves every host path
// from its registry (regular) / computeAgentDir (agent_home) and fail-closes
// with one of these typed codes when a regular workspace is not bound, a
// resolved host-local path is missing, or the registry is unreadable. One
// fixture per RuntimeStartErrorCode slot.
const RUNTIME_START_ERROR_FIXTURES: WireFixture[] = [
  {
    name: 'response/runtime_start-error-workspace_not_provisioned',
    description:
      'A regular workspace the start references has no registry binding (never established on this computer). The daemon fails closed rather than derive a path from a backend-supplied value; the backend keeps the delivery pending.',
    frame: enc({
      id: 'req-runtime-start-1',
      error: {
        code: 'workspace_not_provisioned',
        message: 'workspace ws_custom_7 is not provisioned on this host',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'runtime_start' },
  },
  {
    name: 'response/runtime_start-error-workspace_path_missing',
    description:
      'A semantic workspace ref resolved on the daemon, but the host-local cwd no longer exists (for example an agent_home created under another SILVERHAND_DIR). The daemon fails before spawn so the user sees a concrete filesystem cause instead of a pid-less child.',
    frame: enc({
      id: 'req-runtime-start-1',
      error: {
        code: 'workspace_path_missing',
        message:
          'runtime_start: resolved agent_home workspace "Cindy" (agent-home:a1) path does not exist: /tmp/local-silverhand/agents/a1',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'runtime_start' },
  },
  {
    name: 'response/runtime_start-error-registry_unavailable',
    description:
      'Whole-registry failure while resolving the start: the registry file is foreign (identity mismatch) or corrupt. Fail-closed.',
    frame: enc({
      id: 'req-runtime-start-1',
      error: {
        code: 'registry_unavailable',
        message: 'registry identity mismatch; refusing foreign registry',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'runtime_start' },
  },
];
// `runtime_deliver` is the sole delivery command and may take the SPAWN arm,
// which runs the same daemon-side path resolver as `runtime_start`. Pin the
// same three typed failures to this intent so a legitimate resolver error can
// never collapse into a taxonomy-drift `internal_error`.
const RUNTIME_DELIVER_ERROR_FIXTURES: WireFixture[] = [
  {
    name: 'response/runtime_deliver-error-workspace_not_provisioned',
    description:
      'The SPAWN arm references a regular workspace not bound in the daemon registry. The backend keeps delivery pending, re-provisions, and retries.',
    frame: enc({
      id: 'req-runtime-deliver-1',
      error: {
        code: 'workspace_not_provisioned',
        message: 'workspace ws_custom_7 is not provisioned on this host',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'runtime_deliver' },
  },
  {
    name: 'response/runtime_deliver-error-workspace_path_missing',
    description:
      'The SPAWN arm resolved a semantic workspace ref, but its host-local directory is missing.',
    frame: enc({
      id: 'req-runtime-deliver-1',
      error: {
        code: 'workspace_path_missing',
        message:
          'runtime_deliver: resolved workspace path does not exist: /tmp/missing',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'runtime_deliver' },
  },
  {
    name: 'response/runtime_deliver-error-registry_unavailable',
    description:
      'The SPAWN arm cannot consult the daemon registry and fails closed.',
    frame: enc({
      id: 'req-runtime-deliver-1',
      error: {
        code: 'registry_unavailable',
        message: 'registry identity mismatch; refusing foreign registry',
      },
    }),
    kind: { kind: 'response_error_typed', intent: 'runtime_deliver' },
  },
];
// #task:1135 agent_profile_mcp_{read,write} typed errors. Both intents share
// the AgentProfileMcpErrorCode set; one fixture per (intent, code) slot so the
// wire-contract catalogue test sees full coverage.
const AGENT_PROFILE_MCP_ERROR_FIXTURES: WireFixture[] = [
  {
    name: 'response/agent_profile_mcp_read-error-invalid_config',
    description:
      'Read does not normally produce invalid_config, but the code is shared across the intent pair; pinned so the wire schema accepts it on the read arm too.',
    frame: enc({
      id: 'req-agent-profile-mcp-read-1',
      error: { code: 'invalid_config', message: 'mcp.json failed schema validation' },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_profile_mcp_read' },
  },
  {
    name: 'response/agent_profile_mcp_read-error-fs_unavailable',
    description:
      'Hard fs error reading mcp.json (perm/IO — not ENOENT, which maps to raw:null success).',
    frame: enc({
      id: 'req-agent-profile-mcp-read-1',
      error: { code: 'fs_unavailable', message: 'EACCES: permission denied, open mcp.json' },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_profile_mcp_read' },
  },
  {
    name: 'response/agent_profile_mcp_read-error-internal_error',
    description: 'Catch-all for an unexpected failure reading the profile MCP config.',
    frame: enc({
      id: 'req-agent-profile-mcp-read-1',
      error: { code: 'internal_error', message: 'unexpected read failure' },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_profile_mcp_read' },
  },
  {
    name: 'response/agent_profile_mcp_write-error-invalid_config',
    description:
      'Write re-validates fail-loud: a payload that fails the canonical schema is rejected and nothing is persisted.',
    frame: enc({
      id: 'req-agent-profile-mcp-write-1',
      error: { code: 'invalid_config', message: 'invalid mcp config: mcpServers.fs: unrecognized key "bogus"' },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_profile_mcp_write' },
  },
  {
    name: 'response/agent_profile_mcp_write-error-fs_unavailable',
    description: 'Hard fs error during the atomic tmp-write + rename of mcp.json.',
    frame: enc({
      id: 'req-agent-profile-mcp-write-1',
      error: { code: 'fs_unavailable', message: 'ENOSPC: no space left on device' },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_profile_mcp_write' },
  },
  {
    name: 'response/agent_profile_mcp_write-error-internal_error',
    description: 'Catch-all for an unexpected failure writing the profile MCP config.',
    frame: enc({
      id: 'req-agent-profile-mcp-write-1',
      error: { code: 'internal_error', message: 'unexpected write failure' },
    }),
    kind: { kind: 'response_error_typed', intent: 'agent_profile_mcp_write' },
  },
];
// #task:1137 mcp_probe typed errors. Only host-local faults are errors —
// connection/handshake/tools failures are part of the McpProbeResult body
// (ok:false + phase), never a typed IPC error.
const MCP_PROBE_ERROR_FIXTURES: WireFixture[] = [
  {
    name: 'response/mcp_probe-error-fs_unavailable',
    description:
      'Hard fs error reading the source mcp.json (perm/IO — ENOENT maps to a not_found result, not an error).',
    frame: enc({
      id: 'req-mcp-probe-1',
      error: { code: 'fs_unavailable', message: 'EACCES: permission denied, open mcp.json' },
    }),
    kind: { kind: 'response_error_typed', intent: 'mcp_probe' },
  },
  {
    name: 'response/mcp_probe-error-internal_error',
    description: 'Catch-all for an unexpected host failure setting up the probe.',
    frame: enc({
      id: 'req-mcp-probe-1',
      error: { code: 'internal_error', message: 'unexpected probe failure' },
    }),
    kind: { kind: 'response_error_typed', intent: 'mcp_probe' },
  },
];
RESPONSES_ERROR_TYPED.push(
  ...WORKSPACE_PROVISION_ERROR_FIXTURES,
  ...AGENT_WORKSPACE_INDEX_ERROR_FIXTURES,
  ...AGENT_WORKSPACE_TREE_ERROR_FIXTURES,
  ...AGENT_WORKSPACE_FILE_READ_ERROR_FIXTURES,
  ...AGENT_L2_SEED_ERROR_FIXTURES,
  ...AGENT_FILES_PURGE_ERROR_FIXTURES,
  ...AGENT_PROFILE_MCP_ERROR_FIXTURES,
  ...MCP_PROBE_ERROR_FIXTURES,
  ...RUNTIME_START_ERROR_FIXTURES,
  ...RUNTIME_DELIVER_ERROR_FIXTURES,
);

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
      protocol_version: 9,
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
    name: 'event/runtime_delivery_consumed',
    description:
      '#task:1417 Stage 2 — unified delivery ack: daemon wrote a runtime_deliver batch to stdin (init-proven for requires_first_message). Backend markDelivered. Sole mover of delivered_at.',
    frame: enc({
      event: 'runtime_delivery_consumed',
      conversation_id: C,
      agent_id: A,
      delivery_ids: DELIVERY_IDS,
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_delivery_failed-child_exit',
    description:
      '#task:1417 Stage 2 — unified delivery rollback: child exited before the runtime_deliver batch drained. Backend rolls rows back to pending.',
    frame: enc({
      event: 'runtime_delivery_failed',
      conversation_id: C,
      agent_id: A,
      delivery_ids: DELIVERY_IDS,
      reason: 'child_exit',
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_delivery_failed-init_watchdog',
    description:
      '#task:1417 Stage 2 — unified delivery rollback: init watchdog fired before the driver proved the turn landed (mirrors the legacy startup_delivery init_watchdog arm; kept so consumers see every reason variant).',
    frame: enc({
      event: 'runtime_delivery_failed',
      conversation_id: C,
      agent_id: A,
      delivery_ids: DELIVERY_IDS,
      reason: 'init_watchdog',
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_delivery_failed-write_failed',
    description:
      '#task:1417 Stage 2 — unified delivery rollback: stdin write failed mid-batch.',
    frame: enc({
      event: 'runtime_delivery_failed',
      conversation_id: C,
      agent_id: A,
      delivery_ids: DELIVERY_IDS,
      reason: 'write_failed',
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_delivery_failed-driver_refused',
    description:
      '#task:1417 Stage 2 — unified delivery fatal: driver refused the encoded payload after claiming ready (programming error).',
    frame: enc({
      event: 'runtime_delivery_failed',
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
    name: 'event/runtime_parsed_event-input_lifecycle',
    description:
      'ParsedEvent fanout — per-payload input lifecycle echoed by the runtime (#task:1557).',
    frame: enc({
      event: 'runtime_parsed_event',
      conversation_id: C,
      agent_id: A,
      parsed: { kind: 'input_lifecycle', commandUuid: 'uuid-42', state: 'started' },
      ts: TS,
    }),
    kind: { kind: 'event' },
  },
  {
    name: 'event/runtime_parsed_event-api_response',
    description:
      'ParsedEvent fanout — normalized provider/API response notice (#task:1582): driver-recognized status + message only, never raw payloads.',
    frame: enc({
      event: 'runtime_parsed_event',
      conversation_id: C,
      agent_id: A,
      parsed: {
        kind: 'api_response',
        status: 'waiting',
        message: 'Qoder model request queued (queue size 3)',
      },
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
