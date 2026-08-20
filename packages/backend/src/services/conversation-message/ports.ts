/**
 * Conversation-message application ports — the driver-free contract between
 * message orchestration (send / freshness / thread-follow / delivery) and
 * persistence. Same discipline as `services/task/ports.ts`: no driver types,
 * no SQL, and the ENTIRE relative import closure of this module stays
 * driver-free (gated by the db-boundary port-contract suite). That is why the
 * argument/return shapes below are declared here rather than imported from
 * `repos/*` — every repo module types `better-sqlite3`.
 *
 * Capability separation (#task:1981 design contract v3.1):
 *  - everything the send / materialize / thread-follow transaction callbacks
 *    touch exists ONLY on `MessageTxScope`, bound to the current transaction;
 *  - the callback-free surfaces (voluntary follow/unfollow/state, delivery
 *    fan-out, notifications) get their own narrow read / direct-write ports;
 *  - `MessageTxScope` carries NOTHING a callback does not actually call —
 *    surplus capability is how a future application ends up reading
 *    transactionally by accident (R3);
 *  - post-commit EFFECTS (`ConversationUnreadPublishPort`, the runtime wake)
 *    are deliberately NOT reachable from the scope, so a tx callback cannot
 *    publish (R1/§6). The converse is not a rule: a WRITE whose loss the domain
 *    cannot tolerate belongs in the transaction, which is why the mention CC
 *    copy and its `mention_external` row moved onto the scope in v71 (§5) and
 *    only their WS/runtime effects stayed outside.
 */
import type {
  AgentDto,
  AttachmentSnapshot,
  ConversationAgentStatus,
  ConversationDto,
  ConversationEndpointIdentity,
  ConversationEndpointRef,
  FromKind,
  MessageDto,
  NotificationDto,
  NotificationKind,
  Reference,
  ThreadFollowerSource,
  ThreadSummaryInvariant,
} from '@silverhand/shared';
import type { AttachmentSnapshotSource } from '../attachment/snapshot-resolution.js';

/** The display identity of a message author / mention target — the ONLY user
 *  facts the message domain may see. The persistence adapter must PROJECT onto
 *  this shape: `UserRow` is a structural supertype, so a bare return would
 *  type-check while still handing the application `email`, `avatar_storage_key`
 *  and `last_seen_at` at runtime — a type-level narrowing is not an R4
 *  boundary. */
export interface PrincipalNameSnapshot {
  id: string;
  name: string;
  display_name: string;
}

/** Message insert arguments. Structurally identical to `MessageRepo`'s
 *  parameter object; see that method for the freshness-universe semantics of
 *  `freshnessExempt` and the stream-head invariant. */
export interface MessageInsertArgs {
  conversationId: string;
  fromKind: FromKind;
  fromAgentId?: string | null;
  fromUserId?: string | null;
  content: string;
  metadata?: Record<string, unknown> | null;
  attachments?: AttachmentSnapshot[] | null;
  threadRootId?: string | null;
  freshnessExempt?: boolean;
  /** Set ONLY by the in-transaction mention CC write (v71, §5): the source
   *  message this row copies. The partial UNIQUE on
   *  `(cc_source_message_id, conversation_id)` is what makes "one copy per
   *  DESTINATION conversation" a schema fact — since #task:2072 the destination
   *  is the author↔agent `direct_pair`, so one source message mentioning two
   *  agents still lands one copy in each of the two lines, and a retry lands
   *  none. */
  ccSourceMessageId?: string | null;
}

/** Message reads + writes available INSIDE a transaction. */
export interface MessageTxMessagesPort {
  insertForConversation(args: MessageInsertArgs): MessageDto;
  getInConversation(conversationId: string, messageId: string): MessageDto | null;
  replyCountsByRoot(
    conversationId: string,
    rootMessageIds: readonly string[],
  ): Record<string, number>;
  threadListEntryForRoot(
    conversationId: string,
    rootId: string,
  ): ThreadSummaryInvariant | null;
  listStreamBelowSeq(
    conversationId: string,
    threadRootId: string,
    beforeSeq: number,
  ): MessageDto[];
}

export interface MessageTxConversationsPort {
  get(conversationId: string): ConversationDto | null;
  /**
   * THE main-line recipient enumeration: the ids of this conversation's LIVE
   * AGENT PARTICIPANTS (#task:2021 P4-5).
   *
   * Two conjuncts, from the one placement authority: participation by placement
   * (§4.2) AND a live `agents` row. Participation alone is the wrong set for
   * delivery — it ignores an endpoint tombstone on purpose so a survivor can still
   * READ its DM — and the roster listing this replaced (`listAgents`) was the wrong
   * set in the other direction: rosterless placements enumerated to nothing, so a
   * DM message reached no recipient at all.
   *
   * Ids only; see `MessageRecipient` for why the membership DTO is not the
   * recipient unit.
   */
  listParticipantAgentIds(conversationId: string): string[];
  /**
   * PARTICIPATION — is this agent one of the conversation's participants, judged
   * by its PLACEMENT (agent-scoped-session-v1 §4.2)? THE write gate's membership
   * conjunct, and deliberately NOT "is there a roster row": a `direct_pair` has
   * no roster rows by construction, so the roster-only
   * predicate the write gate used to ask instead (`getAgent`, below) refused
   * every agent send into a DM, which is the same fact as `dm:@handle` not
   * working at all (#task:2021 P4-4 finding (b)).
   *
   * Answers from the one participation authority
   * (`repos/conversation-placement-sql.ts`), never from a rule restated in the
   * application: a stray roster row on a non-workspace placement is inert there,
   * and the workspace arm's participants ARE its roster rows.
   */
  isAgentParticipant(conversationId: string, agentId: string): boolean;
  /**
   * PARTICIPATION for the HUMAN actor kind — the SAME conjunct of the SAME gate,
   * and it is on this scope because leaving it at the route was itself the
   * defect: `canPostToConversation` answers before the transaction opens, so
   * a person removed from the channel — or from the workspace — in the gap still
   * wrote, and a direct service caller was never gated at all.
   *
   * Answers from the one participation authority
   * (`repos/conversation-placement-sql.ts`), whose human arms are the v25 PAIR
   * (`conversation_users` seat AND `workspace_users` membership) for the workspace
   * placement and the `human` endpoint for a `direct_pair`. Those are the only
   * human arms there are: participation is never inferred from
   * `created_by_user_id`, which is management authority and not a message ACL.
   */
  isUserParticipant(conversationId: string, userId: string): boolean;
  /**
   * The endpoint columns the write gate's `direct_pair` narrowing reads — the
   * projected input of shared's `directPairIsReadOnlyForSurvivor`, which is the
   * one definition of "a DM whose other side is gone is read-only". `null` when
   * the row does not exist.
   *
   * The RULE is not on this port and neither is its answer: an adapter that
   * returned the boolean would be a second authority, and the request-layer gate
   * (`canPostToConversation`) would then be free to drift from the transaction's.
   */
  endpointFacts(conversationId: string): ConversationEndpointRef | null;
  /** The lookup half of the same narrowing — see
   *  `repos/endpoint-principal-presence.ts` for why it is kind-directed and why
   *  both faces share one dispatch. */
  endpointPrincipalExists(endpoint: ConversationEndpointIdentity): boolean;
  /**
   * The MINT half of `openDirectPair`, transaction-scoped (#task:2072).
   *
   * The mention CC's destination is the pair "source author ↔ mentioned agent",
   * and it must come into existence in the SOURCE SEND's own transaction: the copy
   * is written there (§5), so a rolled-back send must leave no line behind either.
   *
   * The ANNOUNCEMENT is deliberately NOT here — this bundle carries no effect
   * capability by construction — so the CC hands the mint the transaction-aware
   * `DirectPairOpenedPort` (`recordDirectPairOpens`) and its post-commit half
   * publishes what that recorded.
   *
   * Id only, for the same reason the retired `agentInbox` projection was id only:
   * the write needs a destination, not a row.
   */
  getOrCreateDirectPair(
    x: ConversationEndpointIdentity,
    y: ConversationEndpointIdentity,
    now: number,
  ): { conversation: { id: string }; created: boolean };
}

/** The workspace facts the send transaction needs — the NAME only, for the
 *  mention CC wrap and the `mention_external` payload's denormalized label.
 *  Nothing on the send path is authorized BY a workspace read (capability and
 *  membership gates run in the route/service before the transaction opens), so
 *  a wider face here would only invite one. */
export interface MessageTxWorkspacesPort {
  nameOf(workspaceId: string): string | null;
}

/** The notification writes the send transaction performs. Named after the
 *  domain act, so `kind = 'mention_external'` is decided by WHICH method is
 *  called and cannot drift per call site.
 *
 *  `mention_external` is committed WITH the source message (§5): a human being
 *  told "your mention reached that agent" is a consequence of the send, and a
 *  post-commit insert loses it outright if the process dies in the gap.
 *  Contrast `DeliveryWritePort.insertNotification`, which serves post-commit
 *  kinds (`agent_start_failed`) whose trigger is not the send itself. */
export interface MessageTxNotificationsPort {
  insertMentionExternal(args: MentionExternalNotificationArgs): void;
}

/**
 * The `mention_external` row's shape — settled product contract (shiki,
 * 2026-08-14, "option A"):
 *
 *   - the VIEWER is the source message's author. The mention is theirs, and
 *     since #task:2072 the copy lands in the author↔agent `direct_pair`, whose
 *     only human endpoint IS that author — so nobody else could receive this
 *     notification. (Under the retired `agent_inbox` the same conclusion held
 *     for the opposite reason: no human was a participant at all, §4.2.)
 *   - the JUMP TARGET is the SOURCE message — `(conversationId, messageId)` name
 *     the source, never the copy. NOT because the copy is unreachable: the
 *     author can now read the line it lands in. The source is where the
 *     surrounding context is, and the copy is already in front of a reader who
 *     opened that line (the same reading the card's own origin link states,
 *     #task:2089).
 *
 * Hence no `workspaceId` argument either: the source conversation's workspace is
 * the only workspace involved, and a `direct_pair` has none.
 */
export interface MentionExternalNotificationArgs {
  /** The author of the source message — the viewer of this notification. */
  userId: string;
  /** The agent that was mentioned — the copy's other endpoint, for list
   *  rendering. */
  agentId: string;
  sourceWorkspaceId: string;
  sourceConversationId: string;
  sourceMessageId: string;
  payload: {
    source_workspace_name: string;
    source_conversation_title: string;
    mention_excerpt: string;
  };
}

export interface ThreadFollowerUpsertArgs {
  threadRootId: string;
  conversationId: string;
  principalKind: 'human' | 'agent';
  principalId: string;
  source: ThreadFollowerSource;
}

/** Follower writes/reads available inside a transaction.
 *  `listFollowerAgentIdsParticipating` is here because the send path's
 *  follower-gated delivery plan is computed at the END of the same transaction
 *  that inserts the follower rows — reading it through a captured factory repo
 *  would compute the plan against a different connection's snapshot.
 *  `remove` / `isFollower` are deliberately absent: no transaction callback calls
 *  them (R3). */
export interface MessageTxThreadFollowersPort {
  upsert(args: ThreadFollowerUpsertArgs): { inserted: boolean };
  /** Follower agents that are CURRENT LIVE PARTICIPANTS, as ids — the delivery
   *  gate, not a roster projection (#task:2021 P4-5). */
  listFollowerAgentIdsParticipating(threadRootId: string): string[];
}

/** Attachment ownership/labelling facts needed to stamp snapshots on a
 *  message, projected off the physical row by the adapter (R4). The shape and
 *  the decision that consumes it live in the driver-free
 *  `services/attachment/snapshot-resolution.ts` leaf. */
export interface AttachmentSnapshotSourcePort {
  listSnapshotSourcesByIds(ids: string[]): AttachmentSnapshotSource[];
}

/** The transaction-scoped capability bundle. ALL persistence inside an
 *  `atomically` callback MUST come from this scope — never a captured factory
 *  repo (a future pooled adapter would read/write on the wrong connection).
 *  There is no effect capability here BY CONSTRUCTION. */
export interface MessageTxScope {
  messages: MessageTxMessagesPort;
  conversations: MessageTxConversationsPort;
  workspaces: MessageTxWorkspacesPort;
  notifications: MessageTxNotificationsPort;
  agents: { get(agentId: string): AgentDto | null; getByName(name: string): AgentDto | null };
  /** `get` is the LIVENESS reading (#task:2021 P4-5): the
   *  human twin of `agents.get`, so `follower ⊆ LIVE participant` can be one
   *  conjunction per principal kind instead of a participation check that a
   *  tombstoned principal passes on purpose. */
  users: {
    get(userId: string): PrincipalNameSnapshot | null;
    getByName(name: string): PrincipalNameSnapshot | null;
  };
  inboxes: {
    ensureDelivery(
      conversationId: string,
      agentId: string,
      messageId: string,
      deliveryKind?: 'turn' | 'observe',
    ): void;
    /** Freshness guard (#task:2095), conversation-scope arm: does this agent
     *  have ANY undelivered inbox row in this (bound/source) conversation?
     *  Boolean existence, never a seq — immune to rowid reuse. */
    hasUndeliveredForPair(conversationId: string, agentId: string): boolean;
    /** Freshness guard (#task:2095), agent-scope arm: does this agent-runtime
     *  have ANY undelivered inbox row across ALL its conversations? */
    hasUndeliveredForAgent(agentId: string): boolean;
    /** Reject-path diagnostic COUNT companions of the two guard arms
     *  (#task:2095 F13). SAME predicate as `hasUndeliveredFor*`
     *  (in_flight rows included) — read ONCE on the throw path to stamp the
     *  "freshness guard rejected send" WARN, never on the hot path and never
     *  onto the 409 (the agent surface stays signal-only). */
    countQueuedForPair(conversationId: string, agentId: string): number;
    countQueuedForAgent(agentId: string): number;
  };
  threadFollowers: MessageTxThreadFollowersPort;
  attachments: AttachmentSnapshotSourcePort;
}

/** Atomic write boundary for the message domain, and — since #task:2021 P4-4 —
 *  a COMMIT-TIME AUTHORITY boundary.
 *
 *  ATOMICITY is the easy half. The load-bearing half is that the write gate
 *  (`assertPostAuthority`: lifecycle ∧ participation ∧ not-survivor-read-only)
 *  reads facts OWNED BY OTHER AGGREGATES — the conversation's lifecycle columns,
 *  the roster / endpoint / workspace-membership rows behind participation, the
 *  existence of the peer principal — and then writes on the strength of those
 *  reads. "The read happens inside the callback" is a statement about SOURCE
 *  POSITION, not about concurrency: under a deferred BEGIN no lock is held while
 *  those reads run, so a rival connection can revoke the seat, archive the
 *  conversation or delete the peer in the gap and the insert still lands. That is
 *  the same class of defect the gate was created to remove, one layer down.
 *
 *  THE OBLIGATION, therefore, is on the implementation and not on its callers:
 *  every fact this domain's callbacks READ BEFORE WRITING must still hold when the
 *  transaction commits. An adapter discharges it by a MECHANISM it can name —
 *  serialization (a write lock taken at BEGIN), a locking read, or a conditional
 *  write — never by "there is usually one writer". The SQLite composition takes
 *  the file-wide write lock at BEGIN (`BEGIN IMMEDIATE`, root-only) and
 *  `tests/repos/conversation-persistence.test.ts` points a second connection at
 *  it; a pooled/PG adapter must choose per read between `SERIALIZABLE`, `SELECT …
 *  FOR UPDATE` on the conversation row and its roster edge, or re-asserting the
 *  predicate in the INSERT's `WHERE`.
 *
 *  The freshness guard (#task:2095, `hasUndeliveredFor{Pair,Agent}`) is NOT that
 *  mechanism and never was: it covers exactly one fact — whether this runtime
 *  still holds undelivered input — and fails closed with its own error. An
 *  adapter may not infer that it also stabilises the gate's reads. */
export interface MessageUnitOfWork {
  atomically<T>(fn: (tx: MessageTxScope) => T): T;
}

/** Reads for the voluntary follow/unfollow/state surface — none of which runs
 *  inside a transaction (each is a single statement plus a root lookup). */
export interface ThreadFollowReadPort {
  getMessageInConversation(
    conversationId: string,
    messageId: string,
  ): MessageDto | null;
  isFollower(
    threadRootId: string,
    principalKind: 'human' | 'agent',
    principalId: string,
  ): boolean;
  /** Follower agents that are CURRENT LIVE PARTICIPANTS, as ids — the same read
   *  the in-transaction plan uses, for the read surface that lists a thread's
   *  follower agents. */
  listFollowerAgentIdsParticipating(threadRootId: string): string[];
}

/** The callback-free follower write surface: the VOLUNTARY UNFOLLOW, and
 *  nothing else.
 *
 *  There is no `upsert` here (#task:2021 P4-5). Creating a
 *  follower row requires the `follower ⊆ live participant` gate and — for an
 *  agent — the history backfill in the same transaction, so every insertion path
 *  goes through the aggregate's in-transaction funnels. A direct-write upsert was
 *  a SECOND WRITER around that gate, and the route's earlier `canViewConversation`
 *  is a capability token, not the placement authority. Removal needs neither: it
 *  can only narrow delivery, and it is idempotent. */
export interface ThreadFollowDirectWritePort {
  remove(
    threadRootId: string,
    principalKind: 'human' | 'agent',
    principalId: string,
  ): { removed: boolean };
}

/** Reads the post-commit delivery/notification path needs. All of it runs
 *  AFTER the send transaction committed, so none of it belongs on the scope.
 *
 *  No `getWorkspace`: the only post-commit consumer was the mention CC's
 *  workspace-name lookup, which is now an in-transaction read on
 *  `MessageTxWorkspacesPort` — the copy is named after the workspace as it was
 *  when the message committed, not as it is whenever the effects happen to run. */
export interface DeliveryReadPort {
  getConversation(conversationId: string): ConversationDto | null;
  getMessageById(messageId: string): MessageDto | null;
  getAgent(agentId: string): AgentDto | null;
  getUser(userId: string): PrincipalNameSnapshot | null;
  /**
   * The agent's CURRENT RUNTIME SEAT STATUS for this conversation — the idle
   * auto-start decision's input (#task:2021 P4-5).
   *
   * The seat, not the roster row: `conversation_agents.status` (as projected onto
   * the membership DTO) exists only for a workspace placement, so the pre-filter
   * this replaced could not answer the question for a DM participant at all — and
   * the recipient unit no longer carries a status column to read. The adapter
   * resolves WHICH seat through `runtimeSlotScopeFor`, because an agent-scoped
   * session has one seat serving every conversation.
   *
   * `null` = no seat row for that scope, which the caller treats as startable —
   * "which statuses count as running" is a domain rule and stays with the caller.
   */
  runtimeSeatStatus(
    conversationId: string,
    agentId: string,
  ): ConversationAgentStatus | null;
  /** Human viewers of a conversation (workspace-scoped resolution lives in
   *  the adapter). */
  viewerUserIds(conversationId: string): string[];
}

export interface InsertNotificationArgs {
  kind: NotificationKind;
  userId?: string | null;
  agentId?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  sourceWorkspaceId?: string | null;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface DeliveryWritePort {
  insertNotification(args: InsertNotificationArgs): NotificationDto;
  ensureDelivery(
    conversationId: string,
    agentId: string,
    messageId: string,
    deliveryKind?: 'turn' | 'observe',
  ): void;
}

/** Cross-channel cc fan-out for `@mentions` of members of OTHER channels — the
 *  RETIRED port shape (v71, #task:2014). The CC copy is no longer a post-commit
 *  effect that re-enters persistence through its own adapter: the copy, its
 *  durable inbox delivery row and its `mention_external` notification are all
 *  written inside the source message's transaction via `MessageTxScope` (§5).
 *  What is left post-commit — the runtime wake, the WS frames, the skip log —
 *  holds no persistence capability at all, so it needs no port; the delivery
 *  coordinator drives it from the in-transaction report
 *  (`application/mention-cc.ts`). */
