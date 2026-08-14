// Capability enforcement for an act performed INSIDE a conversation whose
// placement may have no workspace (agent-scoped-session-v1 §4.2, #task:2014).
//
// A capability is a GRANT INSIDE A WORKSPACE: `canAgentUseCapability` resolves
// it from the (workspace, agent) row, and a human configures it on the workspace
// roster. An `agent_inbox` has no workspace — so there is no row to read and no
// surface on which anyone could ever grant one. Handing its null coordinate to
// `requireAgentCapability` therefore denies EVERY act: the agent could not read,
// reply, react or open an attachment in its OWN inbox, and no human could fix
// it. That denial would be an accident of a missing coordinate, not a decision.
//
// The placement itself is the authority instead. An `agent_inbox` has exactly
// one participant — the Agent named by `inbox_agent_id` (§4.2: ACL derives from
// placement; there are no projected roster rows) — and that Agent is the sole
// principal there. So the rule is:
//
//   - `workspace` placement      → the workspace grant decides (unchanged);
//   - the caller's OWN agent_inbox → self-authority; no grant is consulted;
//   - anything else (someone else's inbox, an unknown conversation, a future
//     workspace-less arm)         → denied.
//
// This cannot smuggle a workspace act past a missing grant: every act whose UNIT
// is a workspace (create_channels, the task board, list_channels, a
// workspace-wide search) resolves its coordinate through `workspace-scope.ts`
// first and fails with `workspace_scope_required` before reaching a capability
// check. What remains here are the acts whose unit is THIS conversation.
import type { Context } from 'hono';
import type { AgentCapability, ConversationPlacementKind } from '@silverhand/shared';
import type { BackendContext } from '../../context.js';
import type { Principal } from '../../auth/principal.js';
import { requireAgentCapability } from '../capability.js';

/**
 * The facts this rule reads: identity + PLACEMENT. Both placement fields are
 * REQUIRED, not optional — a caller holding only the wire `ConversationDto`
 * (which strips them) would otherwise type-check while silently taking the
 * workspace-grant path for every inbox, i.e. denying the agent its own inbox
 * with no red light. Ask `ConversationRepo.getIdentity` for this shape.
 */
export interface ConversationCapabilityScope {
  id: string;
  workspace_id: string | null;
  placement_kind: ConversationPlacementKind;
  inbox_agent_id: string | null;
}

/**
 * Gate `capability` for an act inside `conversation`. Returns `null` when the
 * act is allowed, else the typed denial response.
 *
 * `conversation` is the one whose placement GOVERNS the act — usually the
 * calling conversation, but for `read_history` / `search` with an explicit
 * target it is the target conversation, because that is where the messages
 * being read live. An absent conversation is a denial, never an allow.
 */
export function requireAgentConversationCapability(
  c: Context,
  ctx: BackendContext,
  principal: Principal,
  capability: AgentCapability,
  conversation: ConversationCapabilityScope | null | undefined,
): Response | null {
  if (
    conversation
    && conversation.workspace_id === null
    && conversation.placement_kind === 'agent_inbox'
    && conversation.inbox_agent_id !== null
    && principal.kind === 'agent'
    && conversation.inbox_agent_id === principal.agentId
  ) {
    return null;
  }
  // Workspace placement (and every unresolved case) goes to the single
  // workspace-grant verifier — including `workspace_id === null` for a
  // placement this rule does not cover, which it already treats as a denial.
  return requireAgentCapability(c, ctx, principal, capability, conversation?.workspace_id);
}
