import { AGENT_CAPABILITIES, internalPaths } from '@silverhand/shared';
import type { AgentCapability, WorkspaceRole } from '@silverhand/shared';

/**
 * Graded-permissions Layer A — the two declarative route registries that
 * make the authority model drift-proof. See docs/graded-permissions-v1.md
 * §6 ("Drift test — the load-bearing protection").
 *
 * Two axes, two registries:
 *   - HUMAN_GOVERNANCE_ROUTES — public routes that mutate workspace /
 *     membership / channel governance, each declaring the MINIMUM
 *     workspace role required. Replaces the old two-valued
 *     `canMutateWorkspace` god-gate.
 *   - AGENT_ROUTE_CAPABILITIES — every internal agent route, declaring
 *     which capability gates it (cut 2) or why it needs none.
 *
 * The coverage test (`permissions-registry.test.ts`) asserts every live
 * route is accounted for in the right registry. A new governance route
 * with no declaration, or a new internal agent route absent from the
 * capability registry, fails the build — that is the regression gate
 * that stops either axis from quietly collapsing back onto a god-gate.
 *
 * Both axes are now LIVE and enforced. Layer A landed historically in two
 * cuts — cut 1 the human role spine, cut 2 the agent capability axis — but
 * that split is done: every internal agent route in
 * `AGENT_ROUTE_CAPABILITIES` is either `enforced` or `none-justified`, and
 * `EXPECTED_PENDING_AGENT_ROUTES` is EMPTY. `pending` survives only as the
 * coverage-test mechanism that keeps the ledger empty: a future internal
 * route added as `pending` (or an enforced route flipped back) fails the
 * build, so no route can slip through ungated unnoticed.
 */

export type HttpMutationMethod = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

// ── Human governance axis ──────────────────────────────────────────────

/**
 * Which role scope the `minRole` is evaluated against. `workspace` reads
 * the workspace role; `conversation` reads the effective conversation
 * role (`override ?? workspace_role`, doc §1.3 — a later layer). Carried
 * from the start (Cindy `DSJLtPe7FkicAV0u` #4) so channel-scoped
 * governance does not force a re-split later. Every Layer-A-cut-1 entry
 * is `workspace`-scoped; `conversation` exists for forward-compat.
 */
export type RoleScope = 'workspace' | 'conversation';

export interface GovernanceRouteDecl {
  method: HttpMutationMethod;
  /** Mounted Hono path pattern, verbatim (cross-checked against the
   *  live route table by the coverage test). */
  path: string;
  /**
   * The route FLOOR: the minimum role that may reach the handler at all —
   * NOT the rank every operation on it needs. A composite route grades
   * further INSIDE the handler by the class of DATA being written
   * (#task:1683): `POST /api/workspaces/:id/members` admits a plain `member`
   * for their OWN agent while a human target still needs `admin`. Declaring
   * such a route `admin` would make this registry — which calls itself the
   * authority SSOT — state the opposite of the live gate, so the floor is
   * what is declared and every inner escalation MUST be spelled out in
   * `note`. `FLOOR_PROBED_ROUTES` in `permissions-registry.test.ts` calls the
   * real routes to prove each `member` floor is actually reachable, so the
   * declaration cannot go stale next to a widened gate.
   */
  minRole: WorkspaceRole;
  roleScope: RoleScope;
  /** Inline justification for non-obvious gradings / inner escalations. */
  note?: string;
}

/**
 * Every public route that mutates workspace / membership / channel
 * governance, with the minimum role it requires (doc §1.1 matrix).
 * Behavior is neutral on the current install (single human = owner ⊇
 * admin ⊇ member); the gradings encode the model for a future second
 * human, who joins as `member`.
 */
export const HUMAN_GOVERNANCE_ROUTES: readonly GovernanceRouteDecl[] = [
  // Workspace settings (incl. rename) — day-to-day governance.
  { method: 'PATCH', path: '/api/workspaces/:id', minRole: 'admin', roleScope: 'workspace' },
  // Existential: archive / delete the workspace — owner only.
  { method: 'PATCH', path: '/api/workspaces/:id/archive', minRole: 'owner', roleScope: 'workspace' },
  { method: 'DELETE', path: '/api/workspaces/:id', minRole: 'owner', roleScope: 'workspace' },
  // Create a channel in the workspace.
  { method: 'POST', path: '/api/workspaces/:id/channels', minRole: 'admin', roleScope: 'workspace' },
  // Member management. The agent roster is a COMPOSITE route since #task:1683:
  // floor `member`, then the required rank follows the target's data class.
  // Human role changes/removal remain owner-only below.
  {
    method: 'POST',
    path: '/api/workspaces/:id/members',
    minRole: 'member',
    roleScope: 'workspace',
    note: 'adds agent or human workspace members; ESCALATES inside: a human target needs admin, an agent target needs canEnrollAgent (its creator) with NO admin OR-arm — enrollment is creator-only, so owner/admin are refused agent_not_owned for someone else\'s agent (asymmetric with the DELETE route, where admin governs the whole roster); new humans join as member',
  },
  {
    method: 'PATCH',
    path: '/api/workspaces/:id/members/users/:userId/role',
    minRole: 'owner',
    roleScope: 'workspace',
    note: 'human role escalation/demotion is owner-only; owner transfer remains unsupported',
  },
  {
    method: 'DELETE',
    path: '/api/workspaces/:id/members/:agentId',
    minRole: 'member',
    roleScope: 'workspace',
    note: 'removal is the symmetric half of enrollment (#task:1683): FLOOR member, then it ESCALATES by target — admin governs the whole roster, otherwise canEnrollAgent (the agent you created); a plain member gets 403 for an unknown agent id, so the dangling-row cleanup stays admin-only',
  },
  {
    method: 'DELETE',
    path: '/api/workspaces/:id/members/users/:userId',
    minRole: 'owner',
    roleScope: 'workspace',
    note: 'human-member removal is owner-only; the owner itself can never be removed (owner_removal_unsupported)',
  },
  // Editing an agent's capability set is the third member of the #task:1683
  // placement-ownership family (approved #1775 option A): FLOOR member, then it
  // ESCALATES by target — admin governs the whole roster's caps, otherwise a
  // member may edit the caps of an agent they created (canEnrollAgent). This is
  // the human-axis gate ON the agent-capability axis — WHO may edit caps is a
  // role+ownership decision; WHAT the caps then authorize is the orthogonal
  // agent axis. GET is a non-mutating viewer read (not listed; coverage only
  // scans mutating routes).
  {
    method: 'PUT',
    path: '/api/workspaces/:id/agents/:agentId/capabilities',
    minRole: 'member',
    roleScope: 'workspace',
    note: 'FLOOR member, then ESCALATES by target (canEditAgentCapabilities, #task:1777): admin governs the whole roster\'s caps, otherwise canEnrollAgent (the agent you created) — a plain member gets 403 for a teammate\'s agent; the agent-self arm is deliberately excluded (canEnrollAgent is false for agent principals) so no agent can widen its own caps; authorization runs BEFORE the pair 404 so a non-member cannot probe membership',
  },
  // Channel archive — day-to-day governance on a channel. (Star is personal
  // view state, not governance — see NON_GOVERNANCE_MUTATING_ROUTES.)
  { method: 'PATCH', path: '/api/channels/:id/archive', minRole: 'admin', roleScope: 'workspace' },
  // Channel rename (title edit) — same governance class as archive.
  { method: 'PATCH', path: '/api/channels/:id', minRole: 'admin', roleScope: 'workspace' },
  // Conversation member add (§1.1 grades it; §5.1 registers it).
  // roleScope is 'conversation' — the FIRST live use of conversation
  // scope: effective role = override ?? workspace_role, and cut 1 has no
  // per-conversation override so effective == workspace role today.
  //
  // Composite since #task:1683, and its floor is NOT expressible as a role at
  // all: the target-independent floor is MEMBERSHIP of this very conversation
  // (`canAddConversationMember` = `canViewConversation`), which no role can
  // substitute for — owning an agent, or holding `admin`, never gets you a
  // roster write on a channel you are not in. `minRole: 'member'` is therefore
  // the role-axis LOWER BOUND only; the membership floor and the per-target
  // escalation are in the note. The AGENT principal reaches the SAME handler
  // via the internal route, where the `manage_conversation_members` capability
  // gate is already enforced
  // (AGENT_ROUTE_CAPABILITIES.agentAddConversationMember, status:'enforced')
  // before the request reaches this entry.
  {
    method: 'POST',
    path: '/api/conversations/:id/members',
    minRole: 'member',
    roleScope: 'conversation',
    note: 'user principal: FLOOR = membership of this conversation (not a role); then ESCALATES by target — a human needs workspace admin; own agent needs only the floor (auto-provisioning workspace membership via canEnrollAgent); someone else\'s agent needs workspace admin AND, if it is not a workspace member yet, is refused agent_not_owned even for an admin (enrollment is creator-only, #task:1681); agent principal gated by enforced manage_conversation_members capability at the internal route (agentAddConversationMember) and can never auto-provision',
  },
  {
    method: 'DELETE',
    path: '/api/conversations/:id/members/agents/:agentId',
    minRole: 'member',
    roleScope: 'conversation',
    note: 'user principal: FLOOR = conversation visibility, then admin effective role OR target agent creator via canEditAgent; removes only the conversation_agents edge; a caller without the role learns nothing about unknown agent ids (403, not 404)',
  },
  // Channel-scoped HUMAN removal (#task:1688) — the third-party counterpart of
  // the self-leave route. `admin`, unlike the WORKSPACE human-removal route
  // (`DELETE /api/workspaces/:id/members/users/:userId`, owner-only): grading
  // follows the data written, and this writes ONE conversation edge (no
  // workspace_users row, no user row, no role), which is the same day-to-day
  // channel governance already graded admin. Two guards keep the grade from
  // becoming a god-gate: the caller must be able to SEE the conversation, and
  // governance is not transitive upward (an admin cannot remove the owner).
  {
    method: 'DELETE',
    path: '/api/conversations/:id/members/users/:userId',
    minRole: 'admin',
    roleScope: 'conversation',
    note: 'user principal: FLOOR = membership of this conversation (canViewConversation, not a role), then workspace admin AND the target must not outrank the caller (admin removing the owner is 403 target_outranks_actor) AND the target must pass the shared exit guards (archived channel, private-channel owner, last human of a private channel → 409); removing YOURSELF is refused (422 self_target) — POST /api/channels/:id/leave is that verb; a target with no membership row is an idempotent 200',
  },
];

export interface NonGovernanceRouteDecl {
  method: HttpMutationMethod;
  path: string;
  /** Why this mutating route under a governance path prefix is NOT a
   *  workspace-role governance op (it has a different, correct gate). */
  reason: string;
}

/**
 * Mutating routes that live under the `/api/workspaces` or
 * `/api/channels` prefixes but are deliberately NOT workspace-role
 * governance. The coverage test requires every mutating route under
 * those prefixes to be in EITHER `HUMAN_GOVERNANCE_ROUTES` or this
 * allowlist — so a newly added governance route with no role declaration
 * fails the build instead of silently inheriting whatever gate it copied.
 * Each entry states the gate it actually uses.
 */
export const NON_GOVERNANCE_MUTATING_ROUTES: readonly NonGovernanceRouteDecl[] = [
  {
    method: 'POST',
    path: '/api/workspaces',
    reason: 'workspace creation is app-level (any registered viewer), not per-workspace governance',
  },
  {
    method: 'POST',
    path: '/api/channels/:id/messages',
    reason: 'send a message — conversation membership gate (canPostToConversation), member-level',
  },
  {
    method: 'POST',
    path: '/api/channels/:id/join',
    reason: 'self-join a public channel — public-target admission gate (canJoinPublicChannel), caller joins only themselves, not workspace governance',
  },
  {
    method: 'POST',
    path: '/api/channels/:id/leave',
    reason: 'self-leave a channel — member-only self-service (removes only the caller), eligibility guarded by evaluateChannelMemberExitEligibility (the same predicate third-party removal uses for its target), not workspace governance',
  },
  {
    method: 'PUT',
    path: '/api/conversations/:id/attention-preference',
    reason: 'per-viewer ambient attention preference (#task:1227) — personal view state, conversation membership gate (canViewConversation), not governance',
  },
  {
    method: 'PUT',
    path: '/api/workspaces/:id/attention-preference',
    reason: 'per-viewer workspace mute suppressor (#task:1870) — personal view state written only to the calling viewer\'s own row, workspace visibility gate (canViewWorkspace); it changes nothing another member sees and never gates delivery, so it is the workspace-scoped twin of the per-channel preference above, not governance',
  },
  {
    method: 'POST',
    path: '/api/channels/:id/threads/:rootMessageId/follow',
    reason: 'thread follow subscription — current-viewer delivery state, view gate, not governance',
  },
  {
    method: 'DELETE',
    path: '/api/channels/:id/threads/:rootMessageId/follow',
    reason: 'thread unfollow subscription — current-viewer delivery state, view gate, not governance',
  },
  {
    method: 'POST',
    path: '/api/channels/:id/attachments',
    reason: 'upload an attachment — conversation post gate, member-level',
  },
  {
    method: 'POST',
    path: '/api/channels/:id/agents/:aid/start',
    reason: 'agent runtime control — conversation/agent-scoped gate, not workspace governance',
  },
  {
    method: 'POST',
    path: '/api/channels/:id/agents/:aid/stop',
    reason: 'agent runtime control — conversation/agent-scoped gate, not workspace governance',
  },
  {
    method: 'POST',
    path: '/api/channels/:id/agents/:aid/clear-session',
    reason: 'agent runtime control — conversation/agent-scoped gate, not workspace governance',
  },
  {
    method: 'POST',
    path: '/api/conversations/:id/log-debug',
    reason: 'toggle temporary conversation debug logging — view gate (canViewConversation), member-level, not governance',
  },
  // Personal ⭐ star (#task:1209) — per-viewer sort state, NOT shared
  // governance. Replaced the old admin-gated `/pin` routes; the gate is
  // can-view of the entity, the write is scoped to the calling viewer.
  {
    method: 'POST',
    path: '/api/workspaces/:id/star',
    reason: 'personal star — current-viewer sort state (user_sort_entry.starred_at), can-view gate, not governance',
  },
  {
    method: 'DELETE',
    path: '/api/workspaces/:id/star',
    reason: 'personal unstar — current-viewer sort state, can-view gate, not governance',
  },
  {
    method: 'POST',
    path: '/api/channels/:id/star',
    reason: 'personal star — current-viewer sort state (user_sort_entry.starred_at), can-view gate, not governance',
  },
  {
    method: 'DELETE',
    path: '/api/channels/:id/star',
    reason: 'personal unstar — current-viewer sort state, can-view gate, not governance',
  },
];

/** Path prefixes the governance coverage check scans for stray mutating
 *  routes. */
export const GOVERNANCE_PATH_PREFIXES = ['/api/workspaces', '/api/channels', '/api/conversations'] as const;

// ── Agent capability axis (live: every route enforced or none-justified) ─

/**
 * The 11 capability buckets (doc §2.2). CANONICAL definition lives in
 * `@silverhand/shared` (`AGENT_CAPABILITIES`) so the migration CHECK, the
 * DTO enum, and this registry derive from one list. Re-exported here for
 * the registry's local declarations and the coverage test.
 */
export { AGENT_CAPABILITIES };
export type { AgentCapability };

/**
 * Per-route capability declaration. `none-justified` is a FINAL state (a
 * route that legitimately needs no capability — telemetry, agent-self
 * introspection/profile) and must carry a reason. `enforced` is a route
 * that gates on `capability` at request time (the route resolves the
 * target workspace per `scope`, doc §3, then calls
 * `canAgentUseCapability`). `pending` is a historical/guard state — no
 * live route uses it (the ledger is empty); it survives only so the
 * coverage test can fail the build if a future route is added ungated.
 */
export type AgentRouteCapabilityDecl =
  | { status: 'none-justified'; reason: string }
  | { status: 'enforced'; capability: AgentCapability; scope: string; note?: string }
  | { status: 'pending'; plannedCapability: AgentCapability; scope: string; note?: string };

/**
 * Every internal agent route (keyed by `internalPaths` key) → its
 * capability declaration. Coverage test asserts the key set here equals
 * `Object.keys(internalPaths)` exactly, so a new internal route forces a
 * decision here. Scopes/capabilities mirror doc §3's route→capability
 * map (the "Cap evaluated on" column).
 */
export const AGENT_ROUTE_CAPABILITIES: Record<
  keyof typeof internalPaths,
  AgentRouteCapabilityDecl
> = {
  // ── Final: no capability needed (justified) ──────────────────────────
  agentCliTrace: { status: 'none-justified', reason: 'telemetry, principal-pinned' },
  agentListWorkspaces: {
    status: 'none-justified',
    reason: 'agent-self workspace index — lists the agent\'s own memberships, no per-workspace action (doc §3.3)',
  },
  agentScheduleList: {
    status: 'none-justified',
    reason: 'agent-self schedule introspection across all targets, no single workspace target (doc §3.2)',
  },
  agentUploadAvatar: {
    status: 'none-justified',
    reason: 'agent-self profile (identity axis); stays on canEditAgent self-gate',
  },
  agentDeleteAvatar: {
    status: 'none-justified',
    reason: 'agent-self profile (identity axis); stays on canEditAgent self-gate',
  },
  agentProfileMcpGet: {
    status: 'none-justified',
    reason: 'agent-self profile (L1 identity axis); self-only via canEditAgent, no per-workspace action (#task:1135)',
  },
  agentProfileMcpSet: {
    status: 'none-justified',
    reason: 'agent-self profile (L1 identity axis); self-only via canEditAgent, no per-workspace action (#task:1135)',
  },
  agentProfileMcpProbe: {
    status: 'none-justified',
    reason: 'agent-self profile (L1 identity axis); self-only via canEditAgent, live one-shot diagnostic — no persisted state, no per-workspace action (#task:1137)',
  },
  agentProfileGet: {
    status: 'none-justified',
    reason: 'agent-self profile metadata read (identity axis); self-only via canEditAgent, no per-workspace action (#task:1178)',
  },
  agentProfileUpdate: {
    status: 'none-justified',
    reason: 'agent-self profile metadata write (display_name/description, identity axis); self-only via canEditAgent, no per-workspace action (#task:1178)',
  },

  // ── Enforced: capability gated at request time per doc §3 ────────────
  agentReadHistory: { status: 'enforced', capability: 'read_messages', scope: 'target conversation\'s workspace' },
  agentFollowThread: { status: 'enforced', capability: 'read_messages', scope: 'principal conversation\'s workspace' },
  agentUnfollowThread: { status: 'enforced', capability: 'read_messages', scope: 'principal conversation\'s workspace' },
  agentListChannels: { status: 'enforced', capability: 'read_messages', scope: 'target workspace_id arg (default principal\'s)' },
  // Peer profile read (#task:1823) — the PEER axis of the profile noun. Unlike
  // the self routes above (identity axis, `none-justified`) this reads ANOTHER
  // agent's row, so it is a per-workspace observation and gates like the other
  // roster/channel reads. Target must be a `workspace_members` agent of that
  // same workspace; unknown / non-member / human handles are one 404.
  agentGetPeerProfile: { status: 'enforced', capability: 'read_messages', scope: 'target workspace_id arg (default principal\'s)' },
  agentSearchMessages: { status: 'enforced', capability: 'read_messages', scope: 'resolved target: channel.workspace_id | workspace_id arg | principal\'s' },
  agentSendConversationMessage: { status: 'enforced', capability: 'send_messages', scope: 'principal conversation\'s workspace' },
  agentResolveStaleMessage: { status: 'enforced', capability: 'send_messages', scope: 'principal conversation\'s workspace' },
  agentReactMessage: { status: 'enforced', capability: 'send_messages', scope: 'principal conversation\'s workspace' },
  agentCreateChannel: { status: 'enforced', capability: 'create_channels', scope: 'principal conversation\'s workspace' },
  agentListConversationTasks: { status: 'enforced', capability: 'read_tasks', scope: 'effective workspace (workspace_id arg supported)' },
  agentCreateConversationTasks: { status: 'enforced', capability: 'create_tasks', scope: 'principal conversation\'s workspace; `--claim` (atomic self-assign) additionally requires write_tasks' },
  // Task claim/unclaim/status gate INSIDE task-service: the target task's
  // workspace is resolved per-entry deep in the service (esp. claim by
  // message-id → the message's own workspace), so route-level resolution
  // cannot gate correctly. Typed `capability_denied`/`write_tasks` shape
  // preserved in the service result (doc §3, Cindy `0VvD-47mLnkjgDvw`).
  agentClaimConversationTasks: { status: 'enforced', capability: 'write_tasks', scope: 'target task\'s conversation workspace (service-level gate); claims existing tasks only (no message promotion)' },
  agentUnclaimConversationTask: { status: 'enforced', capability: 'write_tasks', scope: 'target task\'s conversation workspace (service-level gate)' },
  agentUpdateConversationTaskStatus: { status: 'enforced', capability: 'write_tasks', scope: 'target task\'s conversation workspace (service-level gate)' },
  // Edit (title/content, optimistic-concurrency CAS) gates INSIDE task-service
  // on the resolved task workspace; collaborative board artifact so any
  // write_tasks agent may edit. Detail read gates on read_tasks.
  agentEditConversationTask: { status: 'enforced', capability: 'write_tasks', scope: 'target task\'s conversation workspace (service-level gate)' },
  agentGetConversationTaskDetail: { status: 'enforced', capability: 'read_tasks', scope: 'target task\'s conversation workspace (service-level gate)' },
  agentUploadAttachment: { status: 'enforced', capability: 'upload_attachments', scope: 'principal conversation\'s workspace' },
  agentUpdateAttachment: { status: 'enforced', capability: 'upload_attachments', scope: 'principal conversation\'s workspace' },
  agentLocateAttachment: { status: 'enforced', capability: 'read_attachments', scope: 'principal conversation\'s workspace' },
  agentDownloadAttachment: { status: 'enforced', capability: 'read_attachments', scope: 'principal conversation\'s workspace' },
  agentAddConversationMember: { status: 'enforced', capability: 'manage_conversation_members', scope: 'target conversation\'s workspace' },
  // Schedule create/cancel gate INSIDE schedule-service: the target
  // workspace is the schedule's target conversation's workspace, resolved
  // per-call in the service. Typed `capability_denied`/`manage_schedules`
  // shape preserved on ScheduleError.
  agentScheduleCreate: { status: 'enforced', capability: 'manage_schedules', scope: 'target_conversation_id\'s workspace (default principal\'s) (service-level gate)' },
  agentScheduleCancel: { status: 'enforced', capability: 'manage_schedules', scope: 'resolved schedule → target conversation\'s workspace (service-level gate)' },
};

/**
 * The exact ledger of capability debt: internal routes recorded as
 * `pending` above. The coverage test pins the live pending set to this
 * list (no more, no less). Cut 2 turned every route into a real
 * capability gate, so the ledger is now EMPTY — any future internal route
 * added as `pending` (or a flip that forgets to enforce) fails the test.
 */
export const EXPECTED_PENDING_AGENT_ROUTES: readonly (keyof typeof internalPaths)[] = [];
