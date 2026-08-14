/**
 * #task:1983 W3 — the read port `permissions.ts` sits on.
 *
 * Authorization is cross-cutting: it is neither a composition site nor a
 * persistence adapter, yet every `canX` predicate has to look facts up. Before
 * this port it did that by taking the whole `BackendContext` and building a repo
 * per check out of `ctx.db`, which made the authorization module the single
 * loudest reason `BackendContext.db` had to exist (7 of the 63 readers) and gave
 * a pure predicate the ability to run arbitrary SQL.
 *
 * So the module declares what it actually needs, and it is a SMALL, closed set
 * of facts — derived by reading every predicate, not by mirroring the repos:
 *
 *   - workspace existence + `{workspace_kind, owner_agent_id}` (the agent_home
 *     exemption), human membership, the human's `workspace_users.role`, and the
 *     workspace ids an agent reaches;
 *   - conversation identity `{id, workspace_id, kind, visibility, archived_at}`
 *     (the public-channel branch) + "is this principal a member" for both
 *     principal kinds, as a BOOLEAN — no membership row escapes;
 *   - agent `{created_by_user_id, materialization_status}` (ownership + the
 *     status widener);
 *   - one capability question and one attachment-reference question.
 *
 * Every fact type is a `Pick<>` of the shared DTO rather than a hand-copied
 * shape, so the field types keep a single authority; the adapter projects the
 * listed fields explicitly, so nothing beyond them is reachable at runtime
 * either. Nothing here returns a repository DTO, which is why narrowing
 * `permissions.ts` changed none of its 158 call sites — and why the module now
 * imports no concrete repo at all.
 *
 * This port is `permissions.ts`'s PRIVATE fact source, not an ambient
 * repository: it is installed on the context as `authorizationReads`, and a
 * consumption gate (W6 Gate 8) reddens if any production file other than
 * `permissions.ts` and the composition that installs it reads that field. A
 * route that needs a workspace row asks its own repo/port for it — not the
 * authorization module's.
 */
import type {
  AgentCapability,
  AgentDto,
  ConversationDto,
  ConversationEndpointKind,
  ConversationRow,
  WorkspaceDto,
  WorkspaceRole,
} from '@silverhand/shared';

/** Only what the agent_home capability exemption and existence checks read. */
export type AuthorizationWorkspaceFacts = Pick<
  WorkspaceDto,
  'workspace_kind' | 'owner_agent_id'
>;

/**
 * Only what the public-channel branch, the workspace hop, and the PLACEMENT
 * branch read.
 *
 * `placement_kind` / `inbox_agent_id` are row facts with no wire field: WHO the
 * participants of a conversation are is derived from its placement
 * (agent-scoped-session-v1 §4.2) — a `workspace` row derives them from workspace
 * membership plus the roster tables, an `agent_inbox` row has exactly one
 * participant and names it directly. An ACL that saw only `workspace_id: null`
 * could tell "not workspace-placed" but not WHOSE line it is, and would have to
 * fail closed on the agent's own inbox.
 *
 * The `endpoint_*` columns (v73) are the `direct_pair` arm of the same rule: its
 * two participants ARE its endpoints. The tombstones come along because the
 * survivor's gate depends on whether the OTHER endpoint still exists — but only
 * as one half of that question; see {@link AuthorizationReadPort.endpointPrincipalExists}.
 *
 * `roster_policy` answers a different question from all of the above: not "who is
 * in here" but "can that set be CHANGED at all". `fixed` means the participants
 * are a property of the conversation (a DM's two endpoints, an inbox's owner, a
 * legacy agent-home DM channel's pair), so no principal — no admin, no owner —
 * can add one. It is read as the roster axis rather than through the generated
 * `kind`, which projects the same fact but is a legacy single-axis label (§4.1).
 */
export type AuthorizationConversationFacts = Pick<
  ConversationDto,
  'id' | 'workspace_id' | 'kind' | 'visibility' | 'archived_at'
> &
  Pick<
    ConversationRow,
    | 'placement_kind'
    | 'roster_policy'
    | 'inbox_agent_id'
    | 'endpoint_a_kind'
    | 'endpoint_a_id'
    | 'endpoint_b_kind'
    | 'endpoint_b_id'
    | 'endpoint_a_deleted_at'
    | 'endpoint_b_deleted_at'
  >;

/** Only what agent ownership and the `materialization_status` widener read. */
export type AuthorizationAgentFacts = Pick<
  AgentDto,
  'created_by_user_id' | 'materialization_status'
>;

export interface AuthorizationReadPort {
  /** `null` when the workspace does not exist — that IS the existence check. */
  workspace(workspaceId: string): AuthorizationWorkspaceFacts | null;
  isWorkspaceMember(workspaceId: string, userId: string): boolean;
  /** The authoritative `workspace_users.role`, never the denormalized pointer. */
  workspaceUserRole(workspaceId: string, userId: string): WorkspaceRole | null;
  /**
   * The workspaces an agent reaches (regular via `workspace_members` ∪ its own
   * `agent_home`). Ids only: both callers compare or re-gate by id.
   */
  agentWorkspaceIds(agentId: string): readonly string[];
  conversation(conversationId: string): AuthorizationConversationFacts | null;
  /**
   * Does the principal a `direct_pair` endpoint names still exist? THE
   * authority for endpoint liveness — the `endpoint_*_deleted_at` stamp is a
   * denormalized timestamp, so the ACL asks this and ORs the stamp in, never the
   * other way round. Endpoint coordinates are validated at birth and immutable,
   * so a miss can only mean the principal was deleted.
   */
  endpointPrincipalExists(endpoint: {
    kind: ConversationEndpointKind;
    id: string;
  }): boolean;
  isConversationAgent(conversationId: string, agentId: string): boolean;
  isConversationUser(conversationId: string, userId: string): boolean;
  agent(agentId: string): AuthorizationAgentFacts | null;
  hasCapability(
    workspaceId: string,
    agentId: string,
    capability: AgentCapability,
  ): boolean;
  isAttachmentReferencedByChannelMessage(
    attachmentId: string,
    channelId: string,
  ): boolean;
}
