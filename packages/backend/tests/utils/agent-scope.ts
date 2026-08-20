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
 *  It provisions the agent ROW and nothing beside it, which is what the product
 *  path does since #task:2072 retired `agent_inbox`: an agent-scoped agent's
 *  destinations are the direct pairs its correspondents open with it. */
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

/** Enqueue one UNDELIVERED inbox row for `agentId` in `conversationId` — the
 *  freshness miss under the RuntimeScope model (#task:2095): the runtime holds
 *  input it has not yet consumed, so its next send is stale. Writes straight
 *  through the repos (NOT the delivery coordinator) so the row deterministically
 *  stays `delivered_at IS NULL`. The message's author is immaterial — the guard
 *  keys on the RECIPIENT's undelivered set — so it is authored as the agent
 *  itself to keep the FK trivially satisfied. Repo-method only (no native SQL),
 *  so it adds no db-boundary ledger row. Returns the enqueued message id. */
export function enqueueUndeliveredInput(
  t: TestApp,
  conversationId: string,
  agentId: string,
  content = 'undelivered input',
): string {
  const message = t.persistence.repos.messages.insertForConversation({
    conversationId,
    fromKind: 'agent',
    fromAgentId: agentId,
    content,
  });
  t.persistence.repos.conversationInboxes.enqueue(
    conversationId,
    agentId,
    message.id,
  );
  return message.id;
}

/** Drain every undelivered inbox row for `agentId` in `conversationId` —
 *  claim + settle-delivered, the repo path a real delivery takes — so the
 *  freshness guard's `EXISTS` probe goes false and the runtime's next send is
 *  admitted. The runtime-facing analogue is a completed `stale-receive`. Repo-
 *  method only, so it adds no db-boundary ledger row. */
export function drainInput(
  t: TestApp,
  conversationId: string,
  agentId: string,
  inFlightOwner = 'test-drain',
): void {
  const claimed = t.persistence.repos.conversationInboxes.claimPending(
    conversationId,
    agentId,
    inFlightOwner,
  );
  if (claimed.length === 0) return;
  t.persistence.repos.conversationInboxes.settleDelivered({
    conversationId,
    agentId,
    inFlightOwner,
    inboxIds: claimed.map(c => c.inboxId),
  });
}

/** Canonical (agent-rooted) route family — the P1 mount. */
export function canonicalTasksPath(agentId: string, conversationId: string, suffix = ''): string {
  const base = conversationSlotTestPath(
    `/internal/agents/${agentId}/tasks`,
    conversationId,
  );
  return `${base}${suffix}`;
}
