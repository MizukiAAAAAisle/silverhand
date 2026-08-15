// Conversation/channel-domain persistence composition (#task:1981). The ONLY
// file allowed to wire the concrete conversation/message/follower/inbox repos
// into the channel + conversation-message ports and their UnitOfWork. It
// returns named driver-free ports only — never a concrete repo — so
// application/service code cannot reach raw DB through this surface.
//
// It composes NO effects: `unread_updated` publication is a post-commit side
// effect with its own named adapter (`adapters/unread-publish.ts`). Keeping it
// out of here is what makes "a transaction callback structurally cannot publish"
// true. The mention CC used to be the second such adapter; in v71 its writes are
// part of the send transaction (§5) and reach persistence through
// `MessageTxScope` like every other in-transaction write, so nothing about it is
// composed here separately.
import type { Database as Db } from 'better-sqlite3';
import { AgentRepo } from './agent-repo.js';
import { AttachmentRepo } from './attachment-repo.js';
import { ConversationInboxRepo } from './conversation-inbox-repo.js';
import { ConversationRepo } from './conversation-repo.js';
import { createEndpointPrincipalPresence } from './endpoint-principal-presence.js';
import { MessageRepo } from './message-repo.js';
import { NotificationRepo } from './notification-repo.js';
import { RuntimeSlotRepo, runtimeSlotScopeFor } from './runtime-slot-repo.js';
import { ThreadFollowerRepo } from './thread-follower-repo.js';
import { UserRepo } from './user-repo.js';
import { WorkspaceRepo } from './workspace-repo.js';
import { conversationViewerUserIds } from '../viewer-scope.js';
import type {
  ChannelAgentReadPort,
  ChannelDirectWritePort,
  ChannelReadPort,
  ChannelTxMessagesPort,
  ChannelTxScope,
  ChannelUnitOfWork,
  ChannelWorkspaceReadPort,
  WorkspaceChannelTxScope,
} from '../services/channel/ports.js';
import type {
  DeliveryReadPort,
  DeliveryWritePort,
  MessageTxConversationsPort,
  MessageTxScope,
  MessageUnitOfWork,
  PrincipalNameSnapshot,
  ThreadFollowDirectWritePort,
  ThreadFollowReadPort,
} from '../services/conversation-message/ports.js';

/** Project a user row onto the display identity the message domain is allowed
 *  to see. Explicit — NOT a structural pass-through: `UserRow` satisfies
 *  `PrincipalNameSnapshot` at compile time, so returning it bare would still
 *  hand the application `email` / `avatar_storage_key` / `last_seen_at` at
 *  runtime (R4). Shared by the tx scope's `users.getByName` and the
 *  post-commit delivery read so the two faces cannot drift apart. */
function toPrincipalNameSnapshot(
  row: { id: string; name: string; display_name: string } | null,
): PrincipalNameSnapshot | null {
  return row === null
    ? null
    : { id: row.id, name: row.name, display_name: row.display_name };
}

export interface SqliteConversationPersistence {
  channel: {
    read: ChannelReadPort;
    directWrite: ChannelDirectWritePort;
    workspaces: ChannelWorkspaceReadPort;
    agents: ChannelAgentReadPort;
    uow: ChannelUnitOfWork;
  };
  message: {
    uow: MessageUnitOfWork;
  };
  threadFollow: {
    read: ThreadFollowReadPort;
    directWrite: ThreadFollowDirectWritePort;
  };
  delivery: {
    read: DeliveryReadPort;
    write: DeliveryWritePort;
  };
}

/**
 * One-stop composition for both conversation-side domains.
 *
 * Single-connection SQLite: one scope object serves every transaction, because
 * every repo here shares `db` — which is exactly the invariant a pooled engine
 * would break, so a future pooled adapter must build per-transaction ports
 * bound to the transaction's client instead of hoisting them like this.
 */
export function createSqliteConversationPersistence(
  db: Db,
): SqliteConversationPersistence {
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const agents = new AgentRepo(db);
  const users = new UserRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const notifications = new NotificationRepo(db);
  const inboxes = new ConversationInboxRepo(db);
  const threadFollowers = new ThreadFollowerRepo(db);
  // The RUNTIME SEAT face (P0-d): the auto-start pre-filter's status source.
  // Composed here rather than reached through membership on purpose — a DM
  // participant has a seat and no roster row.
  const runtimeSlots = new RuntimeSlotRepo(db);
  const attachments = new AttachmentRepo(db);
  // The endpoint-liveness dispatch the write gate's `direct_pair` narrowing needs
  // — the SAME composition the request-layer ACL uses
  // (`authorization-reads.ts`), so both faces of one rule answer identically.
  const endpointPresence = createEndpointPrincipalPresence({ agents, users });

  // --- channel domain -----------------------------------------------------

  const channelRead: ChannelReadPort = {
    get: id => conversations.get(id),
    getChannelLike: id => conversations.getChannelLike(id),
    getAgent: (conversationId, agentId) =>
      conversations.getAgent(conversationId, agentId),
    listAgents: id => conversations.listAgents(id),
  };

  const channelDirectWrite: ChannelDirectWritePort = {
    setArchived: (id, archived) => conversations.setArchived(id, archived),
    setVisibility: (id, visibility) => conversations.setVisibility(id, visibility),
  };

  const channelWorkspaces: ChannelWorkspaceReadPort = {
    get: id => workspaces.get(id),
    isMember: (workspaceId, agentId) => workspaces.isMember(workspaceId, agentId),
    isUserMember: (workspaceId, userId) => workspaces.isUserMember(workspaceId, userId),
  };

  const channelTxMessages: ChannelTxMessagesPort = {
    // SQLite nests MessageRepo's internal transaction as a savepoint
    // (pre-existing seed/rename behavior); a pooled adapter must insert on the
    // tx client WITHOUT opening a new transaction.
    insert: args =>
      messages.insertForConversation({
        conversationId: args.conversationId,
        fromKind: args.fromKind,
        fromAgentId: args.fromAgentId,
        content: args.content,
        metadata: args.metadata,
      }),
  };

  /** The conversation-keyed scope. Built PER TRANSACTION because it closes over
   *  the key: every face addresses THAT channel, so no caller can point one at
   *  another conversation and no runtime binding check is needed to stop it. */
  const channelScopeFor = (channelId: string): ChannelTxScope => {
    /**
     * The WORKSPACE the keyed conversation is addressed in — derived from the
     * key, never passed in, so a rename cannot be checked against another
     * workspace's addresses.
     *
     * Throws for a conversation that has no workspace placement (an agent
     * inbox). That is a BACKSTOP, not the error path: the service refuses such a
     * target with a typed `not_addressable` before opening the transaction.
     * `getChannelLike` intentionally spans every top-level placement, so an
     * inbox can reach this identity read before failing the address-space
     * requirement. Reading it pre-lock is sound only because `conversations
     * .workspace_id` is immutable, the same assumption the UnitOfWork's own
     * key→workspace resolution rests on (see the port doc's step 1).
     */
    const addressSpaceOf = (): string => {
      const identity = conversations.getIdentity(channelId);
      if (identity === null || identity.workspace_id === null) {
        throw new Error(
          `channel UnitOfWork: conversation ${channelId} has no workspace to hold a `
            + 'title address',
        );
      }
      return identity.workspace_id;
    };
    return {
      channels: {
        updateTitle: title => conversations.updateTitle(channelId, title),
        // The isolation obligation is discharged by the channel UnitOfWork's
        // BEGIN IMMEDIATE (see below), which takes the write lock BEFORE this read
        // — that, not "SQLite is single-writer", is what makes the value read here
        // stable until commit. A pooled adapter owes a `SELECT … FOR UPDATE`.
        getChannelLikeForUpdate: () => conversations.getChannelLike(channelId),
        isTitleTakenByAnother: key =>
          conversations.isTitleKeyTaken(addressSpaceOf(), key, channelId),
      },
      messages: {
        insert: args => channelTxMessages.insert({ ...args, conversationId: channelId }),
      },
    };
  };

  /**
   * The workspace binding for every workspace-keyed face that takes a
   * `conversationId` (see the port contract). The coordination axis is the
   * workspace, so touching a conversation of another one would write outside the
   * mechanism this transaction holds — "lock A, write B". Throwing aborts the
   * enclosing `BEGIN IMMEDIATE`, so a caller cannot get half of its writes.
   *
   * A conversation that does not EXIST is passed through rather than refused: the
   * face's own semantics then answer correctly (a read returns null, an insert
   * hits the foreign key). Only a real pointer into another workspace is a
   * coordination violation. Same rule, same wording as
   * `membership-persistence.ts` — one idea, stated once per composition.
   */
  const bindToWorkspace = (workspaceId: string, conversationId: string): string => {
    const conversation = conversations.get(conversationId);
    if (conversation && conversation.workspace_id !== workspaceId) {
      throw new Error(
        `channel UnitOfWork: conversation ${conversationId} belongs to workspace `
          + `${conversation.workspace_id}, not the coordinated ${workspaceId}`,
      );
    }
    return conversationId;
  };

  /** The workspace-keyed scope. Built PER TRANSACTION because it closes over the
   *  key: that is what makes an uncoordinated creation or member placement
   *  unexpressible rather than merely incorrect. */
  const workspaceChannelScopeFor = (workspaceId: string): WorkspaceChannelTxScope => {
    const inWorkspace = (conversationId: string): string =>
      bindToWorkspace(workspaceId, conversationId);
    return {
      channels: {
        // `workspaceId` comes from the KEY, never from the caller.
        insertChannel: args => conversations.insertChannel({ workspaceId, ...args }),
        insertDmChannel: args => conversations.insertDmChannel({ workspaceId, ...args }),
        // The coordinated workspace's address space, from the same key — so the
        // conflict this answers is the one the insert would actually hit.
        isTitleTaken: key => conversations.isTitleKeyTaken(workspaceId, key),
        addAgent: (id, agentId) => conversations.addAgent(inWorkspace(id), agentId),
        addUser: (id, userId) => conversations.addUser(inWorkspace(id), userId),
        get: id => conversations.get(inWorkspace(id)),
        getAgent: (id, agentId) => conversations.getAgent(inWorkspace(id), agentId),
        listUsers: id => conversations.listUsers(inWorkspace(id)),
      },
      // The seed messages are bound too: a channel-creation transaction may not
      // insert into a conversation of another workspace either.
      messages: {
        insert: args =>
          channelTxMessages.insert({ ...args, conversationId: inWorkspace(args.conversationId) }),
      },
      agents: { get: id => agents.get(id) },
      // Keyed, so it can only answer about the coordinated workspace: these are
      // the facts the callback re-derives before it writes a member row. `get`
      // PROJECTS — it must not hand back the row, or the callback could decide on
      // a field this port never promised to have read under the lock (R4).
      workspace: {
        get: () => {
          const row = workspaces.get(workspaceId);
          return row === null
            ? null
            : {
                workspace_kind: row.workspace_kind,
                owner_agent_id: row.owner_agent_id,
              };
        },
        hasAgentMember: agentId => workspaces.isMember(workspaceId, agentId),
        // The authoritative `workspace_users.role`, which is the same row
        // `isUserMember` counts — so this ONE face answers both "is a member"
        // (non-null) and "may govern" (rank).
        humanRole: userId => workspaces.getUserRole(workspaceId, userId),
      },
    };
  };

  /** Root-only, for BOTH axes: nested, `.immediate()` silently degrades to a
   *  savepoint and takes no write lock at all (same reasoning as `auth-uow.ts`),
   *  so `getChannelLikeForUpdate`'s isolation obligation would rest on nothing. */
  const assertChannelTxRoot = (): void => {
    if (db.inTransaction) {
      throw new Error(
        'channel UnitOfWork: immediate transactions are root-only; already inside a transaction',
      );
    }
  };

  const channelUow: ChannelUnitOfWork = {
    /**
     * BEGIN IMMEDIATE, not the default deferred BEGIN. Every path through this
     * UnitOfWork writes, and `getChannelLikeForUpdate` states an isolation
     * obligation its callback DEPENDS on: rename's from-title audit is taken
     * from that read. Under a deferred BEGIN the first statement is a read, so
     * the write lock is not held yet and the obligation would rest on nothing
     * but "there is usually one writer". Taking the lock up front costs one
     * extra acquisition on a no-op rename and makes the contract real.
     *
     * The key is what the scope's faces address. This engine's write lock is
     * file-wide, so it already covers the key AND excludes the other axis; a
     * pooled adapter must lock the key's workspace (see the port doc) so the two
     * axes keep sharing one mechanism.
     */
    atomicallyForChannel<T>(channelId: string, fn: (tx: ChannelTxScope) => T): T {
      assertChannelTxRoot();
      return db.transaction(() => fn(channelScopeFor(channelId))).immediate();
    },
    /**
     * The workspace-keyed axis: the SAME mechanism as `atomicallyForChannel`
     * above — this engine's write lock is file-wide, so the two axes already
     * exclude each other — with a scope bound to the coordinated workspace.
     */
    atomicallyInWorkspace<T>(
      workspaceId: string,
      fn: (tx: WorkspaceChannelTxScope) => T,
    ): T {
      assertChannelTxRoot();
      return db.transaction(() => fn(workspaceChannelScopeFor(workspaceId))).immediate();
    },
  };

  // --- conversation-message domain ----------------------------------------

  const messageConversations: MessageTxConversationsPort = {
    get: id => conversations.get(id),
    // The PLACEMENT authority's boolean face (§4.2). Not `getAgent`: a DM and an
    // inbox have no roster row, so the roster predicate this replaced made every
    // agent send into a DM fail (#task:2021 P4-4).
    isAgentParticipant: (conversationId, agentId) =>
      conversations.isAgentParticipant(conversationId, agentId),
    // The SAME authority for the other principal kind. Its human arms
    // are the v25 pair (seat AND workspace membership), the `human` endpoint, and
    // no inbox arm at all — all three inside one SQL predicate, so this face
    // cannot restate half of the rule.
    isUserParticipant: (conversationId, userId) =>
      conversations.isUserParticipant(conversationId, userId),
    // The roster-seat question is GONE from this scope (#task:2021 P4-5): the
    // only consumer left was thread-follower eligibility, which now asks
    // participation like every other gate on the send path.
    // Projection point: the write gate's `direct_pair` narrowing reads the
    // placement arc's columns and nothing else. Listed field by field rather
    // than returned bare — `ConversationIdentity` is a structural supertype of
    // `ConversationEndpointRef`, so a pass-through would type-check while handing
    // the application the whole identity row at runtime (R4).
    endpointFacts: id => {
      const row = conversations.getIdentity(id);
      if (!row) return null;
      return {
        placement_kind: row.placement_kind,
        endpoint_a_kind: row.endpoint_a_kind,
        endpoint_a_id: row.endpoint_a_id,
        endpoint_b_kind: row.endpoint_b_kind,
        endpoint_b_id: row.endpoint_b_id,
        endpoint_a_deleted_at: row.endpoint_a_deleted_at,
        endpoint_b_deleted_at: row.endpoint_b_deleted_at,
      };
    },
    endpointPrincipalExists: endpointPresence,
    // Recipient / follower-gate enumeration: the placement authority read in its
    // correlated form, conjoined with a live principal row. NOT `listAgents` /
    // `listUserMembers` — those answer the workspace arm only, so a rosterless
    // placement enumerated to nobody (#task:2021 P4-5).
    listParticipantAgentIds: id => conversations.listParticipantAgentIds(id),
    // Projection point: the inbox arc's only fact the CC write may see is the
    // id (its `workspace_id` is NULL by construction and its roster is empty).
    agentInbox: agentId => {
      const inbox = conversations.getAgentInbox(agentId);
      return inbox ? { id: inbox.id } : null;
    },
  };

  const messageScope: MessageTxScope = {
    // Delegated method-by-method on purpose: the transaction closure is then
    // literally the list below, auditable without reading MessageRepo (R3).
    messages: {
      insertForConversation: args => messages.insertForConversation(args),
      insertForConversationIfFresh: args => messages.insertForConversationIfFresh(args),
      streamHeadLatestSeq: (conversationId, threadRootId) =>
        messages.streamHeadLatestSeq(conversationId, threadRootId),
      getInConversation: (conversationId, messageId) =>
        messages.getInConversation(conversationId, messageId),
      replyCountsByRoot: (conversationId, rootMessageIds) =>
        messages.replyCountsByRoot(conversationId, rootMessageIds),
      threadListEntryForRoot: (conversationId, rootId) =>
        messages.threadListEntryForRoot(conversationId, rootId),
      listStreamWindowMeta: (conversationId, threadRootId, afterSeq, throughSeq) =>
        messages.listStreamWindowMeta(
          conversationId,
          threadRootId,
          afterSeq,
          throughSeq,
        ),
      listStreamBelowSeq: (conversationId, threadRootId, beforeSeq) =>
        messages.listStreamBelowSeq(conversationId, threadRootId, beforeSeq),
    },
    conversations: messageConversations,
    // Name only — see `MessageTxWorkspacesPort`. Explicit projection, not a
    // structural pass-through of the row (R4).
    workspaces: {
      nameOf: workspaceId => workspaces.get(workspaceId)?.name ?? null,
    },
    notifications: {
      insertMentionExternal: args => {
        notifications.insert({
          kind: 'mention_external',
          userId: args.userId,
          agentId: args.agentId,
          // The notification's own coordinates ARE the source's (option A): the
          // viewer is the author, and the author's read path is the source
          // message they can see — never the recipient's inbox copy.
          workspaceId: args.sourceWorkspaceId,
          conversationId: args.sourceConversationId,
          messageId: args.sourceMessageId,
          sourceWorkspaceId: args.sourceWorkspaceId,
          sourceConversationId: args.sourceConversationId,
          sourceMessageId: args.sourceMessageId,
          payload: args.payload,
        });
      },
    },
    agents: {
      get: id => agents.get(id),
      getByName: name => agents.getByName(name),
    },
    users: {
      get: id => toPrincipalNameSnapshot(users.get(id)),
      getByName: name => toPrincipalNameSnapshot(users.getByName(name)),
    },
    inboxes: {
      ensureDelivery: (conversationId, agentId, messageId, deliveryKind) => {
        inboxes.ensureDelivery(conversationId, agentId, messageId, deliveryKind);
      },
    },
    threadFollowers: {
      upsert: args => threadFollowers.upsert(args),
      listFollowerAgentIdsParticipating: rootId =>
        threadFollowers.listFollowerAgentIdsParticipating(rootId),
    },
    // Projection point: the physical attachment row never leaves persistence —
    // the pure resolver takes the minimal channel/label facts only.
    attachments: {
      listSnapshotSourcesByIds: ids =>
        attachments.listByIds(ids).map(row => ({
          id: row.id,
          channel_id: row.channel_id,
          filename: row.filename,
          size: row.size,
          content_type: row.content_type,
        })),
    },
  };

  /** Root-only, same reason as {@link assertChannelTxRoot}: nested,
   *  `.immediate()` degrades to a savepoint SILENTLY and takes no write lock, so
   *  the write gate's commit-time authority would rest on nothing while every
   *  test still passed. */
  const assertMessageTxRoot = (): void => {
    if (db.inTransaction) {
      throw new Error(
        'message UnitOfWork: immediate transactions are root-only; already inside a transaction',
      );
    }
  };

  const messageUow: MessageUnitOfWork = {
    /**
     * BEGIN IMMEDIATE, not the default deferred BEGIN (#task:2021 P4-4). The
     * send's write gate — lifecycle ∧ participation ∧
     * not-survivor-read-only — READS facts owned by other aggregates and then
     * writes on their strength. Under a deferred BEGIN those reads run with no
     * lock held, so a rival connection could revoke the seat / archive the
     * conversation / delete the peer AFTER the gate said yes and the insert would
     * still land: exactly the stale-authorization defect the gate exists to
     * remove, one layer down. Source position is not a concurrency mechanism, so
     * this composition names one — the file-wide write lock, taken at BEGIN and
     * held to COMMIT.
     *
     * Cost, stated honestly: the lock window now spans the callback's reads,
     * including the thread-window ones. It is a longer window on the SAME lock
     * every send already had to take to insert its row — this engine has one
     * writer either way — so it changes lock DURATION, not the set of sends that
     * contend. What it buys is that "the gate answers at commit time" is provable
     * (`conversation-persistence.test.ts` points a second connection at it)
     * rather than a comment.
     *
     * The freshness CAS stays exactly as it was and is still the ONLY mechanism
     * for the per-stream head: `insertForConversationIfFresh` runs its own nested
     * savepoint so a CAS miss rolls back the burned seq without aborting this
     * transaction.
     */
    atomically<T>(fn: (tx: MessageTxScope) => T): T {
      assertMessageTxRoot();
      return db.transaction(() => fn(messageScope)).immediate();
    },
  };

  const threadFollowRead: ThreadFollowReadPort = {
    getMessageInConversation: (conversationId, messageId) =>
      messages.getInConversation(conversationId, messageId),
    isFollower: (rootId, principalKind, principalId) =>
      threadFollowers.isFollower(rootId, principalKind, principalId),
    listFollowerAgentIdsParticipating: rootId =>
      threadFollowers.listFollowerAgentIdsParticipating(rootId),
  };

  const threadFollowDirectWrite: ThreadFollowDirectWritePort = {
    remove: (rootId, principalKind, principalId) =>
      threadFollowers.remove(rootId, principalKind, principalId),
  };

  const deliveryRead: DeliveryReadPort = {
    getConversation: id => conversations.get(id),
    getMessageById: id => messages.getById(id),
    getAgent: id => agents.get(id),
    getUser: id => toPrincipalNameSnapshot(users.get(id)),
    viewerUserIds: id => conversationViewerUserIds(conversations, id),
    // The SEAT's status, resolved through the seat's own scope rule — the
    // auto-start pre-filter's only honest source once recipients are principal
    // ids (#task:2021 P4-5). A missing agent row answers `null` (startable) and
    // the wake then fails best-effort on its own, which is the same outcome as
    // any other race with a deletion.
    runtimeSeatStatus: (conversationId, agentId) => {
      const agent = agents.get(agentId);
      if (!agent) return null;
      const slot = runtimeSlots.get(runtimeSlotScopeFor(agent, conversationId));
      return slot?.observed_status ?? null;
    },
  };

  const deliveryWrite: DeliveryWritePort = {
    insertNotification: args => notifications.insert(args),
    ensureDelivery: (conversationId, agentId, messageId, deliveryKind) => {
      inboxes.ensureDelivery(conversationId, agentId, messageId, deliveryKind);
    },
  };

  return {
    channel: {
      read: channelRead,
      directWrite: channelDirectWrite,
      workspaces: channelWorkspaces,
      agents: { get: id => agents.get(id) },
      uow: channelUow,
    },
    message: { uow: messageUow },
    threadFollow: { read: threadFollowRead, directWrite: threadFollowDirectWrite },
    delivery: { read: deliveryRead, write: deliveryWrite },
  };
}
