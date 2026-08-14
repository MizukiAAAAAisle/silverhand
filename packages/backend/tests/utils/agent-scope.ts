import { randomBytes } from 'node:crypto';
import { agentRuntimePrincipal } from '../../src/auth/runtime-principal.js';
import type { TestApp } from './app.js';

/** An agent row with `session_scope='agent'` — the product creation path for
 *  agent-scoped Agents is P2's runtime lane; route/service tests that need a
 *  live AgentSlot principal insert the row directly (cloning an API-created
 *  agent keeps every FK satisfied) and the v70 trigger auto-provisions its
 *  agent-scope runtime slot. The one native INSERT is ledgered in
 *  `tests/db-boundary/inventory.ts`. */
export function insertAgentScopedAgent(t: TestApp, sourceAgentId: string, name: string): string {
  const id = randomBytes(12).toString('base64url');
  t.ctx.db
    .prepare(
      `INSERT INTO agents (id, name, runtime, model, host_id, description,
                           created_at, updated_at, display_name, reasoning_effort,
                           fast_mode, created_by_user_id, avatar_storage_key,
                           avatar_content_type, materialization_status,
                           materialization_failed_code, materialization_failed_at,
                           idempotency_key, session_scope)
       SELECT ?, ?, runtime, model, host_id, description,
              created_at, updated_at, ?, reasoning_effort,
              fast_mode, created_by_user_id, NULL,
              NULL, 'active',
              NULL, NULL,
              NULL, 'agent'
         FROM agents WHERE id = ?`,
    )
    .run(id, name, name, sourceAgentId);
  return id;
}

/** A live agent-slot bearer: claim the (trigger-provisioned) agent-scope slot
 *  generation for the test daemon, then issue the principal token. */
export function agentSlotAuth(
  t: TestApp,
  agentId: string,
  daemonInstanceId = 'test-daemon',
): { authorization: string } {
  let slot = t.persistence.repos.runtimeSlots.getAgent(agentId);
  if (!slot) throw new Error('agent-scope slot missing (v70 trigger)');
  if (slot.claimed_by_daemon_instance_id === null) {
    slot = t.persistence.repos.runtimeSlots.claimGeneration({
      scope: { kind: 'agent', agentId },
      daemonInstanceId,
    });
  }
  if (!slot) throw new Error('agent-scope slot claim failed');
  const token = t.ctx.agentTokens.issue(
    agentRuntimePrincipal({
      agentId,
      generation: slot.generation,
      daemonInstanceId: slot.claimed_by_daemon_instance_id ?? daemonInstanceId,
    }),
  );
  return { authorization: `Bearer ${token}` };
}

/** Canonical (agent-rooted) route family — the P1 mount. */
export function canonicalTasksPath(agentId: string, conversationId: string, suffix = ''): string {
  return `/internal/agents/${agentId}/conversations/${conversationId}/tasks${suffix}`;
}
