// Conversation/channel-domain persistence composition (#task:1981). The ONLY
// file allowed to wire the concrete conversation/message/follower/inbox repos
// into the channel + conversation-message ports and their UnitOfWork. It
// returns named driver-free ports only — never a concrete repo — so
// application/service code cannot reach raw DB through this surface.
//
// It composes NO effects: `unread_updated` publication and the cross-channel cc
// fan-out are post-commit side effects with their own named adapters
// (`adapters/unread-publish.ts`, `adapters/mention-cc.ts`). Keeping them out of
// here is what makes "a transaction callback structurally cannot publish" true.
import type { Database as Db } from 'better-sqlite3';
import { AgentRepo } from './agent-repo.js';
import { AttachmentRepo } from './attachment-repo.js';
import { ConversationInboxRepo } from './conversation-inbox-repo.js';
import { ConversationRepo } from './conversation-repo.js';
import { MessageRepo } from './message-repo.js';
import { NotificationRepo } from './notification-repo.js';
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
  const attachments = new AttachmentRepo(db);

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
  const channelScopeFor = (channelId: string): ChannelTxScope => ({
    channels: {
      updateTitle: title => conversations.updateTitle(channelId, title),
      // The isolation obligation is discharged by the channel UnitOfWork's
      // BEGIN IMMEDIATE (see below), which takes the write lock BEFORE this read
      // — that, not "SQLite is single-writer", is what makes the value read here
      // stable until commit. A pooled adapter owes a `SELECT … FOR UPDATE`.
      getChannelLikeForUpdate: () => conversations.getChannelLike(channelId),
    },
    messages: {
      insert: args => channelTxMessages.insert({ ...args, conversationId: channelId }),
    },
  });

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
    getAgent: (conversationId, agentId) =>
      conversations.getAgent(conversationId, agentId),
    listAgents: id => conversations.listAgents(id),
    listUserMemberIds: id => conversations.listUserMembers(id).map(u => u.id),
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
    agents: {
      get: id => agents.get(id),
      getByName: name => agents.getByName(name),
    },
    users: { getByName: name => toPrincipalNameSnapshot(users.getByName(name)) },
    inboxes: {
      ensureDelivery: (conversationId, agentId, messageId, deliveryKind) => {
        inboxes.ensureDelivery(conversationId, agentId, messageId, deliveryKind);
      },
    },
    threadFollowers: {
      upsert: args => threadFollowers.upsert(args),
      listFollowerAgentsVisible: rootId =>
        threadFollowers.listFollowerAgentsVisible(rootId),
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

  const messageUow: MessageUnitOfWork = {
    /**
     * Deferred BEGIN — a LOCK-WINDOW POLICY of this SQLite composition, not a
     * claim that the callbacks are race-free. Escalating to IMMEDIATE would put
     * the write lock around the (potentially large) thread-window reads for
     * every send, and it is not what makes the one race that matters safe:
     * the per-stream sequence head is resolved EXPLICITLY by
     * `insertForConversationIfFresh`'s CAS, which fails closed with
     * `MessageFreshnessGuardError` instead of relying on lock ordering.
     *
     * What this composition does NOT promise: the callbacks also gate writes on
     * other reads — conversation archived/closed state, actor membership,
     * attachment ownership, thread membership/follower rows. No method on
     * `MessageTxScope` declares a cross-connection isolation obligation for
     * those, so their stability here is a property of the single-connection
     * SQLite topology (a stale decision surfaces as a failed snapshot upgrade),
     * NOT something derivable from the CAS. A pooled/PG adapter must decide
     * per read whether it needs transaction isolation, a locking read, or a
     * conditional write — see the `MessageUnitOfWork` port doc.
     */
    atomically<T>(fn: (tx: MessageTxScope) => T): T {
      return db.transaction(() => fn(messageScope))();
    },
  };

  const threadFollowRead: ThreadFollowReadPort = {
    getMessageInConversation: (conversationId, messageId) =>
      messages.getInConversation(conversationId, messageId),
    isFollower: (rootId, principalKind, principalId) =>
      threadFollowers.isFollower(rootId, principalKind, principalId),
    listFollowerAgentsVisible: rootId =>
      threadFollowers.listFollowerAgentsVisible(rootId),
  };

  const threadFollowDirectWrite: ThreadFollowDirectWritePort = {
    upsert: args => threadFollowers.upsert(args),
    remove: (rootId, principalKind, principalId) =>
      threadFollowers.remove(rootId, principalKind, principalId),
  };

  const deliveryRead: DeliveryReadPort = {
    getConversation: id => conversations.get(id),
    getMessageById: id => messages.getById(id),
    getAgent: id => agents.get(id),
    getUser: id => toPrincipalNameSnapshot(users.get(id)),
    getWorkspace: id => workspaces.get(id),
    viewerUserIds: id => conversationViewerUserIds(conversations, id),
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
