// Pre-transaction authorization for agent task ops: actor validity + channel
// membership, workspace-selector resolution (the `--workspace-id` / `--workspace`
// namespace targeting), and message-id access pinning. All checks run BEFORE the
// mutation transaction; the facade consumes their typed failure envelopes and
// resolved workspace ids. No row writes happen here.
import type {
  ClaimResultEntry,
  ConversationDto,
  TaskMutationResult,
  WorkspaceDto,
} from '@silverhand/shared';
import type { AgentRepo } from '../../repos/agent-repo.js';
import type { ConversationRepo } from '../../repos/conversation-repo.js';
import type { WorkspaceRepo } from '../../repos/workspace-repo.js';
import {
  failClaim,
  type AgentActor,
  type ResolvedMessageRow,
  type WorkspaceSelector,
} from './contracts.js';

export interface TaskAccessControlDeps {
  agents: AgentRepo;
  conversations: ConversationRepo;
  workspaces: WorkspaceRepo;
}

export class TaskAccessControl {
  private readonly agents: AgentRepo;
  private readonly conversations: ConversationRepo;
  private readonly workspaces: WorkspaceRepo;

  constructor(deps: TaskAccessControlDeps) {
    this.agents = deps.agents;
    this.conversations = deps.conversations;
    this.workspaces = deps.workspaces;
  }

  validateAgentActorForClaim(actor: AgentActor): ClaimResultEntry | undefined {
    if (!this.agents.get(actor.agentId)) {
      return failClaim({ code: 'agent_not_found', reason: 'agent not found' });
    }
    if (!this.conversations.getAgent(actor.conversationId, actor.agentId)) {
      return failClaim({
        code: 'not_conversation_member',
        reason: 'agent is not a member of this conversation',
      });
    }
    return undefined;
  }

  validateAgentActorForMutation(
    actor: AgentActor,
  ): TaskMutationResult | undefined {
    if (!this.agents.get(actor.agentId)) {
      return { success: false, code: 'agent_not_found', reason: 'agent not found' };
    }
    if (!this.conversations.getAgent(actor.conversationId, actor.agentId)) {
      return {
        success: false,
        code: 'not_conversation_member',
        reason: 'agent is not a member of this conversation',
      };
    }
    return undefined;
  }

  /** True iff the agent counts as a member of the workspace for the
   *  purposes of task ops. `agent_home` workspaces have an implicit
   *  membership (owner_agent_id === agent.id); every other kind goes
   *  through the `workspace_members` table. Mirrors the union in
   *  `WorkspaceRepo.listForAgent`. */
  isAgentWorkspaceMember(ws: WorkspaceDto, agentId: string): boolean {
    if (ws.workspace_kind === 'agent_home') {
      return ws.owner_agent_id === agentId;
    }
    return this.workspaces.isMember(ws.id, agentId);
  }

  /** Resolve the workspace whose `task_number` namespace the agent op
   *  should target. Returns:
   *  - `{ workspace }` on success
   *  - `{ failure }` envelope using the supplied builder when the
   *    selector is ambiguous / missing / unauthorized
   *
   *  Callers pass a `fail` builder so the same logic can produce either
   *  `ClaimResultEntry` (claim) or `TaskMutationResult` (unclaim /
   *  status) shapes without leaking shape knowledge here. */
  resolveAgentTaskWorkspace<F>(
    actor: AgentActor,
    sourceConv: ConversationDto,
    selector: WorkspaceSelector | undefined,
    fail: (args: {
      code: 'unknown_workspace' | 'ambiguous_workspace' | 'workspace_membership_required';
      reason: string;
      candidates?: string[];
    }) => F,
  ): { workspace: WorkspaceDto } | { failure: F } {
    // Schema enforces XOR but defend against an out-of-band call.
    if (selector?.workspaceId && selector?.workspaceName) {
      return {
        failure: fail({
          code: 'unknown_workspace',
          reason: 'workspace_id and workspace_name are mutually exclusive',
        }),
      };
    }

    let ws: WorkspaceDto | null = null;
    if (selector?.workspaceId) {
      ws = this.workspaces.get(selector.workspaceId);
      if (!ws) {
        return {
          failure: fail({
            code: 'unknown_workspace',
            reason: `workspace ${selector.workspaceId} not found`,
          }),
        };
      }
    } else if (selector?.workspaceName) {
      const matches = this.workspaces.findAllByName(selector.workspaceName);
      if (matches.length === 0) {
        return {
          failure: fail({
            code: 'unknown_workspace',
            reason: `no workspace named "${selector.workspaceName}"`,
          }),
        };
      }
      if (matches.length > 1) {
        return {
          failure: fail({
            code: 'ambiguous_workspace',
            reason:
              `${matches.length} workspaces named "${selector.workspaceName}"; ` +
              'disambiguate with --workspace-id',
            candidates: matches.map(m => m.id),
          }),
        };
      }
      ws = matches[0]!;
    } else {
      ws = this.workspaces.get(sourceConv.workspace_id);
      if (!ws) {
        // Source conversation exists but its workspace was deleted —
        // should be impossible given FK, but fail clean instead of
        // crashing.
        return {
          failure: fail({
            code: 'unknown_workspace',
            reason: 'current conversation workspace not found',
          }),
        };
      }
    }

    if (!this.isAgentWorkspaceMember(ws, actor.agentId)) {
      return {
        failure: fail({
          code: 'workspace_membership_required',
          reason: `agent is not a member of workspace ${ws.id}`,
        }),
      };
    }
    return { workspace: ws };
  }

  /** Validate that the agent may operate on a task identified by
   *  message id. Returns the message's actual `task_workspace_id` on
   *  success. Per Cindy `zJ4xdGu3uEo68_k7` + `YreWED1qOBStvZxG`:
   *  - The row's workspace is `msg.task_workspace_id` (NOT the
   *    selector-resolved one).
   *  - Membership of that workspace is always required, even when no
   *    selector was passed — otherwise a leaked message id would let
   *    a non-member mutate the task.
   *  - If a selector WAS passed and resolves to a different workspace,
   *    we return `task_not_found` so the caller can't infer existence
   *    of the row outside their authorized scope.
   *
   *  Callers wrap the failure into their own envelope (ClaimResultEntry
   *  vs TaskMutationResult). */
  validateMessageIdAccess(
    actor: AgentActor,
    msg: ResolvedMessageRow,
    selector: WorkspaceSelector | undefined,
  ):
    | { ok: true; workspaceId: string }
    | { failure: 'task_not_found' | 'workspace_membership_required'; reason: string } {
    if (msg.task_number === null || msg.task_workspace_id === null) {
      // Caller should only invoke this for already-numbered tasks.
      // Treat as not-a-task so the failure surfaces cleanly.
      return { failure: 'task_not_found', reason: 'message is not a task' };
    }
    const rowWorkspaceId = msg.task_workspace_id;
    if (selector?.workspaceId && selector.workspaceId !== rowWorkspaceId) {
      return {
        failure: 'task_not_found',
        reason: 'task not found in the specified workspace',
      };
    }
    if (selector?.workspaceName) {
      const matches = this.workspaces.findAllByName(selector.workspaceName);
      const ids = new Set(matches.map(m => m.id));
      if (!ids.has(rowWorkspaceId)) {
        return {
          failure: 'task_not_found',
          reason: 'task not found in the specified workspace',
        };
      }
    }
    const targetWs = this.workspaces.get(rowWorkspaceId);
    if (!targetWs) {
      return { failure: 'task_not_found', reason: 'task workspace not found' };
    }
    if (!this.isAgentWorkspaceMember(targetWs, actor.agentId)) {
      return {
        failure: 'workspace_membership_required',
        reason: `agent is not a member of workspace ${targetWs.id}`,
      };
    }
    return { ok: true, workspaceId: rowWorkspaceId };
  }
}
