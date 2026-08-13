import type { OutboundServerCommandKind } from './outbound-protocol.js';
import type { IntentName } from './protocol.js';

/**
 * Exhaustive command-effect catalogue for the agent-home deletion fence.
 *
 * This is deliberately shared by the backend admission gate and the daemon
 * dispatcher. Adding a command to either wire surface without classifying it
 * is therefore a compile error, rather than another hand-maintained writer
 * list that can silently omit a new host-local mutator.
 */
export type AgentHomeCommandEffect =
  | 'none'
  | 'read_only'
  | 'runtime_control'
  | 'runtime_mutator'
  | 'bounded_mutator'
  | 'purge';

export type AgentHomeCommandKind = IntentName | OutboundServerCommandKind;

const AGENT_HOME_COMMAND_EFFECTS = {
  hello: 'none',
  ping: 'none',
  status: 'none',
  echo: 'none',
  host_status: 'none',
  host_runtime_catalog: 'none',
  conversation_log_debug: 'none',
  agent_message_send: 'runtime_control',
  agent_stale_resolve: 'runtime_control',
  agent_stream_observed: 'runtime_control',
  // Pulling a stale batch transfers daemon-held delivery custody and may
  // persist last-delivered state after the response handoff. Dispatcher
  // admission alone is insufficient, so Supervisor also gates the queue
  // splice under its lifecycle lock and quiesce awaits settlement.
  agent_stale_receive: 'bounded_mutator',
  runtime_start: 'runtime_mutator',
  runtime_stop: 'runtime_control',
  runtime_deliver: 'runtime_mutator',
  runtime_status: 'runtime_control',
  runtime_clear_session: 'runtime_control',
  runtime_stop_all: 'runtime_control',
  runtime_close_activity_log: 'runtime_control',
  runtime_output_pause: 'runtime_control',
  runtime_output_resume: 'runtime_control',
  host_outbound_attach: 'none',
  host_outbound_detach: 'none',
  host_outbound_reload: 'none',
  host_proxy_config_get: 'none',
  host_proxy_config_set: 'none',
  rotate_token: 'none',
  agent_materialize: 'bounded_mutator',
  agent_workspace_index: 'read_only',
  agent_workspace_tree: 'read_only',
  agent_workspace_file_read: 'read_only',
  agent_l2_seed: 'bounded_mutator',
  agent_files_purge: 'purge',
  agent_profile_mcp_read: 'read_only',
  agent_profile_mcp_write: 'bounded_mutator',
  // The probe reads config but may run a user-configured child process. Keep
  // it inside the bounded barrier so purge waits for its finally/close path.
  mcp_probe: 'bounded_mutator',
} as const satisfies Record<AgentHomeCommandKind, AgentHomeCommandEffect>;

export function agentHomeCommandEffect(
  kind: AgentHomeCommandKind,
): AgentHomeCommandEffect {
  return AGENT_HOME_COMMAND_EFFECTS[kind];
}

export function isAgentHomeMutatorEffect(
  effect: AgentHomeCommandEffect,
): boolean {
  return effect === 'runtime_mutator' || effect === 'bounded_mutator';
}

/** Return the semantic agent id when this command is agent-scoped. */
export function commandAgentId(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null;
  const direct = (params as { agent_id?: unknown }).agent_id;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  // `mcp_probe` scopes the agent beneath its discriminated `source` object.
  // Keep the projection centralized with the effect catalogue: both backend
  // admission and daemon in-flight accounting must derive the same fence key.
  const source = (params as { source?: unknown }).source;
  if (typeof source !== 'object' || source === null) return null;
  const nested = (source as { agent_id?: unknown }).agent_id;
  return typeof nested === 'string' && nested.length > 0 ? nested : null;
}
