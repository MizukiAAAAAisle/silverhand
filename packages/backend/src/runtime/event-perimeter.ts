// D4.c C5 — runtime ingress perimeter guard for the outbound fanout.
//
// An inbound daemon event claims "agent A on conversation C (in host X)
// just produced event E". Before the fanout mutates any per-host runtime
// state or dispatches the event into projection / DB / SSE, this guard
// validates that the claimed (agent, conversation) actually belong to the
// connecting host. It is pure read-only policy over the repos and fails
// closed — it owns no fanout runtime state, so the fanout core is
// guaranteed to only ever see already-authenticated events.
import type { OutboundDaemonToServerEventFrame } from '@silverhand/host';
import type { BackendLogger } from '../context.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';

export interface EventPerimeterGuardDeps {
  agents: AgentRepo;
  conversations: ConversationRepo;
  logger: BackendLogger;
}

export class EventPerimeterGuard {
  private readonly agents: AgentRepo;
  private readonly conversations: ConversationRepo;
  private readonly logger: BackendLogger;

  constructor(deps: EventPerimeterGuardDeps) {
    this.agents = deps.agents;
    this.conversations = deps.conversations;
    this.logger = deps.logger;
  }

  /**
   * D4.c C5 — runtime perimeter check. Returns `true` when the
   * event is allowed to proceed into per-host state mutation
   * + dispatch; `false` after logging and dropping a mismatch.
   *
   * Daemon-level frames (no `agent_id` — currently `ready` and
   * `shutting_down`) are owned by the connection's hostId by
   * construction and always pass. Future daemon-level event
   * kinds without `agent_id` will be admitted automatically.
   *
   * Per-agent frames are runtime claims — daemon X is asserting
   * "agent A on conversation C just produced event E". The full
   * runtime pair claim must hold against the server's DB state,
   * otherwise host X could (a) emit events for someone else's
   * agent, OR (b) emit events using its own agent but TARGETING
   * a conversation that agent is not a member of, leaking
   * projections / DB writes / SSE into another tenant. Cindy
   * `dgCAVQ3fbHoOFvvN` P1 was the second arm: a previous version
   * only checked `agent.host_id` which left the
   * `(agent_id == mine, conversation_id == theirs)` shape uncovered.
   *
   * Cross-computer slice 2 (#task:1600): the old fourth arm —
   * `workspace.workspace_host_id === hostId` — is GONE. A workspace's
   * members may now legitimately run on other computers, so workspace-host
   * equality is no longer a fact the perimeter may assume. The security
   * boundary is fully carried by the two remaining per-agent arms:
   * `agent.host_id === hostId` proves the connecting daemon owns the
   * claimed agent, and conversation membership proves that agent may
   * target the claimed conversation. Together they still exclude both
   * hostile shapes above.
   *
   * Validation chain (short-circuited; first failure wins):
   *
   *   1. `agents.get(agent_id)` exists.
   *      → fail: drop, log `outbound_event_unknown_agent`.
   *   2. `agent.host_id === hostId`.
   *      → fail: drop, log `outbound_event_perimeter_mismatch`
   *        with `reason: 'agent_host_mismatch'`.
   *   3. `conversations.get(conversation_id)` exists.
   *      → fail: drop, log `outbound_event_perimeter_mismatch`
   *        with `reason: 'conversation_unknown'`.
   *   4. `conversations.getAgent(conversation_id, agent_id)`
   *      exists (i.e. the (cid, aid) pair is in `conversation_agents`).
   *      → fail: drop, log `outbound_event_perimeter_mismatch`
   *        with `reason: 'agent_not_in_conversation'`.
   *
   * We keep `outbound_event_unknown_agent` as a separate warn
   * action because "host references a non-existent agent" is a
   * different operational signal (likely DB rollback / migration
   * skew) from "host crossed the runtime boundary".
   *
   * We deliberately do NOT close the WS on any of these. A single
   * bad frame may be a transient bug (race / refactor glitch);
   * kicking the socket would also break the host's legitimate
   * runtimes. Anti-abuse rate-counting is out of scope (D5 / T2).
   */
  assert(hostId: string, event: OutboundDaemonToServerEventFrame): boolean {
    if (!('agent_id' in event)) {
      // Daemon-level frame — owned by the connection's hostId by
      // construction (no per-agent target), admitted.
      return true;
    }
    const agent = this.agents.get(event.agent_id);
    if (!agent) {
      this.logger.warn(
        {
          connectionHostId: hostId,
          agentId: event.agent_id,
          eventKind: event.kind,
          action: 'outbound_event_unknown_agent',
        },
        'outbound event references unknown agent — dropped (D4.c C5 perimeter)',
      );
      return false;
    }
    if (agent.host_id !== hostId) {
      this.logger.warn(
        {
          connectionHostId: hostId,
          agentId: event.agent_id,
          agentHostId: agent.host_id,
          eventKind: event.kind,
          reason: 'agent_host_mismatch',
          action: 'outbound_event_perimeter_mismatch',
        },
        'outbound event from host A references agent owned by host B — dropped (D4.c C5 perimeter)',
      );
      return false;
    }
    // Per-agent frames carry conversation_id by schema construction
    // (every OutboundDaemonToServerEventFrame variant with
    // `agent_id` also has `conversation_id`). A missing field
    // here would be a schema bug.
    const conversationId = (event as { conversation_id: string }).conversation_id;
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      this.logger.warn(
        {
          connectionHostId: hostId,
          agentId: event.agent_id,
          conversationId,
          eventKind: event.kind,
          reason: 'conversation_unknown',
          action: 'outbound_event_perimeter_mismatch',
        },
        'outbound event references unknown conversation — dropped (D4.c C5 perimeter)',
      );
      return false;
    }
    if (!this.conversations.getAgent(conversationId, event.agent_id)) {
      this.logger.warn(
        {
          connectionHostId: hostId,
          agentId: event.agent_id,
          conversationId,
          eventKind: event.kind,
          reason: 'agent_not_in_conversation',
          action: 'outbound_event_perimeter_mismatch',
        },
        'outbound event claims an agent that is not a member of the conversation — dropped (D4.c C5 perimeter)',
      );
      return false;
    }
    return true;
  }
}
