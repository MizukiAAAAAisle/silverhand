import { randomBytes } from 'node:crypto';
import { agentRuntimePrincipal } from '../../src/auth/runtime-principal.js';
import { conversationSlotTestPath, type TestApp } from './app.js';

/** An agent row with `session_scope='agent'` — the product creation path for
 *  agent-scoped Agents is P2's runtime lane; route/service tests that need a
 *  live AgentSlot principal insert the row directly (cloning an API-created
 *  agent keeps every FK satisfied) and the v70 trigger auto-provisions its
 *  agent-scope runtime slot. The one native INSERT is ledgered in
 *  `tests/db-boundary/inventory.ts`.
 *
 *  The inbox is provisioned through the repo, in the same order
 *  `reserveAgentAggregate` uses: an AgentInbox is an INVARIANT of an `agents`
 *  row, not an optional extra, so a twin without one is a shape the product
 *  never produces — and a test standing on it (an inbox-anchored session, an
 *  inbox as a delivery target) would be testing a fiction. */
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
  t.persistence.repos.conversations.insertAgentInbox(id, Date.now());
  return id;
}

/** A live agent-slot bearer TOKEN: claim the (trigger-provisioned) agent-scope
 *  slot generation for the test daemon, then issue the principal token. Callers
 *  that speak HTTP want {@link agentSlotAuth}; the raw string is for the ones that
 *  hand a credential to a subprocess (`SILVERHAND_AUTH_TOKEN`). */
export function agentSlotToken(
  t: TestApp,
  agentId: string,
  daemonInstanceId = 'test-daemon',
): string {
  let slot = t.persistence.repos.runtimeSlots.getAgent(agentId);
  if (!slot) throw new Error('agent-scope slot missing (v70 trigger)');
  if (slot.claimed_by_daemon_instance_id === null) {
    slot = t.persistence.repos.runtimeSlots.claimGeneration({
      scope: { kind: 'agent', agentId },
      daemonInstanceId,
    });
  }
  if (!slot) throw new Error('agent-scope slot claim failed');
  return t.ctx.agentTokens.issue(
    agentRuntimePrincipal({
      agentId,
      generation: slot.generation,
      daemonInstanceId: slot.claimed_by_daemon_instance_id ?? daemonInstanceId,
    }),
  );
}

/** The same bearer as an `authorization` header, ready for `http(t, auth)`. */
export function agentSlotAuth(
  t: TestApp,
  agentId: string,
  daemonInstanceId = 'test-daemon',
): { authorization: string } {
  return {
    authorization: `Bearer ${agentSlotToken(t, agentId, daemonInstanceId)}`,
  };
}

/** Canonical (agent-rooted) route family — the P1 mount. */
export function canonicalTasksPath(agentId: string, conversationId: string, suffix = ''): string {
  const base = conversationSlotTestPath(
    `/internal/agents/${agentId}/tasks`,
    conversationId,
  );
  return `${base}${suffix}`;
}
