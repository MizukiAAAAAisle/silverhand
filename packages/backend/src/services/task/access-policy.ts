// TaskAccessPolicy — the ONE task-visibility authority for the AGENT lane
// (#task:2018, agent-scoped-session-v1 §4.4/§4.5).
//
// A task's ACL derives from ITS OWN conversation, never from its board: a
// WorkspaceBoard aggregates conversations with different member sets, so
// "can read the workspace" must never disclose another conversation's tasks
// (Board is a numbering namespace + aggregate view, not an ACL unit).
//
// The policy is the conjunction of two axes:
//
//   1. PARTICIPATION (task axis) — the actor participates in the task's
//      conversation. Authority = the placement-aware `isAgentParticipant`
//      port method, whose SQL twin `agentParticipates` gates the list/query
//      faces. Public discovery does NOT grant task read (mirrors the human
//      authority `USER_VISIBLE_TASK_PREDICATE`, which is conversation
//      membership only): a public channel's tasks are as invisible to a
//      non-participant as a private channel's.
//   2. CAPABILITY (board axis) — the verb's own capability in the task's
//      workspace, via the injected checker (which carries the agent_home
//      owner implicit-authority arm). P0-f extends THIS policy with the
//      DirectPair placement arm; no second flow may re-derive either axis.
//
// Disclosure contract (§4.5): when a task is addressed by GLOBAL id, a
// failure of EITHER axis must be reported exactly like "no such task" —
// a typed capability error would leak that the id exists and where it lives.
// (By-NUMBER addressing keeps its typed board errors: those address the
// board the CALLER itself named, not the task.)
import type { AgentCapability } from '@silverhand/shared';
import type { AgentCapabilityChecker } from './contracts.js';
import type { AgentActor, TaskConversationAccessPort } from './ports.js';

/** The minimal task coordinates the policy judges — satisfied by both
 *  `ResolvedTaskRow` and the joined summary row. `workspace_id` is null for
 *  DirectPair-board tasks (P0-f). */
export interface TaskAccessCoordinates {
  conversation_id: string;
  workspace_id: string | null;
}

export class TaskAccessPolicy {
  constructor(
    private readonly conversations: Pick<TaskConversationAccessPort, 'isAgentParticipant'>,
    private readonly canUseCapability: AgentCapabilityChecker,
  ) {}

  /**
   * May `actor` see / act on this task with `capability`?
   *
   * Callers on the GLOBAL-id path map `false` to the indistinguishable
   * `task_not_found`; callers on the by-number path apply the participation
   * axis through the same port (the repo read gate) and keep their typed
   * board-level capability errors.
   *
   * The capability axis is PLACEMENT-BRANCHED (P0-f): a workspace board keeps
   * the workspace capability table; a DirectPair task has no workspace and no
   * capability rows — participation IS the authority (the P0-b "no workspace
   * ⇒ owner self-authority" precedent: an endpoint holds every capability on
   * its own private line), so the participation check above is the whole
   * decision there. Board identity is never consulted on either arm.
   */
  canAgentSeeTask(
    actor: AgentActor,
    task: TaskAccessCoordinates,
    capability: AgentCapability,
  ): boolean {
    if (!this.conversations.isAgentParticipant(task.conversation_id, actor.agentId)) {
      return false;
    }
    if (task.workspace_id === null) return true;
    return this.canUseCapability(actor, task.workspace_id, capability);
  }
}
