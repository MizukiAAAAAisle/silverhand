import type { AttachmentRow, AgentMaterializationStatus } from '@silverhand/shared';
import type { BackendContext } from './context.js';
import type { Principal, UserPrincipal } from './auth/principal.js';
import { AgentRepo } from './repos/agent-repo.js';
import { ConversationRepo } from './repos/conversation-repo.js';
import { WorkspaceRepo } from './repos/workspace-repo.js';

export type ParsedWsScope =
  | { type: 'app'; scope: 'app' }
  | { type: 'workspace'; scope: string; workspaceId: string }
  | { type: 'conversation'; scope: string; conversationId: string }
  | { type: 'viewer'; scope: string; viewerUserId: string };

export type AttachmentAclRow = Pick<
  AttachmentRow,
  'channel_id' | 'created_by_kind' | 'created_by_id'
>;

function workspaceRepo(ctx: BackendContext): WorkspaceRepo {
  return new WorkspaceRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot });
}

function conversationRepo(ctx: BackendContext): ConversationRepo {
  return new ConversationRepo(ctx.db);
}

function workspaceExists(ctx: BackendContext, workspaceId: string): boolean {
  return workspaceRepo(ctx).get(workspaceId) !== null;
}

function principalConversationChannelId(
  ctx: BackendContext,
  principal: Principal,
): string | null {
  if (principal.kind !== 'agent') return null;
  const repo = conversationRepo(ctx);
  const conversation = repo.get(principal.conversationId);
  if (!conversation) return null;
  if (!repo.getAgent(conversation.id, principal.agentId)) return null;
  return conversation.kind === 'thread'
    ? conversation.parent_conversation_id
    : conversation.id;
}

export function parseWsScope(scope: string, viewerUserId: string): ParsedWsScope | null {
  if (scope === 'app') return { type: 'app', scope: 'app' };

  const splitAt = scope.indexOf(':');
  if (splitAt <= 0) return null;
  const prefix = scope.slice(0, splitAt);
  const rawId = scope.slice(splitAt + 1);
  if (!rawId) return null;

  if (prefix === 'workspace') {
    const normalized = `workspace:${rawId}`;
    return { type: 'workspace', scope: normalized, workspaceId: rawId };
  }
  if (prefix === 'conversation') {
    const normalized = `conversation:${rawId}`;
    return { type: 'conversation', scope: normalized, conversationId: rawId };
  }
  if (prefix === 'viewer') {
    const resolvedViewerId = rawId === 'self' ? viewerUserId : rawId;
    return {
      type: 'viewer',
      scope: `viewer:${resolvedViewerId}`,
      viewerUserId: resolvedViewerId,
    };
  }
  return null;
}

export function canViewWorkspace(
  ctx: BackendContext,
  principal: Principal,
  workspaceId: string,
): boolean {
  if (!workspaceExists(ctx, workspaceId)) return false;
  if (principal.kind === 'system') return true;
  if (principal.kind === 'user') {
    // v25: humans are real workspace members. The viewer is added
    // to every existing workspace at register time (UserService.register
    // backfill) and to every new workspace at creation; v25 migration
    // also retroactively backfilled DBs that registered before this
    // table existed. Any user not in `workspace_users` for the queried
    // workspace is denied here. Multi-human v2 will use this same
    // gate — invite flows simply add another user to `workspace_users`.
    return workspaceRepo(ctx).isUserMember(workspaceId, principal.userId);
  }

  const conversation = conversationRepo(ctx).get(principal.conversationId);
  if (!conversation) return false;
  if (conversation.workspace_id !== workspaceId) return false;
  return conversationRepo(ctx).getAgent(
    principal.conversationId,
    principal.agentId,
  ) !== null;
}

/**
 * Cross-conversation workspace access for agent principals. Unlike
 * `canViewWorkspace`, this does NOT require the principal's source
 * conversation to belong to the queried workspace — it answers the
 * broader "is this agent a member of this workspace at all?"
 * question. Used by cross-workspace MCP tools (`list_workspaces`,
 * `list_channels?workspace_id=…`).
 *
 * Truth source: `WorkspaceRepo.listForAgent` (regular workspaces via
 * `workspace_members` ∪ owned `agent_home`). The v17 trigger already
 * keeps `workspace_members` agent_home-free, so ownership is the only
 * way an agent reaches its own home.
 */
export function canAgentAccessWorkspace(
  ctx: BackendContext,
  agentId: string,
  workspaceId: string,
): boolean {
  return workspaceRepo(ctx)
    .listForAgent(agentId)
    .some(w => w.id === workspaceId);
}

export function canMutateWorkspace(
  ctx: BackendContext,
  principal: Principal,
  workspaceId: string,
): boolean {
  if (!canViewWorkspace(ctx, principal, workspaceId)) return false;
  return principal.kind !== 'agent';
}

export function canManageMembers(
  ctx: BackendContext,
  principal: Principal,
  workspaceId: string,
): boolean {
  return canMutateWorkspace(ctx, principal, workspaceId);
}

export function canViewConversation(
  ctx: BackendContext,
  principal: Principal,
  conversationId: string,
): boolean {
  const conversation = conversationRepo(ctx).get(conversationId);
  if (!conversation) return false;
  if (!canViewWorkspace(ctx, principal, conversation.workspace_id)) return false;
  if (principal.kind === 'system') return true;
  if (principal.kind === 'user') {
    // v25: human conversation membership. Workspace check passed
    // above (so we know the user is a workspace member); now also
    // require explicit `conversation_users` membership for the
    // specific channel/thread. Channels are seeded from
    // `workspace_users` at creation; threads inherit from the parent
    // conversation. v25 migration backfilled both for already-
    // registered DBs.
    return conversationRepo(ctx).getUser(conversation.id, principal.userId)
      !== null;
  }
  if (principal.conversationId !== conversation.id) return false;
  return conversationRepo(ctx).getAgent(conversation.id, principal.agentId) !== null;
}

export function canPostToConversation(
  ctx: BackendContext,
  principal: Principal,
  conversationId: string,
): boolean {
  if (!canViewConversation(ctx, principal, conversationId)) return false;
  return true;
}

/**
 * Profile / avatar edit gate for an agent. v26 added
 * `agents.created_by_user_id` as the source of truth for this; v1
 * single-human installs have one viewer who created every agent, so
 * the gate is effectively viewer-only there. v2 multi-human will
 * naturally narrow it: a coworker who joins the workspace can read
 * the agent (membership-based) but cannot edit its profile.
 *
 * Allow rules (OR):
 *   1. `principal.kind === 'user'` and `principal.userId` matches
 *      `agents.created_by_user_id` — the creator.
 *   2. `principal.kind === 'agent'` and `principal.agentId === agentId`
 *      — the agent acting as itself. Today only reachable on internal
 *      routes (`/internal/conversations/:cid/agents/:aid/*`); the
 *      public PATCH `/api/agents/:id` is gated to user principals by
 *      `installRequireRegisteredViewerMiddleware`. Locked in here so
 *      future internal self-edit endpoints (PR-2/3) stay consistent.
 *   3. `principal.kind === 'system'` — internal hosts and migration
 *      jobs can edit anything. Mirrors every other `canX` predicate.
 *
 * Returns `true` for system principals unconditionally (mirrors every
 * other `canX` predicate — system never reads the agent row). Returns
 * `false` for missing agents on user/agent principals, non-creator
 * users, and cross-agent agent principals.
 */
export function canEditAgent(
  ctx: BackendContext,
  principal: Principal,
  agentId: string,
): boolean {
  if (principal.kind === 'system') return true;
  const repo = new AgentRepo(ctx.db);
  const agent = repo.get(agentId);
  if (!agent) return false;
  if (principal.kind === 'user') {
    return agent.created_by_user_id === principal.userId;
  }
  // agent principal
  return principal.agentId === agentId;
}

/**
 * D4.d D5 fixup (Cindy `vB9vzUo4y_vgSZf8` P1) — options surface for
 * `canViewAgent`'s `materialization_status` widener. Default-active
 * is the load-bearing contract:
 *
 * - `pending_materialization` and `failed` rows are hidden from
 *   every read / edit path that does NOT opt in. This is what
 *   keeps the management surface (default GET list, GET single,
 *   default sidebar / search / @-mention) free of boot-reconciler
 *   residue + failed clutter.
 *
 * - It is also what locks the §3.2 immutable-metadata invariant:
 *   `PATCH /api/agents/:id` runs against `canViewAgent` default,
 *   so a creator can NOT mutate a failed row's stored
 *   `description` / `runtime` / `model` snapshot. That snapshot
 *   is the comparator for `?retry=true` same-key retry — once a
 *   row is failed, its metadata is frozen until either retry
 *   succeeds (row goes active) or the row is deleted.
 *
 * Management routes opt in explicitly:
 *
 *   GET    /api/agents?include_failed=1         → ['active', 'failed']
 *   GET    /api/agents?include_pending=1        → ['active',
 *                                                  'pending_materialization']
 *   GET    /api/agents?include_failed=1
 *                     &include_pending=1         → all three (the §7.3
 *                                                  management view's
 *                                                  "Pending & Failed"
 *                                                  page)
 *   GET    /api/agents/:id?include_failed=1     → ['active', 'failed']
 *   GET    /api/agents/:id?include_pending=1    → ['active',
 *                                                  'pending_materialization']
 *   DELETE /api/agents/:id                       → all three (D5 status
 *                                                 dispatch needs to
 *                                                 reach pending → 409
 *                                                 and failed → 204)
 *
 * `GET /api/agents/:id/delete-impact` is intentionally kept at the
 * default `['active']` (Cindy `f0JxEM9nMhsVfLIo` refinement). The
 * management view's affordances on failed / pending rows are
 * `Delete` + `Retry`, not a destructive impact preview — a
 * "this delete will sweep N conversations" panel on a row with
 * zero dependents would be actively misleading. 404 for non-active
 * is the correct surface; do NOT widen this route to opt in
 * without a corresponding UI design pass.
 *
 * System principals bypass the status filter — mirrors `canEditAgent`'s
 * "system unconditional" pattern. Agent principals are status-gated
 * because in practice they only exist for active rows (the runtime
 * that spawns the agent principal is what flips the row to active),
 * so the gate is forward-correct and never observable in normal flow.
 *
 * `?include_pending=1` widener (D6 — Cindy `hguBjY1O1GMy2JSS`
 * standards: same shape as `?include_failed=1`) composes with
 * `?include_failed=1` on the GET list / single routes; the
 * §7.3 management view's "Pending & Failed" page sends both flags
 * together. ACL-first ordering keeps each flag creator-scoped —
 * neither widener can reveal another user's row because pending
 * and failed rows have no dependent workspaces (L3a never ran for
 * pending; failed = pre-L3a by definition), so `canViewAgent`'s
 * workspace-membership branch can never match cross-user for them.
 */
export interface CanViewAgentOptions {
  /**
   * Allowed `materialization_status` values for this view. Defaults
   * to `['active']` per design §I3 / §4.1: pending and failed rows
   * are invisible until the caller opts in.
   */
  includeStatuses?: ReadonlyArray<AgentMaterializationStatus>;
}

export function canViewAgent(
  ctx: BackendContext,
  principal: Principal,
  agentId: string,
  options: CanViewAgentOptions = {},
): boolean {
  // System bypasses everything (status + ACL). Mirrors
  // `canEditAgent` — system principals come from internal hosts
  // and migration jobs, not public surfaces.
  if (principal.kind === 'system') return true;
  const repo = new AgentRepo(ctx.db);
  const agent = repo.get(agentId);
  if (!agent) return false;

  // ── ACL-first (Cindy `f0JxEM9nMhsVfLIo` refinement) ─────────────
  // Run the ACL/principal gate BEFORE the status widener, even
  // though the outcome is equivalent (the result is ACL ∩ status
  // regardless of evaluation order). The structural reason is that
  // status is a WIDENER on the already-ACL-scoped candidate set —
  // it cannot reveal another principal's rows. Writing the gate in
  // status-first order would invite future readers to treat
  // `includeStatuses` as an ACL-relaxing knob, which it is NOT.
  let aclPass: boolean;
  if (principal.kind === 'agent') {
    aclPass = principal.agentId === agentId;
  } else if (agent.created_by_user_id === principal.userId) {
    aclPass = true;
  } else {
    aclPass = workspaceRepo(ctx)
      .listForAgent(agentId)
      .some(workspace => canViewWorkspace(ctx, principal, workspace.id));
  }
  if (!aclPass) return false;

  // ── Status widener (default active-only) ─────────────────────────
  const includeStatuses = options.includeStatuses ?? ACTIVE_ONLY;
  return includeStatuses.includes(agent.materialization_status);
}

const ACTIVE_ONLY: ReadonlyArray<AgentMaterializationStatus> = ['active'];

export function canViewAttachment(
  ctx: BackendContext,
  principal: Principal,
  attachment: AttachmentAclRow,
): boolean {
  if (principal.kind === 'agent') {
    return principalConversationChannelId(ctx, principal) === attachment.channel_id;
  }
  return canViewConversation(ctx, principal, attachment.channel_id);
}

export function canDeleteAttachment(
  ctx: BackendContext,
  principal: Principal,
  attachment: AttachmentAclRow,
): boolean {
  if (!canViewAttachment(ctx, principal, attachment)) return false;
  if (principal.kind === 'system') return true;
  if (principal.kind === 'user') {
    return (
      attachment.created_by_kind === 'user' &&
      attachment.created_by_id === principal.userId
    );
  }
  return (
    attachment.created_by_kind === 'agent' &&
    attachment.created_by_id === principal.agentId
  );
}

export function canViewOwnedState(
  _ctx: BackendContext,
  principal: Principal,
  targetUserId: string,
): boolean {
  if (principal.kind === 'system') return true;
  if (principal.kind !== 'user') return false;
  return principal.userId === targetUserId;
}

export function canSubscribeViewer(
  viewerUserId: string,
  scopeViewerUserId: string,
): boolean {
  return viewerUserId === scopeViewerUserId;
}

export function canSubscribeScope(
  ctx: BackendContext,
  viewerUserId: string,
  scope: ParsedWsScope,
): boolean {
  const principal: UserPrincipal = { kind: 'user', userId: viewerUserId };
  switch (scope.type) {
    case 'app':
      return true;
    case 'workspace':
      return canViewWorkspace(ctx, principal, scope.workspaceId);
    case 'conversation':
      return canViewConversation(ctx, principal, scope.conversationId);
    case 'viewer':
      return canViewOwnedState(ctx, principal, scope.viewerUserId);
  }
}
