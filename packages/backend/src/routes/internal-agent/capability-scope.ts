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
// principal there. A `direct_pair` is the same argument with two participants:
// its endpoints ARE its ACL, it has no workspace either, and there is likewise no
// surface on which a human could grant anything inside one. So the rule is:
//
//   - `workspace` placement      → the workspace grant decides (unchanged);
//   - the caller's OWN agent_inbox → self-authority; no grant is consulted;
//   - a `direct_pair` the caller is an ENDPOINT of → endpoint authority;
//   - anything else (someone else's inbox, a pair the caller is not in, an
//     unknown conversation, a future workspace-less arm) → denied.
//
// THE COST OF THE PAIR ARM, STATED: a capability revoked on a workspace roster
// does not reach that agent's DMs. `send_messages` turned off for an agent in
// `silverhand` still leaves it able to DM another member, because the DM is not
// in `silverhand` — it is in no workspace at all. That is the same trade the inbox
// arm already made, and it is a consequence of capabilities being workspace
// grants while a DM is a placement outside every workspace; the alternative is a
// DM nobody can ever speak in, which is what the pre-P4-4 code actually did (the
// null coordinate denied every send into a `direct_pair`). If DM-scoped revocation
// turns out to be needed, it needs its own grant surface, not a fabricated
// workspace coordinate here.
//
// This cannot smuggle a workspace act past a missing grant: every act whose UNIT
// is a workspace (create_channels, the task board, list_channels, a
// workspace-wide search) resolves its coordinate through `workspace-scope.ts`
// first and fails with `workspace_scope_required` before reaching a capability
// check. What remains here are the acts whose unit is THIS conversation.
import type { Context } from 'hono';
import {
  directPairEndpointsOf,
  type AgentCapability,
  type ConversationEndpointKind,
  type ConversationPlacementKind,
} from '@silverhand/shared';
import type { BackendContext } from '../../context.js';
import type { Principal } from '../../auth/principal.js';
import { requireAgentCapability } from '../capability.js';

/**
 * The facts this rule reads: identity + PLACEMENT. Both placement fields are
 * REQUIRED, not optional — a caller holding only the wire `ConversationDto`
 * (which strips them) would otherwise type-check while silently taking the
 * workspace-grant path for every inbox, i.e. denying the agent its own inbox
 * with no red light. Ask `ConversationRepo.getIdentity` for this shape.
 *
 * The endpoint columns are required for the same reason, and the TOMBSTONES with
 * them: a pair whose other endpoint is gone is still a pair this agent is an
 * endpoint of, so it passes here and is refused by the WRITE gate
 * (`conversation_endpoint_gone`) — the capability question and the postability
 * question stay separate, and neither answers the other's.
 */
export interface ConversationCapabilityScope {
  id: string;
  workspace_id: string | null;
  placement_kind: ConversationPlacementKind;
  inbox_agent_id: string | null;
  endpoint_a_kind: ConversationEndpointKind | null;
  endpoint_a_id: string | null;
  endpoint_b_kind: ConversationEndpointKind | null;
  endpoint_b_id: string | null;
  endpoint_a_deleted_at: number | null;
  endpoint_b_deleted_at: number | null;
}

/**
 * Gate `capability` for an act inside `conversation`. Returns `null` when the
 * act is allowed, else the typed denial response.
 *
 * `conversation` is the one whose placement GOVERNS the act — usually the
 * calling conversation, but for `send` / `read_history` / `search` with an
 * explicit target it is the target conversation, because that is where the
 * messages live. An absent conversation is a denial, never an allow.
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
  if (
    conversation
    && conversation.placement_kind === 'direct_pair'
    && principal.kind === 'agent'
  ) {
    // Throws on a half pair, on purpose: one verdict on a row the placement arc
    // CHECK cannot produce, shared with the ACL and the header renderer. Degrading
    // to a denial here would leave the corruption visible only where someone else
    // happened to look.
    const endpoints = directPairEndpointsOf(conversation);
    const agentId = principal.agentId;
    if (endpoints?.some(e => e.kind === 'agent' && e.id === agentId)) return null;
  }
  // Workspace placement (and every unresolved case) goes to the single
  // workspace-grant verifier — including `workspace_id === null` for a
  // placement this rule does not cover, which it already treats as a denial.
  return requireAgentCapability(c, ctx, principal, capability, conversation?.workspace_id);
}
