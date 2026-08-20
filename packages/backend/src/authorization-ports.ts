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
 *   - workspace existence + `{owner_agent_id}` (the agent_home
 *     exemption), human membership, the human's `workspace_users.role`, the
 *     workspace ids an agent reaches, and a workspace's human member ids (the
 *     view-audience arm);
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
  Workspace,
  WorkspaceRole,
} from '@silverhand/shared';

/** Only what the agent_home capability exemption and existence checks read: the
 *  OWNERSHIP relation, which is the whole of both questions (`isAgentHomeWorkspace`
 *  / `isAgentHomeWorkspaceOf`). A container word alongside it would be a second
 *  spelling of the same bit — and one this port has no use for. */
export type AuthorizationWorkspaceFacts = Pick<Workspace, 'owner_agent_id'>;

/**
 * Only what the public-channel branch, the workspace hop, and the PLACEMENT
 * branch read.
 *
 * `placement_kind` is the branch selector: WHO the participants of a conversation
 * are is derived from its placement (agent-scoped-session-v1 §4.2) — a `workspace`
 * row derives them from workspace membership plus the roster tables, a
 * `direct_pair` row from its two endpoints. An ACL that saw only
 * `workspace_id: null` could tell "not workspace-placed" but not WHOSE line it is,
 * and would have to fail closed on every DM.
 *
 * The `endpoint_*` columns (v73) are row facts with no wire field, and they are the
 * `direct_pair` arm of that rule: its two participants ARE its endpoints. The tombstones come along because the
 * survivor's gate depends on whether the OTHER endpoint still exists — but only
 * as one half of that question; see {@link AuthorizationReadPort.endpointPrincipalExists}.
 *
 * `roster_policy` answers a different question from all of the above: not "who is
 * in here" but "can that set be CHANGED at all". `fixed` means the participants
 * are a property of the conversation (a DM's two endpoints, a
 * legacy agent-home DM channel's pair), so no principal — no admin, no owner —
 * can add one.
 */
export type AuthorizationConversationFacts = Pick<
  ConversationDto,
  'id' | 'workspace_id' | 'placement_kind' | 'roster_policy' | 'visibility' | 'archived_at'
> &
  Pick<
    ConversationRow,
    | 'endpoint_a_kind'
    | 'endpoint_a_id'
    | 'endpoint_b_kind'
    | 'endpoint_b_id'
    | 'endpoint_a_deleted_at'
    | 'endpoint_b_deleted_at'
  >;

/** Only what agent ownership, the `materialization_status` widener, and the
 *  DM-initiation scope check read. */
export type AuthorizationAgentFacts = Pick<
  AgentDto,
  'created_by_user_id' | 'materialization_status' | 'session_scope'
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
  /**
   * The HUMAN endpoints of every human↔agent `direct_pair` this agent is the
   * agent endpoint of (#task:2043 C). THE authority for the `canViewAgent` 4th
   * ACL arm: a human at the far end of a DM with this agent can view it. Ids
   * only — the caller re-gates by membership on `principal.userId`.
   */
  agentDirectPairHumanEndpointIds(agentId: string): readonly string[];
  /**
   * The human members of a workspace. Ids only — the workspace arm of the
   * agent-viewer audience (the dual of {@link permissions.canViewAgent}) walks
   * an agent's workspaces and unions their human members into the candidate set,
   * then re-gates each through `canViewAgent`. Collapsed to ids like the
   * membership reads above: the audience needs WHO is a member, never a member's
   * `role` / `joined_at`.
   */
  workspaceMemberUserIds(workspaceId: string): readonly string[];
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
  /**
   * Is the agent an ENDPOINT/participant of this conversation regardless of
   * where its runtime is currently seated — the SUBJECT-participation question
   * the owner-audit ACL asks. Distinct from {@link isConversationAgent}, which
   * is only the `workspace`-placement roster edge; this is the full participation
   * arc (workspace roster ∪ `direct_pair` endpoint), the same two arms the
   * runtime target gate resolves — but WITHOUT the
   * running-in narrowing, because audit asks "is this agent a party here at all",
   * not "is its seat here right now". Collapsed to a boolean like the membership
   * reads: the audit face reaches no endpoint columns through this port.
   */
  isAgentParticipant(conversationId: string, agentId: string): boolean;
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
