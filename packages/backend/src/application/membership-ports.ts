/**
 * Workspace-membership ports (#task:1982 W5, widened by #task:1987) — the
 * driver-free contract between "this principal's membership of this workspace
 * changes" and persistence. No better-sqlite3 types, no SQL; gated by the
 * db-boundary port-contract suite.
 *
 * #1982 shipped the REMOVE side only. #1987 widens the same contract to the ADD
 * side (conversation add, workspace enrollment, capability seeding, the human
 * channel-join seed) because both sides write the same rows and must therefore
 * take the same mechanism for the same key — see the SYMMETRIC obligation on
 * {@link MembershipUnitOfWork.atomically}. Widening, not a second UnitOfWork:
 * a second one would be a second mechanism, which serializes nothing.
 *
 * ## The coordination anchor is the UnitOfWork's own input
 *
 * Removing a member is not one row: it is the `workspace_members` /
 * `workspace_users` row PLUS every `conversation_agents` / `conversation_users`
 * row of that workspace, plus one audit message per conversation. An add running
 * concurrently writes into the same set. Both sides therefore coordinate on the
 * SAME {@link MembershipCoordinationKey} — one `(workspaceId, member)` pair.
 *
 * Coordination is not something the callback is asked to remember: it is
 * {@link MembershipUnitOfWork.atomically}'s first parameter. The adapter acquires
 * the anchor for that key BEFORE the callback runs and passes what it found in as
 * {@link WorkspaceMembershipAnchor}, and the {@link MembershipTxScope} it hands
 * out is BOUND to the key — which is why every write face below takes no
 * workspace and no member. A caller therefore cannot coordinate on one member and
 * cascade over another, cannot take the anchor late, and cannot skip it; there is
 * no in-scope face that would let it.
 *
 * The anchor is a coordination point, not a precondition: a workspace with
 * dangling conversation rows and no membership row is still cleaned up (that is
 * what the pre-#1982 route did, and the recompute makes it authoritative). An
 * ABSENT anchor row is exactly why "lock the membership row" is not, on its own,
 * an acceptable mechanism — see {@link MembershipUnitOfWork.atomically}.
 */
import type {
  ChannelAttentionMode,
  ConversationKind,
  ConversationVisibility,
  MessageDto,
  WorkspaceMemberDto,
  WorkspaceRoleDto,
  WorkspaceUserMemberDto,
} from '@silverhand/shared';

/** Whose membership changes. `kind` selects the physical membership tables AND
 *  the in-transaction capability set; the domain never names either. */
export type AgentMemberRef = { kind: 'agent'; id: string };
export type HumanMemberRef = { kind: 'human'; id: string };
export type WorkspaceMemberRef = AgentMemberRef | HumanMemberRef;

/**
 * The two conversation fields the cascade needs: the id it removes rows from and
 * the workspace the publish plan reports. Deliberately NOT a `ConversationDto` —
 * titles, visibility, archive state and the dm-channel subquery are not inputs
 * to a membership removal, so the decision cannot start depending on them.
 */
export interface MembershipConversationRef {
  id: string;
  workspace_id: string;
}

/** Read-only face, safe OUTSIDE a transaction. */
export interface WorkspaceMembershipReadPort {
  /**
   * NON-LOCKING list of the workspace's conversations that currently contain the
   * member. It is a HINT for the pre-commit runtime-stop pass and nothing else:
   * by the time the transaction runs it may name a conversation the member has
   * left and miss one the member just joined, which is why the cascade recomputes
   * the set with {@link WorkspaceMembershipTxPortBase.listConversationsWithMemberForUpdate}
   * instead of carrying this list into the scope.
   */
  listConversationsWithMember(
    workspaceId: string,
    member: WorkspaceMemberRef,
  ): MembershipConversationRef[];
}

/** The coordination key: whose membership in which workspace this transaction is
 *  allowed to touch. One key per transaction — it selects the anchor, picks the
 *  member-kind-specific scope AND scopes every write face below. */
export type MembershipCoordinationKey<M extends WorkspaceMemberRef = WorkspaceMemberRef> = {
  workspaceId: string;
  member: M;
};

/** What the anchor read found, handed to the callback by the UnitOfWork itself.
 *  `role` is the human governance role and is always `null` for an agent. The
 *  callback receives `null` when there is NO workspace-membership row — the
 *  cascade still runs, to clean dangling conversation rows.
 *
 *  This is the ONLY admissible source for "is the member in the workspace" inside
 *  the transaction, on the add side as much as the remove side: it is read under
 *  the mechanism, so it cannot have changed since. A membership read taken before
 *  `atomically` may refuse a request early — an authorization gate should not take
 *  a write lock to say no — but if it also decided a write, a concurrent removal
 *  landing in between would produce states no serial order can: a conversation row
 *  for a non-member, or a workspace enrollment with no channel placement. */
export type WorkspaceMembershipAnchor = {
  role: WorkspaceRoleDto | null;
};

/** A membership audit message, composed in domain language by the caller. */
export interface MembershipAuditMessageInput {
  conversationId: string;
  content: string;
  metadata: Record<string, unknown>;
}

/**
 * The in-transaction faces COMMON to both member kinds: the authoritative
 * recompute and the writes whose physical table is selected by `key.member.kind`.
 * Every face is scoped to the {@link MembershipCoordinationKey} the enclosing
 * {@link MembershipUnitOfWork.atomically} coordinated on, so none of them names a
 * workspace or a member — acting on an uncoordinated pair is not expressible.
 *
 * A `conversationId` argument is the ONE remaining way to name something the key
 * does not: the coordination axis is the workspace, so a conversation of ANOTHER
 * workspace would be a write outside the mechanism this transaction holds (lock A,
 * write B). Every face taking one is therefore required to verify the conversation
 * belongs to `key.workspaceId` and to FAIL LOUDLY otherwise — throw, so the whole
 * transaction rolls back. Not filtering and not a silent no-op: a caller that
 * reached for another workspace's conversation is wrong, and half of its intended
 * writes must not commit. A conversation that does not exist at all is not a
 * coordination violation (it may have been deleted concurrently), and each face
 * below states what it does with one.
 *
 * A cascade helper that works for either kind takes THIS type; the kind-specific
 * scopes below add only what one kind can express.
 */
export interface WorkspaceMembershipTxPortBase {
  /** AUTHORITATIVE, in-scope recompute of the conversations to cascade through.
   *  Every audit message and every publish is derived from THIS list. */
  listConversationsWithMemberForUpdate(): MembershipConversationRef[];
  /**
   * Insert the coordinated member's row in this conversation (idempotent).
   *
   * `created` is the AUTHORITATIVE answer to "was this a fresh entry", decided by
   * the adapter under the coordination mechanism. It exists because the callers'
   * follow-up writes are NOT re-entrant — the join-time read-cursor baseline
   * advances a monotonic cursor, and an audit message / member-added event must be
   * emitted exactly once — so that decision may not rest on a read taken before
   * the lock. A pre-transaction `getAgent`/`getUser` is admissible for refusing a
   * request early; it must never decide a write.
   */
  addConversationMember(conversationId: string): { created: boolean };
  /**
   * Delete the coordinated member's row in this conversation (idempotent).
   *
   * `removed` is the mirror of `created` and exists for the same reason: an audit
   * message and a `conversation_members_changed` fan-out are exactly-once effects,
   * so a SECOND concurrent removal must emit neither. Two serial removals leave the
   * second one a no-op; a duplicate removal audit is a state no serial order
   * produces. `false` for a member that was already gone, including a conversation
   * that no longer exists.
   */
  removeConversationMember(conversationId: string): { removed: boolean };
  /** Insert a `conversation_member_added` / `conversation_member_removed` system
   *  message. Content and metadata are composed by the caller — wording is domain
   *  language, not persistence. */
  insertMembershipAuditMessage(input: MembershipAuditMessageInput): MessageDto;
  /** Delete the coordinated workspace-membership row itself (idempotent). */
  removeWorkspaceMembership(): void;
}

/**
 * Agent scope. `insertWorkspaceMembership` and `seedCapabilityDefaults` are TWO
 * faces on purpose: "seed the default capability set only when the row was
 * actually created" is a domain policy (re-adding a member must not re-widen a
 * narrowed set), so the `if (created)` decision stays in the use case and the
 * adapter keeps no policy at all.
 */
export interface AgentMembershipTxPort extends WorkspaceMembershipTxPortBase {
  readonly memberKind: 'agent';
  insertWorkspaceMembership(): { member: WorkspaceMemberDto; created: boolean };
  seedCapabilityDefaults(): void;
}

/**
 * Human scope. Humans carry a governance role, a per-channel attention
 * preference and read cursors; agents carry none of the three, which is why this
 * is a different scope type rather than an optional face set.
 */
export interface HumanMembershipTxPort extends WorkspaceMembershipTxPortBase {
  readonly memberKind: 'human';
  /** Insert the workspace-membership row at the default `member` role
   *  (idempotent). Role PROMOTION is not a membership write and is not here. */
  addWorkspaceMembership(): WorkspaceUserMemberDto;
  /** Seed this viewer's channel attention preference if they have none yet. */
  insertAttentionPreferenceIfAbsent(input: {
    conversationId: string;
    mode: ChannelAttentionMode;
  }): void;
  /** Every stream (channel + thread roots) of a conversation with its latest
   *  seq — the input to the join-time "start read, not unread" cursor seed. */
  listStreamHeads(conversationId: string): MembershipStreamHead[];
  /** Advance this viewer's read cursor for one stream (monotonic `max()`). */
  markStreamRead(input: {
    conversationId: string;
    threadRootId: string | null;
    seq: number;
  }): void;
  /**
   * The facts the channel EXIT rule branches on, for the coordinated human, read
   * under the mechanism. The rule itself stays in the domain — this face answers
   * only "what is true right now", never "may they leave".
   *
   * It exists because the exit rule is not idempotent in the way an edge delete is:
   * `last_human_member` and `channel_owner` protect a state ("a private channel with
   * no human in it") that NO serial order of two legal removals can reach, so a
   * decision taken before the lock is not merely stale, it is unsound. Read as ONE
   * face rather than three so the answers cannot come from three different points
   * in the transaction.
   *
   * `channel` is `null` when the conversation no longer exists; the rule reads that
   * as "there is no edge to end".
   */
  readChannelExitFacts(conversationId: string): MembershipChannelExitFacts;
}

/** The channel-shape fields the exit rule branches on. Deliberately NOT a
 *  `ConversationDto`: titles, ordering and the dm-channel subquery are not inputs
 *  to an exit decision. */
export interface MembershipChannelExitFacts {
  channel: {
    kind: ConversationKind;
    visibility: ConversationVisibility;
    archived_at: number | null;
  } | null;
  /** Does the coordinated member still hold an edge in this conversation? */
  isMember: boolean;
  /** How many HUMAN edges the conversation has (`conversation_users` IS the
   *  human-membership table, so its row count is the human count). */
  humanMemberCount: number;
}

/** Who is ASKING for a membership write — never the member being written (that is
 *  the coordination key). Only the actor's mutable authority facts are readable
 *  through {@link MembershipAuthorityTxPort}. */
export type MembershipActorRef =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string };

/**
 * The MINIMAL authority projection: the two MUTABLE facts every membership
 * authorization rule in this workspace is built from, read INSIDE the transaction.
 *
 * Its reason to exist is that an authorization gate and the write it authorizes are
 * two different points in time. The gates run before `atomically` on purpose — a
 * refusal must not take a write lock — but an actor can be removed from the channel
 * or demoted in the seam between them, and then a write nobody currently authorizes
 * commits. So a path that is about to WRITE re-derives its rule here, from facts
 * read under the mechanism; the pre-lock gate degrades to a cheap early reject.
 *
 * Deliberately facts, not verdicts: `may this principal add that member` is domain
 * policy and stays in the use case, which is also why the immutable half of every
 * rule (an agent's creator, the actor's own identity, the conversation's kind) is
 * NOT here — it cannot be invalidated by a roster write, so carrying it in is safe.
 * Scoped to the coordination key's workspace, so it can no more answer about another
 * workspace than the write faces can act on one.
 */
export interface MembershipAuthorityTxPort {
  /** The actor's authoritative `workspace_users.role` in the coordinated
   *  workspace, or `null` when they hold no row there. A role row IS workspace
   *  membership, so `null` also answers "not a member". */
  humanWorkspaceRole(userId: string): WorkspaceRoleDto | null;
  /** Does the ACTOR hold a membership edge in this conversation — the visibility
   *  floor every roster write sits on. Same workspace-binding obligation as the
   *  write faces; `false` for a conversation that no longer exists. */
  isConversationMember(conversationId: string, actor: MembershipActorRef): boolean;
}

/** One stream of a conversation and its latest sequence number. */
export interface MembershipStreamHead {
  threadRootId: string | null;
  latestSeq: number;
}

/**
 * The ROSTER scope: membership writes for MORE THAN ONE subject, coordinated on
 * the workspace alone (#task:1987).
 *
 * It exists because one path genuinely needs it. The mention-CC placement writes
 * three rows for TWO subjects — the mentioned agent's channel edge, the author's
 * channel edge, and the author's workspace-membership row — and they must commit
 * together: the whole point is that the author can read a DM that is about their
 * own mention. A {@link MembershipCoordinationKey} names ONE member, so that
 * placement is not expressible under it; splitting it into two per-principal
 * transactions would commit twice, and a failure in between leaves a channel edge
 * belonging to a workspace non-member — precisely the state the anchor rule exists
 * to prevent.
 *
 * So the coordination axis WIDENS to the workspace while the mechanism stays the
 * same one (see {@link WorkspaceRosterUnitOfWork.atomicallyForWorkspace}). Two
 * scopes, one mechanism — not two mechanisms, which would serialize nothing.
 *
 * There is no anchor here, and that is structural rather than an omission: an
 * anchor is "this member's membership as of the lock", and this scope has no
 * single member to read one for. Each face therefore answers its own
 * `created` from under the lock, which is the same guarantee for the same reason.
 *
 * The workspace-binding obligation is IDENTICAL to the per-principal scope's: a
 * `conversationId` naming another workspace's conversation is a write outside the
 * mechanism this transaction holds, so every face taking one must throw and roll
 * the whole transaction back. Both scopes are required to share one implementation
 * of that check — a second copy is a second thing to get wrong.
 *
 * It carries no {@link MembershipAuthorityTxPort} because no caller of it
 * authorizes an ACTOR: the mention itself is the placement's authority. A future
 * caller that does authorize one widens this scope with the same projection the
 * per-principal scopes carry; it does not need a third scope.
 */
export interface WorkspaceRosterTxPort {
  /**
   * Insert `member`'s row in this conversation (idempotent). `created` is decided
   * under the mechanism, for the same reason as
   * {@link WorkspaceMembershipTxPortBase.addConversationMember}: the callers'
   * follow-up effects (a `workspace_channels_changed` fan-out) are exactly-once,
   * so that answer may not come from a read taken before the lock.
   */
  addConversationMember(
    conversationId: string,
    member: WorkspaceMemberRef,
  ): { created: boolean };
  /** Insert a human's workspace-membership row at the default `member` role
   *  (idempotent). The role is part of this face's identity: no caller of the
   *  roster scope grants governance. */
  addWorkspaceHumanMembership(userId: string): void;
}

export interface WorkspaceRosterTxScope {
  roster: WorkspaceRosterTxPort;
}

/**
 * The roster half of the UnitOfWork, split out as its own interface so a caller
 * that only needs it (mention-CC) depends on exactly that and cannot reach the
 * per-principal faces. {@link MembershipUnitOfWork} extends it, so there is still
 * ONE object — one mechanism — behind both.
 */
export interface WorkspaceRosterUnitOfWork {
  /**
   * Atomic AND serializing on the WORKSPACE. The adapter owes the same mechanism
   * {@link MembershipUnitOfWork.atomically} owes, taken before the callback's
   * first statement; there is no anchor read because this scope has no single
   * member.
   *
   * The mechanism must be the SAME one the per-principal key takes, or the two
   * scopes do not exclude each other and neither is coordinated. Per engine:
   *  - SQLite (this repo): root-only `BEGIN IMMEDIATE` — the write lock is
   *    file-wide, so a per-principal transaction and a roster transaction already
   *    exclude each other with nothing extra.
   *  - Pooled / PostgreSQL: this NARROWS the menu on `atomically`. The
   *    per-principal key's lock must be derived from the WORKSPACE half of the key
   *    (`FOR UPDATE` on the `workspaces` row, or `pg_advisory_xact_lock` over
   *    `workspaceId`) — a lock derived from `(workspaceId, member)` would let a
   *    roster transaction and a per-principal transaction for a member IN that
   *    roster run concurrently. Locking the membership row in addition is fine; it
   *    may not be what the two scopes agree on.
   */
  atomicallyForWorkspace<T>(
    workspaceId: string,
    fn: (tx: WorkspaceRosterTxScope) => T,
  ): T;
}

/** What every scope carries regardless of member kind: the actor-authority
 *  projection. It is a SEPARATE face from `membership` because it is about a
 *  different subject — who is asking, not who is being written. */
export interface MembershipTxScopeBase {
  authority: MembershipAuthorityTxPort;
}

export interface AgentMembershipTxScope extends MembershipTxScopeBase {
  membership: AgentMembershipTxPort;
}

export interface HumanMembershipTxScope extends MembershipTxScopeBase {
  membership: HumanMembershipTxPort;
}

export type MembershipTxScope = AgentMembershipTxScope | HumanMembershipTxScope;

/**
 * The scope a member kind buys. Written as a mapping from the KEY's member type
 * so one signature serves both a statically-known kind (an add path always knows
 * whose membership it writes → the precise scope) and a runtime-only kind (the
 * cascade → the union, i.e. the common faces). Nothing else needs to exist: an
 * agent key cannot reach the human faces because this type never produces them.
 */
export type MembershipTxScopeFor<M extends WorkspaceMemberRef> = M extends AgentMemberRef
  ? AgentMembershipTxScope
  : M extends HumanMemberRef
    ? HumanMembershipTxScope
    : never;

export interface MembershipUnitOfWork extends WorkspaceRosterUnitOfWork {
  /**
   * Atomic AND serializing. The adapter owes three things, in this order, before
   * the callback's first statement: (1) take the isolation mechanism for `key`,
   * (2) read the anchor under it, (3) build a scope bound to `key`.
   *
   * The mechanism must not depend on the anchor row EXISTING, because a missing
   * membership row is a supported input. Per engine:
   *  - SQLite (this repo): root-only `BEGIN IMMEDIATE`. The write lock is taken at
   *    BEGIN against the whole database, before any statement and regardless of
   *    which rows exist, so absence is not a hole. Nested use is refused loudly:
   *    inside an open transaction `.immediate()` degrades to a savepoint that
   *    takes no lock, and the anchor would then rest on nothing.
   *  - Pooled / PostgreSQL: `SELECT ... FOR UPDATE` on the membership row is NOT
   *    sufficient alone — a row that does not exist cannot be locked, and NOTHING
   *    serializes two writers that both find it missing. Such an adapter must use
   *    a mechanism that exists for every key: `FOR UPDATE` on the `workspaces`
   *    row (a fixed coordination row that always exists for a valid key), a
   *    transaction-scoped advisory lock derived from the key
   *    (`pg_advisory_xact_lock`), or SERIALIZABLE with retry on serialization
   *    failure. Locking the membership row too is fine; it may not be the only
   *    thing.
   *
   * The obligation is SYMMETRIC: every writer of this member's workspace or
   * conversation membership — the add path included — must take the same
   * mechanism for the same key. A lock one side takes alone serializes nothing.
   * Under this repo's single in-process connection that symmetry is free (two
   * transactions cannot be open at once); an engine change or a pooled adapter
   * inherits the obligation explicitly.
   *
   * The scope handed to the callback is selected by the key's member kind: an
   * agent key can never reach the human read-cursor / attention faces and a human
   * key can never reach capability seeding (see {@link MembershipTxScopeFor}). A
   * caller whose kind is only known at runtime — the cascade — receives the union,
   * i.e. exactly the faces both kinds share. `as` casts across the two scopes are
   * a review failure, not a workaround.
   *
   * Both kinds also carry {@link MembershipAuthorityTxPort}: the same mechanism that
   * makes the anchor authoritative makes the actor's authority facts authoritative,
   * so a path about to write re-derives its authorization from inside here instead of
   * trusting a boolean captured before the lock.
   */
  atomically<M extends WorkspaceMemberRef, T>(
    key: MembershipCoordinationKey<M>,
    fn: (tx: MembershipTxScopeFor<M>, anchor: WorkspaceMembershipAnchor | null) => T,
  ): T;
}

export interface MembershipPersistence {
  read: WorkspaceMembershipReadPort;
  uow: MembershipUnitOfWork;
}
