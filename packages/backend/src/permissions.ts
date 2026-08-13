// Every predicate here reads its facts through `ctx.authorizationReads`
// (#task:1983 W3) — this module's own narrow read port, declared in
// `authorization-ports.js`. It constructs no repository and holds no
// connection: authorization is a cross-cutting DECISION layer, so it gets
// exactly the facts its rules mention and nothing else. `ctx` is still the
// first parameter of every export so the 158 call sites are untouched; the
// only field any of them reads is that port (W6's Gate 8 keeps every OTHER
// production file out of it — it is this module's private source, not an
// ambient repository).
import type { AttachmentRow, AgentCapability, AgentMaterializationStatus, WorkspaceRole } from '@silverhand/shared';
import { conversationScope, conversationSideScope } from '@silverhand/shared';
import type { BackendContext } from './context.js';
import type { AuthorizationConversationFacts } from './authorization-ports.js';
import type { Principal, UserPrincipal } from './auth/principal.js';
import { workspaceRoleMeetsFloor } from './auth/workspace-role.js';

export type ParsedWsScope =
  | { type: 'app'; scope: 'app' }
  | { type: 'workspace'; scope: string; workspaceId: string }
  | { type: 'conversation'; scope: string; conversationId: string }
  | { type: 'conversation-side'; scope: string; conversationId: string }
  | { type: 'viewer'; scope: string; viewerUserId: string };

export type AttachmentAclRow = Pick<
  AttachmentRow,
  'id' | 'channel_id' | 'created_by_kind' | 'created_by_id'
>;

function workspaceExists(ctx: BackendContext, workspaceId: string): boolean {
  return ctx.authorizationReads.workspace(workspaceId) !== null;
}

function principalConversationChannelId(
  ctx: BackendContext,
  principal: Principal,
): string | null {
  if (principal.kind !== 'agent') return null;
  const reads = ctx.authorizationReads;
  const conversation = reads.conversation(principal.conversationId);
  if (!conversation) return null;
  if (!reads.isConversationAgent(conversation.id, principal.agentId)) return null;
  return conversation.id;
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
    return { type: 'conversation', scope: conversationScope(rawId), conversationId: rawId };
  }
  if (prefix === 'conversation-side') {
    // Side-channel scope shares the conversation's view-permission but is a
    // distinct recovery class (cursor-inert, self-healing). Same viewer gate,
    // separate seq/replay space. See docs/event-ws-transport-v1.md §4.2.
    return {
      type: 'conversation-side',
      scope: conversationSideScope(rawId),
      conversationId: rawId,
    };
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
    return ctx.authorizationReads.isWorkspaceMember(workspaceId, principal.userId);
  }

  const reads = ctx.authorizationReads;
  const conversation = reads.conversation(principal.conversationId);
  if (!conversation) return false;
  if (conversation.workspace_id !== workspaceId) return false;
  return reads.isConversationAgent(principal.conversationId, principal.agentId);
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
  return ctx.authorizationReads.agentWorkspaceIds(agentId).includes(workspaceId);
}

/**
 * The governance role of a principal in a workspace, or `null` when the
 * principal has no role there. Only human (user) principals carry a
 * workspace role; system/agent principals return `null` (system is
 * handled by the unconditional pass in `canGovernWorkspace`, agents are
 * not governance actors). Reads the authoritative `workspace_users.role`
 * column, never the denormalized `workspaces.owner_user_id` pointer.
 */
export function workspaceRole(
  ctx: BackendContext,
  principal: Principal,
  workspaceId: string,
): WorkspaceRole | null {
  if (!workspaceExists(ctx, workspaceId)) return null;
  if (principal.kind !== 'user') return null;
  return ctx.authorizationReads.workspaceUserRole(workspaceId, principal.userId);
}

/**
 * The governance role of a user BY ID — the TARGET-scoped counterpart of
 * {@link workspaceRole}, which answers only "what is the CALLER's role".
 * Needed wherever a rule is about the person being acted ON rather than the
 * actor: the owner-anchor guard on a private channel, and the actor↔target rank
 * comparison that stops an `admin` from evicting the workspace `owner`
 * (#task:1688).
 *
 * Same authority as `workspaceRole` (`workspace_users.role`, never the
 * denormalized `workspaces.owner_user_id` pointer) and `null` for a user with no
 * row there. A role row IS workspace membership, so `role === 'owner'` here is
 * exactly what `canGovernWorkspace(.., 'owner')` answers for that user's own
 * principal — this variant just does not need a forged principal to ask.
 */
export function userWorkspaceRole(
  ctx: BackendContext,
  workspaceId: string,
  userId: string,
): WorkspaceRole | null {
  if (!workspaceExists(ctx, workspaceId)) return null;
  return ctx.authorizationReads.workspaceUserRole(workspaceId, userId);
}

/**
 * Replaces the old two-valued `canMutateWorkspace`/`canManageMembers`
 * (which granted every human member admin-equivalent power). A
 * governance op is allowed when the principal can view the workspace
 * (existence + membership) AND holds at least `minRole`. Pass `'owner'`
 * for existential / human role/removal ops (archive, delete, human-member
 * role changes/removal), `'admin'` for day-to-day governance (channel
 * create/delete, human-member add, settings incl. rename).
 *
 * System principals pass unconditionally (mirrors every other `canX`); agent
 * principals are NOT governance actors and always fail — governance is a
 * human-only surface in v1. The rank itself is the pure rule in
 * `auth/workspace-role.ts`, shared with the in-lock re-derivations.
 *
 * On a COMPOSITE route this is the FLOOR, not the whole gate: the agent-roster
 * routes pass `'member'` and then AND in `canEnrollAgent`, graded by VERB
 * (#task:1683) — ENROLLING an agent requires ownership with no role OR-arm (not
 * even `owner`/`admin` enrolls somebody else's agent, #task:1681), while
 * REMOVING one is `admin` OR ownership so an admin can still clean up the
 * roster. The required rank follows the class of data being written, so a plain
 * member may place and retract THEIR OWN agents while the people roster stays
 * `admin`/`owner`. See `HUMAN_GOVERNANCE_ROUTES` (each entry's `note` states its
 * escalation) and `docs/graded-permissions-v1.md` §1.1/§1.3.
 */
export function canGovernWorkspace(
  ctx: BackendContext,
  principal: Principal,
  workspaceId: string,
  minRole: WorkspaceRole,
): boolean {
  if (!canViewWorkspace(ctx, principal, workspaceId)) return false;
  if (principal.kind === 'system') return true;
  if (principal.kind === 'agent') return false;
  const role = workspaceRole(ctx, principal, workspaceId);
  if (role === null) return false;
  return workspaceRoleMeetsFloor(role, minRole);
}

/**
 * Graded-permissions Layer A — the agent capability axis.
 *
 * The fine-grained, per-(workspace, agent) authority axis (doc §2 / §4).
 * Orthogonal to the human role axis above: this never reads a workspace
 * role and `canGovernWorkspace` never reads a capability (doc §6.3/§6.4).
 *
 * `scope.workspaceId` is the workspace the capability is evaluated against
 * — resolved by the calling route from the actual TARGET it is about to
 * act on (target conversation / `workspace_id` arg / resolved task or
 * schedule), NOT the principal's home workspace alone (doc §3 Scope
 * column / §4). A source-workspace grant must never authorize a
 * target-workspace action.
 *
 * Principals:
 *   - `system` passes unconditionally (mirrors every other `canX`).
 *   - `agent` is checked against `workspace_agent_capabilities` for
 *     `(scope.workspaceId, principal.agentId)`, EXCEPT in the agent's own
 *     `agent_home` workspace where it holds implicit full authority (see
 *     below).
 *   - `user` always fails: capabilities are the agent-only axis; humans
 *     act through the role axis (`canGovernWorkspace`). Internal agent
 *     routes only ever carry agent principals, so this arm is defensive.
 *
 * agent_home exemption (VERY narrow, Cindy `0VvD-47mLnkjgDvw`): an
 * `agent_home` workspace is the agent's private surface — it has no
 * `workspace_members` row (membership is ownership, mirroring
 * `canAgentAccessWorkspace` / `task-service` §1268) and so the seed
 * migration never granted it caps. Without this exemption the agent would
 * be denied in its own DM/home. The exemption fires ONLY when the scoped
 * workspace is `agent_home` AND owned by THIS agent; a `regular`
 * workspace with no cap row still correctly returns false, and another
 * agent's home is never exempted.
 */
export function canAgentUseCapability(
  ctx: BackendContext,
  principal: Principal,
  capability: AgentCapability,
  scope: { workspaceId: string },
): boolean {
  if (principal.kind === 'system') return true;
  if (principal.kind !== 'agent') return false;
  const reads = ctx.authorizationReads;
  const workspace = reads.workspace(scope.workspaceId);
  if (!workspace) return false;
  if (
    workspace.workspace_kind === 'agent_home' &&
    workspace.owner_agent_id === principal.agentId
  ) {
    return true;
  }
  return reads.hasCapability(scope.workspaceId, principal.agentId, capability);
}

export function canViewConversation(
  ctx: BackendContext,
  principal: Principal,
  conversationId: string,
): boolean {
  const reads = ctx.authorizationReads;
  const conversation = reads.conversation(conversationId);
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
    return reads.isConversationUser(conversation.id, principal.userId);
  }
  if (principal.conversationId !== conversation.id) return false;
  return reads.isConversationAgent(conversation.id, principal.agentId);
}

/**
 * The PUBLIC-aware READ gate. Distinct from
 * `canViewConversation`, which stays the strict membership/interaction gate
 * (post, react, save, follow, read-state, observe, member ops). This predicate
 * governs the PUBLIC pure-read surface only: channel detail, conversation ref
 * (`GET /api/conversations/:id/ref` — identity + routing metadata, no messages
 * / unread / roster), message history, thread read, and the attachment BYTES of
 * an attachment referenced by a persisted message in this channel (in-message
 * preview). It is the ONLY place
 * the public widening lives — so every write/interaction path that keeps
 * calling `canViewConversation` remains fail-closed by default (a public
 * non-member cannot reach it). The Attachments PANEL list
 * (`GET /api/channels/:id/attachments`) stays membership-only; "download /
 * Save-As" is not a separate capability but a data fact of the same bytes
 * endpoint (see `canViewAttachment`), NOT a public UI affordance.
 * See docs/architecture-principles.md §12.1#4 (consumer-split).
 *
 * Grants read when EITHER:
 *   1. `canViewConversation` already passes (system, or an explicit
 *      member/agent) — members read everything they always could; OR
 *   2. the PUBLIC branch: a HUMAN workspace member browsing an ACTIVE,
 *      PUBLIC, regular `channel`. Deliberately narrow:
 *        - `principal.kind === 'user'` — agents have NO public path; their
 *          read/delivery stays strictly `conversation_agents`-gated via
 *          `canViewConversation` above.
 *        - `kind === 'channel'` — `dm_channel` / legacy thread never gain
 *          public semantics (also enforced at the DB CHECK, migration v58).
 *        - `visibility === 'public'`.
 *        - `archived_at == null` — an archived public channel is not
 *          browsable by non-members (archive ≠ delete, §12.2: it stays
 *          explicitly reachable to MEMBERS via the branch above, but drops
 *          out of the non-member public surface).
 *        - `canViewWorkspace` — must be a member of the owning workspace.
 */
export function canReadConversation(
  ctx: BackendContext,
  principal: Principal,
  conversationId: string,
): boolean {
  if (canViewConversation(ctx, principal, conversationId)) return true;
  const conversation = ctx.authorizationReads.conversation(conversationId);
  if (!conversation) return false;
  return isPublicChannelBranch(ctx, principal, conversation);
}

/**
 * The PUBLIC-branch admission shared by {@link canReadConversation} (public
 * read) and {@link canJoinPublicChannel} (self-join): a HUMAN workspace member
 * + an ACTIVE, PUBLIC, regular `channel`. Deliberately membership-AGNOSTIC — it
 * never short-circuits on `canViewConversation`. `canReadConversation` ORs it
 * AFTER the membership check (members read everything they always could);
 * `canJoinPublicChannel` uses it ALONE, so a member of a NON-public target
 * (private / `dm_channel` / archived) is NOT admitted to `/join`.
 */
function isPublicChannelBranch(
  ctx: BackendContext,
  principal: Principal,
  conversation: AuthorizationConversationFacts,
): boolean {
  if (principal.kind !== 'user') return false;
  if (conversation.kind !== 'channel') return false;
  if (conversation.visibility !== 'public') return false;
  if (conversation.archived_at !== null) return false;
  return canViewWorkspace(ctx, principal, conversation.workspace_id);
}

/**
 * Self-join admission. TRUE iff `principal` (a human workspace
 * member) may pull THEMSELVES into this ACTIVE, PUBLIC, regular channel — the
 * only non-member mutation the public model allows. Uses the public branch
 * ALONE (no membership short-circuit): a member of a private / `dm_channel` /
 * legacy thread / archived conversation is NOT admitted, so `/join` on a
 * non-public target fails closed EVEN for an existing member. The use case
 * runs this admission BEFORE the already-member idempotency check, so an
 * existing member of a non-public target cannot slip through on a no-op.
 */
export function canJoinPublicChannel(
  ctx: BackendContext,
  principal: Principal,
  conversationId: string,
): boolean {
  const conversation = ctx.authorizationReads.conversation(conversationId);
  if (!conversation) return false;
  return isPublicChannelBranch(ctx, principal, conversation);
}

export function canPostToConversation(
  ctx: BackendContext,
  principal: Principal,
  conversationId: string,
): boolean {
  if (!canViewConversation(ctx, principal, conversationId)) return false;
  return true;
}

export function canAddConversationMember(
  ctx: BackendContext,
  principal: Principal,
  conversationId: string,
): boolean {
  return canViewConversation(ctx, principal, conversationId);
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
  const agent = ctx.authorizationReads.agent(agentId);
  if (!agent) return false;
  if (principal.kind === 'user') {
    return agent.created_by_user_id === principal.userId;
  }
  // agent principal
  return principal.agentId === agentId;
}

/**
 * #task:1219 — owner gate for reading an agent's workspace files
 * (`GET /api/agents/:id/workspace/tree` + `/workspace/file`), covering
 * BOTH the no-param L1/home view (system_prompt / MEMORY / notes) and
 * the `workspace_id` L2 view. An agent's files are its private
 * cognition; co-membership grants collaboration, not access to a
 * member's brain (architecture-principles.md §1, Human/Agent
 * isomorphism). So file reads are owner-only — the same posture as the
 * sibling owner-gated surfaces on the agent page (raw MCP config,
 * schedules).
 *
 * It is a named alias of `canEditAgent` (owner / creator / self) ON
 * PURPOSE: it is the SINGLE cut point for the agreed future relaxation
 * — letting an owner explicitly opt L2 into being visible to that
 * workspace's members via a per-(agent, workspace) share grant
 * (decided 2026-06-24 with shiki/Cindy/Norman). When that lands, the
 * L2 branch widens HERE (parameterized by workspace_id) and nowhere
 * else; L1/home stays owner-only regardless. Until then both collapse
 * to plain owner.
 */
export function canViewAgentFiles(
  ctx: BackendContext,
  principal: Principal,
  agentId: string,
): boolean {
  return canEditAgent(ctx, principal, agentId);
}

/**
 * #task:1681 — ENROLLMENT authority: whose decision is it to put an agent into
 * a workspace. Answer: only the human who created that agent.
 *
 * #task:1683 (shiki 2026-07-28) made it the ownership factor for the whole
 * placement lifecycle, in BOTH directions and on BOTH rosters: bringing your own
 * agent into a workspace, taking it back out, and adding it to a channel you are
 * a member of. Each of those composes this with its own roster authority — the
 * `admin` arm of a removal or a channel add is an OR alongside this predicate,
 * never a substitute for it (no role enrolls someone else's agent) and never
 * substituted BY it (owning an agent grants no access to a channel you are not
 * in).
 *
 * Enrollment needs TWO independent factors, and this predicate owns exactly one
 * of them. The workspace side (`canGovernWorkspace`) says the caller may write
 * THAT workspace's roster; this says the caller may commit THAT agent to a
 * roster at all. Neither implies the other, so callers compose both — no role
 * lets you enroll a teammate's agent, and an agent's creator cannot enroll it
 * into a workspace they are not in.
 *
 * The workspace-side rank is set by the DATA being written, not by the verb
 * (shiki 2026-07-27): adding a HUMAN is `admin` governance, while adding your
 * OWN agent needs only `member`. That is what makes the product flow possible —
 * invitees join as plain `member`, so an admin-only roster write meant "invite
 * the human, they bring their agents" could never complete without also handing
 * them authority over the whole people roster.
 *
 * Product rule behind it (shiki 2026-07-27): another user's agents must not be
 * draggable into your workspace. You invite the HUMAN; that human then brings
 * their own agents. An agent's placement is part of its owner's authority over
 * it, so the visibility relation that `canViewAgent` grants (co-membership makes
 * a teammate's agent visible for @-mention / member lists) deliberately does NOT
 * carry enrollment rights.
 *
 * Deliberately NOT an alias of `canEditAgent`: that predicate lets an AGENT
 * principal act on itself (self-edit endpoints, own files), whereas an agent
 * may never enroll itself — being placed in a workspace is its owner's call,
 * not the runtime's. So agent principals are `false` here. System stays
 * unconditional (migrations / internal hosts), mirroring every other `canX`.
 */
export function canEnrollAgent(
  ctx: BackendContext,
  principal: Principal,
  agentId: string,
): boolean {
  if (principal.kind === 'system') return true;
  if (principal.kind === 'agent') return false;
  const agent = ctx.authorizationReads.agent(agentId);
  if (!agent) return false;
  return agent.created_by_user_id === principal.userId;
}

/**
 * WHO may edit a workspace-agent's capability set (#task:1777, approved #1775
 * option A). The named composite for the `PUT .../agents/:agentId/capabilities`
 * gate — the third member of the #task:1683 placement-ownership family, built
 * from the SAME two factors as enrollment/removal:
 *
 *   admin(workspace)  ∨  (member(workspace)  ∧  canEnrollAgent(agent))
 *
 * - `admin` governs the WHOLE roster's caps (the roster-authority arm), so it
 *   needs no per-agent ownership.
 * - Otherwise a plain workspace `member` may edit the caps of an agent they
 *   CREATED — the same ownership factor that let them enroll it. The `member`
 *   floor is load-bearing: a non-member creator cannot reach in and edit caps
 *   for a workspace they are not part of (mirrors "cannot enroll into a
 *   workspace you are not in").
 *
 * Deliberately reuses `canEnrollAgent`, NOT `canEditAgent`: the latter has an
 * AGENT-self arm (`principal.agentId === agentId`), which here would let an
 * agent widen its OWN capability set — a self-escalation. `canEnrollAgent`
 * returns `false` for every agent principal, so this predicate can never grant
 * an agent authority over its own caps. A capability-enforcement test locks
 * that (an agent principal is refused even against its own row).
 *
 * Why widening here adds NO new escalation path: enrollment already seeds the
 * FULL default capability set (`defaultCapabilitySet()`), so a creator can
 * already grant their agent everything by placing it. Letting the creator EDIT
 * that set afterward is single-layer last-write-wins, not a new privilege —
 * see docs/graded-permissions-v1.md §2.4.
 *
 * System stays unconditional via both arms; a `user` who is neither admin nor
 * the creator, and any non-member, get `false` (the route maps that to 403).
 */
export function canEditAgentCapabilities(
  ctx: BackendContext,
  principal: Principal,
  workspaceId: string,
  agentId: string,
): boolean {
  if (canGovernWorkspace(ctx, principal, workspaceId, 'admin')) return true;
  return (
    canGovernWorkspace(ctx, principal, workspaceId, 'member') &&
    canEnrollAgent(ctx, principal, agentId)
  );
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
  const reads = ctx.authorizationReads;
  const agent = reads.agent(agentId);
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
    aclPass = reads
      .agentWorkspaceIds(agentId)
      .some(workspaceId => canViewWorkspace(ctx, principal, workspaceId));
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
  // Gates the single attachment-BYTES endpoint
  // (`GET /api/attachments/:id`), which serves the same bytes for both
  // in-message inline PREVIEW and download/Save-As.
  //
  // A MEMBER (or system) reads any blob owned by the channel, including their
  // own not-yet-sent composer upload (draft/orphan) — unchanged.
  if (canViewConversation(ctx, principal, attachment.channel_id)) return true;
  //
  // A PUBLIC non-member's read is scoped to the locked "in-message preview"
  // boundary, NOT "every attachment row under a public channel". The bytes are
  // readable ONLY for an attachment actually referenced by a persisted message
  // in THIS channel. An unsent composer upload (orphan/draft) has no persisted
  // reference and stays closed; a forged cross-channel metadata snapshot cannot
  // reach another channel's blob (the predicate is channel-scoped). "No
  // download / Save As / open external" remains a UI-capability boundary
  // (renderer hides the affordances), NOT a data-confidentiality boundary — a
  // rendered preview IS having the bytes. The channel Attachments PANEL list
  // (`GET /api/channels/:id/attachments`, a member tool) stays
  // `canViewConversation` separately in the route.
  if (!canReadConversation(ctx, principal, attachment.channel_id)) return false;
  return ctx.authorizationReads.isAttachmentReferencedByChannelMessage(
    attachment.id,
    attachment.channel_id,
  );
}

export function canDeleteAttachment(
  ctx: BackendContext,
  principal: Principal,
  attachment: AttachmentAclRow,
): boolean {
  return canMutateOwnAttachment(ctx, principal, attachment);
}

/**
 * Content update, creator-only. Same MEMBER-mutation + creator-ownership rule
 * as delete (see {@link canMutateOwnAttachment}); they diverge only on the
 * `in_use` axis — delete rejects a referenced attachment at the service, update
 * ALLOWS it (updating the bytes of a referenced blob is the whole feature). That
 * distinction is not an ACL concern, so both verbs share this predicate.
 */
export function canUpdateAttachment(
  ctx: BackendContext,
  principal: Principal,
  attachment: AttachmentAclRow,
): boolean {
  return canMutateOwnAttachment(ctx, principal, attachment);
}

/**
 * The shared rule behind every creator-only attachment mutation: a MEMBER
 * mutation (NOT read), gated on strict conversation membership
 * (`canViewConversation`, NOT the read-widened `canViewAttachment`) plus
 * original creator ownership for both actor kinds — otherwise a former uploader
 * removed from the channel could still mutate via the ownership check alone.
 */
function canMutateOwnAttachment(
  ctx: BackendContext,
  principal: Principal,
  attachment: AttachmentAclRow,
): boolean {
  if (!canViewConversation(ctx, principal, attachment.channel_id)) return false;
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
      // The message content stream. A public non-member may
      // receive realtime message content, so this rides the public-aware
      // read gate.
      return canReadConversation(ctx, principal, scope.conversationId);
    case 'conversation-side':
      // The side channel carries agent activity / run-state / status — NOT
      // "conversation content". It stays strictly membership-gated
      // (`canViewConversation`): a public non-member browsing content must
      // not observe the member-only side plane (§12.1#4 consumer-split — the
      // two recovery-class scopes no longer share one gate now that read has
      // widened).
      return canViewConversation(ctx, principal, scope.conversationId);
    case 'viewer':
      return canViewOwnedState(ctx, principal, scope.viewerUserId);
  }
}
