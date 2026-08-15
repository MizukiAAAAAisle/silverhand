/**
 * #task:1983 W3 — the SQLite-side implementation of `AuthorizationReadPort`.
 *
 * A pure projection over repositories that already exist: it opens no
 * connection, holds no handle and names no driver type. That is deliberate —
 * authorization asks nothing the repos cannot already answer, so the adapter's
 * whole job is to (a) narrow each answer to the facts the port declares and
 * (b) collapse membership rows to booleans, so a predicate cannot start reading
 * a member's `role` / `joined_at` through the authorization surface.
 *
 * It takes repo INSTANCES rather than a `Db` for the same reason: the
 * composition root already built them, and a second construction site would be
 * a second answer to "who assembles persistence?".
 */
import type {
  AuthorizationAgentFacts,
  AuthorizationConversationFacts,
  AuthorizationReadPort,
  AuthorizationWorkspaceFacts,
} from '../authorization-ports.js';
import type { AgentRepo } from './agent-repo.js';
import type { AgentCapabilityRepo } from './agent-capability-repo.js';
import type { AttachmentRepo } from './attachment-repo.js';
import type { ConversationRepo } from './conversation-repo.js';
import { createEndpointPrincipalPresence } from './endpoint-principal-presence.js';
import type { UserRepo } from './user-repo.js';
import type { WorkspaceRepo } from './workspace-repo.js';

export interface AuthorizationReadsDeps {
  readonly workspaces: WorkspaceRepo;
  readonly conversations: ConversationRepo;
  readonly agents: AgentRepo;
  /** Only for `endpointPrincipalExists`'s human arm: a `direct_pair` endpoint's
   *  kind decides which principal table answers for its id. */
  readonly users: UserRepo;
  readonly capabilities: AgentCapabilityRepo;
  readonly attachments: AttachmentRepo;
}

export function createSqliteAuthorizationReads(
  deps: AuthorizationReadsDeps,
): AuthorizationReadPort {
  const { workspaces, conversations, agents, users, capabilities, attachments } =
    deps;
  const endpointPrincipalExists = createEndpointPrincipalPresence({ agents, users });
  return {
    workspace: (workspaceId): AuthorizationWorkspaceFacts | null => {
      const row = workspaces.get(workspaceId);
      if (!row) return null;
      return {
        workspace_kind: row.workspace_kind,
        owner_agent_id: row.owner_agent_id,
      };
    },
    isWorkspaceMember: (workspaceId, userId) =>
      workspaces.isUserMember(workspaceId, userId),
    workspaceUserRole: (workspaceId, userId) =>
      workspaces.getUserRole(workspaceId, userId),
    agentWorkspaceIds: agentId =>
      workspaces.listForAgent(agentId).map(workspace => workspace.id),
    conversation: (conversationId): AuthorizationConversationFacts | null => {
      // The PLACEMENT-aware identity read: the participant rule branches on
      // `placement_kind` / `inbox_agent_id` (§4.2), which the wire DTO
      // deliberately does not carry.
      const row = conversations.getIdentity(conversationId);
      if (!row) return null;
      return {
        id: row.id,
        workspace_id: row.workspace_id,
        placement_kind: row.placement_kind,
        roster_policy: row.roster_policy,
        inbox_agent_id: row.inbox_agent_id,
        visibility: row.visibility,
        archived_at: row.archived_at,
        endpoint_a_kind: row.endpoint_a_kind,
        endpoint_a_id: row.endpoint_a_id,
        endpoint_b_kind: row.endpoint_b_kind,
        endpoint_b_id: row.endpoint_b_id,
        endpoint_a_deleted_at: row.endpoint_a_deleted_at,
        endpoint_b_deleted_at: row.endpoint_b_deleted_at,
      };
    },
    // Liveness by LOOKUP, kind-directed — composed from the ONE dispatch
    // (`endpoint-principal-presence.ts`) that the send transaction's scope also
    // uses, so the request-layer gate and the in-transaction gate cannot answer
    // "is the other side still there" differently. Collapsed to a boolean like
    // the membership reads above: an ACL must not be able to reach a
    // deleted-or-not principal's other columns through this port.
    endpointPrincipalExists,
    isConversationAgent: (conversationId, agentId) =>
      conversations.getAgent(conversationId, agentId) !== null,
    isConversationUser: (conversationId, userId) =>
      conversations.getUser(conversationId, userId) !== null,
    agent: (agentId): AuthorizationAgentFacts | null => {
      const row = agents.get(agentId);
      if (!row) return null;
      return {
        created_by_user_id: row.created_by_user_id,
        materialization_status: row.materialization_status,
      };
    },
    hasCapability: (workspaceId, agentId, capability) =>
      capabilities.has(workspaceId, agentId, capability),
    isAttachmentReferencedByChannelMessage: (attachmentId, channelId) =>
      attachments.isReferencedByChannelMessage(attachmentId, channelId),
  };
}
