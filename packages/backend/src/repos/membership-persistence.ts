// Workspace-membership persistence composition (#task:1982 W5, widened by
// #task:1987). The ONLY file that wires the concrete conversation / message /
// workspace / capability / attention / read-cursor repos into the membership
// ports, so no use case holds a `Database` handle, a repo or SQL.
//
// It composes NO effects: the runtime stop and every publish stay in the use
// cases, outside the transaction, which is what keeps "a membership transaction
// structurally cannot stop a process or emit an event" true.
import type { Database as Db } from 'better-sqlite3';
import type {
  AgentMemberRef,
  AgentMembershipTxPort,
  HumanMemberRef,
  HumanMembershipTxPort,
  MembershipActorRef,
  MembershipAuthorityTxPort,
  MembershipChannelExitFacts,
  MembershipConversationRef,
  MembershipCoordinationKey,
  MembershipPersistence,
  MembershipTxScope,
  MembershipTxScopeFor,
  WorkspaceMemberRef,
  WorkspaceMembershipAnchor,
  WorkspaceMembershipReadPort,
  WorkspaceMembershipTxPortBase,
  WorkspaceRosterTxPort,
  WorkspaceRosterTxScope,
} from '../application/membership-ports.js';
import { AgentCapabilityRepo } from './agent-capability-repo.js';
import { ChannelAttentionPreferenceRepo } from './channel-attention-preference-repo.js';
import { ConversationReadRepo } from './conversation-read-repo.js';
import { ConversationRepo } from './conversation-repo.js';
import { MessageRepo } from './message-repo.js';
import { WorkspaceRepo } from './workspace-repo.js';

/**
 * Single-connection SQLite: the repos are built once because every one of them
 * shares `db`, and the transaction runs on that same connection. The SCOPE is
 * still built per transaction — it closes over the coordination key, which is
 * what makes an uncoordinated membership write unexpressible. A pooled engine
 * breaks the shared-handle invariant: such an adapter must bind the repos to the
 * transaction's client inside `atomically` instead of hoisting them like this.
 */
export function createSqliteMembershipPersistence(db: Db): MembershipPersistence {
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const capabilities = new AgentCapabilityRepo(db);
  const attentionPrefs = new ChannelAttentionPreferenceRepo(db);
  const reads = new ConversationReadRepo(db);

  /**
   * The R4 projection boundary: a NEW object with the two fields the cascade may
   * see. The query already selects exactly those two columns, so this map looks
   * redundant — it is not: the repo's projection is the REPO's shape, and a column
   * added there for some other caller must not silently become an input the
   * membership decision can branch on.
   *
   * ONE scoped query per call (#task:1987), keyed by exactly the coordination pair
   * `(workspaceId, member)`. The pre-#1987 shape read the WHOLE `conversations`
   * table and then probed membership once per row, twice per removal — cost
   * tracking every conversation that has ever existed, to answer a question about
   * one member's handful of edges.
   */
  const conversationsWithMember = (
    workspaceId: string,
    member: WorkspaceMemberRef,
  ): MembershipConversationRef[] =>
    (member.kind === 'agent'
      ? conversations.listMemberConversationRefsForAgent(workspaceId, member.id)
      : conversations.listMemberConversationRefsForUser(workspaceId, member.id)
    ).map(conversation => ({
      id: conversation.id,
      workspace_id: conversation.workspace_id,
    }));

  const read: WorkspaceMembershipReadPort = {
    listConversationsWithMember: conversationsWithMember,
  };

  /**
   * The anchor read. There is no `SELECT ... FOR UPDATE` to write here and none
   * is needed: `atomically` below is BEGIN IMMEDIATE and root-only, so this read
   * already runs under the database's write lock — taken at BEGIN, against the
   * whole file, whether or not the membership row exists. That is the WHOLE
   * isolation mechanism, and it is why a missing row is safe here; a pooled
   * adapter must supply an existence-independent equivalent (see the port
   * contract) and must NOT copy this plain read.
   */
  const readAnchor = (
    workspaceId: string,
    member: WorkspaceMemberRef,
  ): WorkspaceMembershipAnchor | null => {
    if (member.kind === 'agent') {
      return workspaces.isMember(workspaceId, member.id) ? { role: null } : null;
    }
    const role = workspaces.getUserRole(workspaceId, member.id);
    return role ? { role } : null;
  };

  /**
   * The workspace binding for every face that takes a `conversationId` (see the
   * port contract). The coordination axis is the workspace, so acting on a
   * conversation of another one would write outside the mechanism this transaction
   * holds — "lock A, write B". Throwing is the whole point: it aborts the enclosing
   * `BEGIN IMMEDIATE`, so a caller cannot get half of its intended writes.
   *
   * A conversation that does not EXIST is passed through rather than refused: it may
   * have been deleted concurrently, and each face's own semantics then answer
   * correctly (a delete removes nothing, an insert hits the foreign key). Only a
   * real pointer into another workspace is a coordination violation.
   */
  const bindToWorkspace = (workspaceId: string, conversationId: string): string => {
    const conversation = conversations.get(conversationId);
    if (conversation && conversation.workspace_id !== workspaceId) {
      throw new Error(
        `membership UnitOfWork: conversation ${conversationId} belongs to workspace `
          + `${conversation.workspace_id}, not the coordinated ${workspaceId}`,
      );
    }
    return conversationId;
  };

  /** The faces shared by both member kinds. `key` is closed over, so no face can
   *  be pointed at a member the enclosing `atomically` did not coordinate on. */
  const basePortFor = (key: MembershipCoordinationKey): WorkspaceMembershipTxPortBase => {
    const { workspaceId, member } = key;
    const inWorkspace = (conversationId: string): string =>
      bindToWorkspace(workspaceId, conversationId);
    return {
      listConversationsWithMemberForUpdate: () => conversationsWithMember(workspaceId, member),
      addConversationMember(id) {
        // `created` is decided HERE, inside the coordinated transaction, so the
        // read and the insert are one atomic step. `INSERT OR IGNORE`'s row count
        // would answer it too, but the repos return the DTO rather than the
        // statement result; either way the answer must come from under the lock,
        // never from the caller (see the port contract).
        const conversationId = inWorkspace(id);
        if (member.kind === 'agent') {
          const created = conversations.getAgent(conversationId, member.id) === null;
          conversations.addAgent(conversationId, member.id);
          return { created };
        }
        const created = conversations.getUser(conversationId, member.id) === null;
        conversations.addUser(conversationId, member.id);
        return { created };
      },
      removeConversationMember(id) {
        // Symmetric to `created`: the answer is read and acted on under the lock,
        // so a second concurrent removal reports `false` and emits nothing.
        const conversationId = inWorkspace(id);
        if (member.kind === 'agent') {
          const removed = conversations.getAgent(conversationId, member.id) !== null;
          conversations.removeAgent(conversationId, member.id);
          return { removed };
        }
        const removed = conversations.getUser(conversationId, member.id) !== null;
        conversations.removeUser(conversationId, member.id);
        return { removed };
      },
      insertMembershipAuditMessage(input) {
        return messages.insertForConversation({
          conversationId: inWorkspace(input.conversationId),
          fromKind: 'system',
          content: input.content,
          metadata: input.metadata,
        });
      },
      removeWorkspaceMembership() {
        if (member.kind === 'agent') workspaces.removeMember(workspaceId, member.id);
        else workspaces.removeUserMember(workspaceId, member.id);
      },
    };
  };

  /**
   * The actor-authority projection, scoped to the coordinated workspace. Two point
   * reads, no policy: which of them a rule consults, and what it concludes, stays in
   * the domain.
   */
  const authorityPortFor = (workspaceId: string): MembershipAuthorityTxPort => ({
    humanWorkspaceRole: userId => workspaces.getUserRole(workspaceId, userId),
    isConversationMember: (conversationId, actor: MembershipActorRef) => {
      const bound = bindToWorkspace(workspaceId, conversationId);
      return actor.kind === 'agent'
        ? conversations.getAgent(bound, actor.id) !== null
        : conversations.getUser(bound, actor.id) !== null;
    },
  });

  const agentPortFor = (
    key: MembershipCoordinationKey<AgentMemberRef>,
  ): AgentMembershipTxPort => ({
    ...basePortFor(key),
    memberKind: 'agent',
    insertWorkspaceMembership: () => workspaces.insertMembership(key.workspaceId, key.member.id),
    // No `if (created)` here: whether a default capability set may be (re-)seeded
    // is the use case's policy, and this adapter must not own it.
    seedCapabilityDefaults: () => capabilities.seedDefaults(key.workspaceId, key.member.id),
  });

  const humanPortFor = (
    key: MembershipCoordinationKey<HumanMemberRef>,
  ): HumanMembershipTxPort => {
    const inWorkspace = (conversationId: string): string =>
      bindToWorkspace(key.workspaceId, conversationId);
    return {
      ...basePortFor(key),
      memberKind: 'human',
      addWorkspaceMembership: () => workspaces.addUserMember(key.workspaceId, key.member.id),
      insertAttentionPreferenceIfAbsent(input) {
        attentionPrefs.insertIfAbsent({
          viewerUserId: key.member.id,
          conversationId: inWorkspace(input.conversationId),
          mode: input.mode,
        });
      },
      listStreamHeads: conversationId => messages.listStreamHeads(inWorkspace(conversationId)),
      markStreamRead(input) {
        reads.markRead({
          viewerUserId: key.member.id,
          conversationId: inWorkspace(input.conversationId),
          threadRootId: input.threadRootId,
          seq: input.seq,
        });
      },
      /**
       * The second R4 projection boundary (the first is `conversationsWithMember`
       * above): a NEW object with the three channel fields the exit rule branches
       * on, written field by field. Spreading the conversation DTO would put titles
       * and ordering inside the domain, where nothing may branch on them.
       */
      readChannelExitFacts(conversationId): MembershipChannelExitFacts {
        const bound = inWorkspace(conversationId);
        const conversation = conversations.get(bound);
        return {
          channel: conversation
            ? {
                kind: conversation.kind,
                visibility: conversation.visibility,
                archived_at: conversation.archived_at,
              }
            : null,
          isMember: conversations.getUser(bound, key.member.id) !== null,
          humanMemberCount: conversations.listUsers(bound).length,
        };
      },
    };
  };

  /**
   * The ROSTER scope's faces: the same writes as the per-principal ones, with the
   * member as an argument instead of a closed-over key, because this transaction
   * coordinates on the workspace alone. `bindToWorkspace` is REUSED, not
   * reimplemented — the workspace-binding obligation is identical, and a second
   * copy of that check would be a second thing to get wrong.
   */
  const rosterPortFor = (workspaceId: string): WorkspaceRosterTxPort => ({
    addConversationMember(id, member) {
      const conversationId = bindToWorkspace(workspaceId, id);
      // `created` is read and acted on under the lock, exactly as in the
      // per-principal scope; the caller may not supply it.
      if (member.kind === 'agent') {
        const created = conversations.getAgent(conversationId, member.id) === null;
        conversations.addAgent(conversationId, member.id);
        return { created };
      }
      const created = conversations.getUser(conversationId, member.id) === null;
      conversations.addUser(conversationId, member.id);
      return { created };
    },
    addWorkspaceHumanMembership(userId) {
      workspaces.addUserMember(workspaceId, userId);
    },
  });

  /**
   * BEGIN IMMEDIATE, not the default deferred BEGIN: the anchor read happens
   * before the callback's first statement, and the whole decision — which rows to
   * write or delete, which audit messages to insert — is derived from it and from
   * the in-scope recompute. Under a deferred BEGIN the write lock would only be
   * taken at the first write, so a concurrent writer committing in between would
   * leave a conversation membership behind with no audit trail.
   *
   * The three obligations of the port contract are discharged HERE, in order, so
   * no caller participates in them: lock (BEGIN IMMEDIATE) → anchor read →
   * key-bound, kind-specific scope.
   *
   * The scope is built from the key's member kind and handed to the callback typed
   * by the SAME kind (see {@link MembershipTxScopeFor}). The one assertion below is
   * where the runtime branch meets that type-level mapping — it cannot be wrong
   * unless the branch itself is, and each kind's key set is asserted by the
   * port-contract tests.
   */
  /** Root-only, for both scopes: nested, `.immediate()` silently degrades to a
   *  savepoint and takes no write lock at all (same reasoning as
   *  `user-persistence.ts`), so the anchor — and the roster scope's in-lock
   *  `created` — would rest on nothing. */
  const assertRoot = (): void => {
    if (db.inTransaction) {
      throw new Error(
        'membership UnitOfWork: immediate transactions are root-only; already inside a transaction',
      );
    }
  };

  function atomically<M extends WorkspaceMemberRef, T>(
    key: MembershipCoordinationKey<M>,
    fn: (tx: MembershipTxScopeFor<M>, anchor: WorkspaceMembershipAnchor | null) => T,
  ): T {
    assertRoot();
    return db
      .transaction(() => {
        const anchor = readAnchor(key.workspaceId, key.member);
        const authority = authorityPortFor(key.workspaceId);
        const scope: MembershipTxScope =
          key.member.kind === 'agent'
            ? {
                membership: agentPortFor({ workspaceId: key.workspaceId, member: key.member }),
                authority,
              }
            : {
                membership: humanPortFor({ workspaceId: key.workspaceId, member: key.member }),
                authority,
              };
        return fn(scope as MembershipTxScopeFor<M>, anchor);
      })
      .immediate();
  }

  /**
   * The ROSTER transaction: the SAME mechanism as `atomically` above — this
   * engine's write lock is file-wide, so a roster transaction and a per-principal
   * one already exclude each other — with no anchor read, because this key names
   * no single member (see the port contract).
   */
  function atomicallyForWorkspace<T>(
    workspaceId: string,
    fn: (tx: WorkspaceRosterTxScope) => T,
  ): T {
    assertRoot();
    return db
      .transaction(() => fn({ roster: rosterPortFor(workspaceId) }))
      .immediate();
  }

  return { read, uow: { atomically, atomicallyForWorkspace } };
}
