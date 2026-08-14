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
import { isWorkspacePlaced } from '@silverhand/shared';
import type { AgentRepo } from '../../repos/agent-repo.js';
import type { WorkspaceRepo } from '../../repos/workspace-repo.js';
import type { TaskConversationAccessPort } from './ports.js';
import {
  failClaim,
  type AgentActor,
  type WorkspaceSelector,
} from './contracts.js';

export interface TaskAccessControlDeps {
  agents: AgentRepo;
  conversations: TaskConversationAccessPort;
  workspaces: WorkspaceRepo;
}

export class TaskAccessControl {
  private readonly agents: AgentRepo;
  private readonly conversations: TaskConversationAccessPort;
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
    // Placement-aware participation (the canonical port, NOT the roster-shaped
    // getAgent): identical for workspace placements, and the agent's own inbox
    // frame — which deliberately has no roster row — is a legal frame.
    if (!this.conversations.isAgentParticipant(actor.conversationId, actor.agentId)) {
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
    if (!this.conversations.isAgentParticipant(actor.conversationId, actor.agentId)) {
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
      // No selector ⇒ the default board is the SOURCE conversation's own
      // workspace. A placement without one has no default (§4.2: the agent
      // inbox has no board), which is a typed failure rather than an assertion
      // here because this resolver's whole job is turning "no workspace could be
      // resolved" into an actionable answer for the agent — the same code the
      // deleted-workspace case below returns, with its own reason.
      if (!isWorkspacePlaced(sourceConv)) {
        return {
          failure: fail({
            code: 'unknown_workspace',
            reason:
              'current conversation belongs to no workspace, so it has no task board; ' +
              'pass --workspace-id to name one',
          }),
        };
      }
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
}
