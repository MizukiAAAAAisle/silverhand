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
  // Workspace pin/unpin — a workspace-level setting, not existential.
  { method: 'POST', path: '/api/workspaces/:id/pin', minRole: 'admin', roleScope: 'workspace' },
  { method: 'DELETE', path: '/api/workspaces/:id/pin', minRole: 'admin', roleScope: 'workspace' },
  // Create a channel in the workspace.
  { method: 'POST', path: '/api/workspaces/:id/channels', minRole: 'admin', roleScope: 'workspace' },
  // Member management. ENTRY gate is `admin` (adding/removing an AGENT
  // member is admin-level). The human-member branch of POST escalates to
  // an inner `canGovernWorkspace(..., 'owner')` check inside the handler
  // (human-roster control is owner-only, doc §1.1); the registry records
  // the entry minimum.
  {
    method: 'POST',
    path: '/api/workspaces/:id/members',
    minRole: 'admin',
    roleScope: 'workspace',
    note: 'entry=admin (agent-member add); human-member add escalates to owner inside the handler',
  },
  {
    method: 'PATCH',
    path: '/api/workspaces/:id/members/users/:userId/role',
    minRole: 'owner',
    roleScope: 'workspace',
    note: 'human role escalation/demotion is owner-only; owner transfer remains unsupported',
  },
  { method: 'DELETE', path: '/api/workspaces/:id/members/:agentId', minRole: 'admin', roleScope: 'workspace' },
  {
    method: 'DELETE',
    path: '/api/workspaces/:id/members/users/:userId',
    minRole: 'owner',
    roleScope: 'workspace',
    note: 'human-member removal is owner-only; the owner itself can never be removed (owner_removal_unsupported)',
  },
  // Editing an agent's capability set is governance (owner/admin, doc
  // §2.4). This is the human-axis gate ON the agent-capability axis —
  // WHO may edit caps is a role decision; WHAT the caps then authorize is
  // the orthogonal agent axis. GET is a non-mutating viewer read (not
  // listed; coverage only scans mutating routes).
  { method: 'PUT', path: '/api/workspaces/:id/agents/:agentId/capabilities', minRole: 'admin', roleScope: 'workspace' },
  // Channel pin/unpin/archive — day-to-day governance on a channel.
  { method: 'POST', path: '/api/channels/:id/pin', minRole: 'admin', roleScope: 'workspace' },
  { method: 'DELETE', path: '/api/channels/:id/pin', minRole: 'admin', roleScope: 'workspace' },
  { method: 'PATCH', path: '/api/channels/:id/archive', minRole: 'admin', roleScope: 'workspace' },
  // Conversation member add (doc §6.1 names this a governance write).
  // roleScope is 'conversation' — the FIRST live use of conversation
  // scope: effective role = override ?? workspace_role, and cut 1 has no
  // per-conversation override so effective == workspace role today. The
  // USER principal is gated on conversation visibility + this admin
  // effective role inside the handler (additive: you cannot govern a
  // conversation you cannot see). The AGENT principal reaches the SAME
  // handler via the internal route, where the
  // `manage_conversation_members` capability gate is already enforced
  // (AGENT_ROUTE_CAPABILITIES.agentAddConversationMember,
  // status:'enforced') before the request reaches this entry.
  {
    method: 'POST',
    path: '/api/conversations/:id/members',
    minRole: 'admin',
    roleScope: 'conversation',
    note: 'user principal: view + admin effective role; agent principal gated by enforced manage_conversation_members capability at the internal route (agentAddConversationMember)',
  },
  {
    method: 'DELETE',
    path: '/api/conversations/:id/members/agents/:agentId',
    minRole: 'admin',
    roleScope: 'conversation',
    note: 'user principal: view + (admin effective role OR target agent creator via canEditAgent); removes only the conversation_agents edge',
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
    path: '/api/channels/:id/mark-read',
    reason: 'per-user read state — view gate, not governance',
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

  // ── Enforced: capability gated at request time per doc §3 ────────────
  agentReadHistory: { status: 'enforced', capability: 'read_messages', scope: 'target conversation\'s workspace' },
  agentFollowThread: { status: 'enforced', capability: 'read_messages', scope: 'principal conversation\'s workspace' },
  agentUnfollowThread: { status: 'enforced', capability: 'read_messages', scope: 'principal conversation\'s workspace' },
  agentListChannels: { status: 'enforced', capability: 'read_messages', scope: 'target workspace_id arg (default principal\'s)' },
  agentSearchMessages: { status: 'enforced', capability: 'read_messages', scope: 'resolved target: channel.workspace_id | workspace_id arg | principal\'s' },
  agentSendConversationMessage: { status: 'enforced', capability: 'send_messages', scope: 'principal conversation\'s workspace' },
  agentResolveStaleMessage: { status: 'enforced', capability: 'send_messages', scope: 'principal conversation\'s workspace' },
  agentCreateChannel: { status: 'enforced', capability: 'create_channels', scope: 'principal conversation\'s workspace' },
  agentListConversationTasks: { status: 'enforced', capability: 'read_tasks', scope: 'effective workspace (workspace_id arg supported)' },
  agentCreateConversationTasks: { status: 'enforced', capability: 'create_tasks', scope: 'principal conversation\'s workspace' },
  // Task claim/unclaim/status gate INSIDE task-service: the target task's
  // workspace is resolved per-entry deep in the service (esp. claim by
  // message-id → the message's own workspace), so route-level resolution
  // cannot gate correctly. Typed `capability_denied`/`write_tasks` shape
  // preserved in the service result (doc §3, Cindy `0VvD-47mLnkjgDvw`).
  agentClaimConversationTasks: { status: 'enforced', capability: 'write_tasks', scope: 'target task\'s conversation workspace (service-level gate); promotion of a non-task message additionally requires create_tasks' },
  agentUnclaimConversationTask: { status: 'enforced', capability: 'write_tasks', scope: 'target task\'s conversation workspace (service-level gate)' },
  agentUpdateConversationTaskStatus: { status: 'enforced', capability: 'write_tasks', scope: 'target task\'s conversation workspace (service-level gate)' },
  agentUploadAttachment: { status: 'enforced', capability: 'upload_attachments', scope: 'principal conversation\'s workspace' },
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
