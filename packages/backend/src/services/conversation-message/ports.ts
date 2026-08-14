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
  ConversationAgentDto,
  ConversationAgentStatus,
  ConversationDto,
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
   *  inbox" a schema fact. */
  ccSourceMessageId?: string | null;
}

/** Compare-and-set insert arguments: `seenUpToSeq` is the actor's last
 *  observed seq IN THE SAME STREAM. No `freshnessExempt` — an exempt row is
 *  outside the freshness universe, so it can never be CAS-guarded. */
export interface MessageInsertIfFreshArgs
  extends Omit<MessageInsertArgs, 'freshnessExempt'> {
  seenUpToSeq: number;
}

export type MessageInsertIfFreshResult =
  | { ok: true; message: MessageDto }
  | { ok: false; currentSeq: number };

/** Message reads + writes available INSIDE a transaction. */
export interface MessageTxMessagesPort {
  insertForConversation(args: MessageInsertArgs): MessageDto;
  /**
   * Freshness CAS insert. Contract the adapter MUST honour: the global seq
   * allocation and the per-stream CAS share ONE nested rollback boundary
   * (SQLite savepoint / PG SAVEPOINT), so a CAS miss rolls back the burned
   * seq WITHOUT aborting the caller's outer transaction. Flattening this into
   * the outer transaction is a contract violation, not an optimisation
   * (docs/thread-reply-cluster-v1.md §6.4).
   */
  insertForConversationIfFresh(
    args: MessageInsertIfFreshArgs,
  ): MessageInsertIfFreshResult;
  /** Freshness head of one stream (`threadRootId` null = main line); 0 when
   *  the stream has no head row yet. */
  streamHeadLatestSeq(conversationId: string, threadRootId: string | null): number;
  getInConversation(conversationId: string, messageId: string): MessageDto | null;
  replyCountsByRoot(
    conversationId: string,
    rootMessageIds: readonly string[],
  ): Record<string, number>;
  threadListEntryForRoot(
    conversationId: string,
    rootId: string,
  ): ThreadSummaryInvariant | null;
  listStreamWindowMeta(
    conversationId: string,
    threadRootId: string | null,
    afterSeq: number,
    throughSeq: number,
  ): Array<{
    id: string;
    seq: number;
    from_kind: string;
    from_agent_id: string | null;
  }>;
  listStreamBelowSeq(
    conversationId: string,
    threadRootId: string,
    beforeSeq: number,
  ): MessageDto[];
}

export interface MessageTxConversationsPort {
  get(conversationId: string): ConversationDto | null;
  getAgent(conversationId: string, agentId: string): ConversationAgentDto | null;
  listAgents(conversationId: string): ConversationAgentDto[];
  /** Ids of the human members of a conversation — the mention-follow
   *  membership filter. Ids only: the callers never read another column. */
  listUserMemberIds(conversationId: string): string[];
  /**
   * The mentioned agent's INBOX placement (v71, §4.2) — the destination of the
   * mention CC copy, which is written in the source message's own transaction.
   *
   * Id only. The inbox has no workspace and no roster rows, so a wider shape
   * would hand the CC use case coordinates that do not exist on this arc. `null`
   * means the Agent aggregate is missing its inbox invariant — the use case
   * fails loud rather than creating one lazily (the retired title-keyed
   * get-or-create is exactly what made two inboxes possible).
   */
  agentInbox(agentId: string): { id: string } | null;
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
 *   - the VIEWER is the source message's author. The mention is theirs; the
 *     inbox copy belongs to the agent, and an inbox has no human participant
 *     (§4.2), so nobody else could receive this notification.
 *   - the JUMP TARGET is the SOURCE message — `(conversationId, messageId)` name
 *     the source, never the inbox copy. The author is a member there and can
 *     read it; pointing at the inbox would send them to a conversation whose
 *     ACL denies them by domain rule.
 *
 * Hence no `workspaceId` argument either: the source conversation's workspace is
 * the only workspace involved, and the inbox has none.
 */
export interface MentionExternalNotificationArgs {
  /** The author of the source message — the viewer of this notification. */
  userId: string;
  /** The agent that was mentioned (the inbox owner), for list rendering. */
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

/** Follower writes/reads available inside a transaction. `listFollowerAgentsVisible`
 *  is here because the send path's follower-gated delivery plan is computed at
 *  the END of the same transaction that inserts the follower rows — reading it
 *  through a captured factory repo would compute the plan against a different
 *  connection's snapshot. `remove` / `isFollower` are deliberately absent:
 *  no transaction callback calls them (R3). */
export interface MessageTxThreadFollowersPort {
  upsert(args: ThreadFollowerUpsertArgs): { inserted: boolean };
  listFollowerAgentsVisible(threadRootId: string): ConversationAgentDto[];
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
  users: { getByName(name: string): PrincipalNameSnapshot | null };
  inboxes: {
    ensureDelivery(
      conversationId: string,
      agentId: string,
      messageId: string,
      deliveryKind?: 'turn' | 'observe',
    ): void;
  };
  threadFollowers: MessageTxThreadFollowersPort;
  attachments: AttachmentSnapshotSourcePort;
}

/** Atomic write boundary for the message domain. Guarantees ATOMICITY only.
 *
 *  Isolation is deliberately NOT promised here, and only one read-then-write
 *  race is closed by a stated mechanism: the per-stream sequence head, via
 *  `insertForConversationIfFresh`'s CAS. The send/materialize callbacks also
 *  gate writes on other reads — conversation archived/closed state, actor
 *  membership, attachment ownership, thread membership/follower rows — and NO
 *  method on `MessageTxScope` declares a cross-connection isolation obligation
 *  for them (contrast `ChannelTxChannelsPort.getChannelLikeForUpdate`, which
 *  does). An adapter whose engine can serve a stale snapshot to a write must
 *  therefore choose, PER SUCH READ, between transaction isolation, a locking
 *  read, or a conditional write; it may not infer that the CAS covers them. */
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
  listFollowerAgentsVisible(threadRootId: string): ConversationAgentDto[];
}

/** Self-atomic single-statement follower writes (idempotent by construction),
 *  so they need no UnitOfWork. */
export interface ThreadFollowDirectWritePort {
  upsert(args: ThreadFollowerUpsertArgs): { inserted: boolean };
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
  /** Runtime projection for the semantic seat that serves this target. This is
   *  deliberately separate from `ConversationAgentDto`: membership never
   *  changes shape or disappears because a slot is absent. */
  runtimeStatus(
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
