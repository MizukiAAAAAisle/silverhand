// Task-domain persistence composition (#task:1980). The ONLY file allowed to
// wire the concrete SqliteTaskRepo / SqliteTaskBoardReadModel / task UoW and
// the narrow conversation/system-event ports. Returns named driver-free ports
// only — never a concrete repo — so application/service code cannot reach raw
// DB through this surface.
import type { Database as Db } from 'better-sqlite3';
import { ConversationRepo } from './conversation-repo.js';
import { MessageRepo } from './message-repo.js';
import type {
  TaskBoardReadModelPort,
  TaskConversationAccessPort,
  TaskRepoReadPort,
  TaskSystemEventPort,
  TaskTxScope,
  TaskUnitOfWork,
  TaskWriteAuthorityPort,
} from '../services/task/ports.js';
import { SqliteTaskRepo } from './task-repo.js';
import { SqliteTaskBoardReadModel } from './task-board-read-model.js';

export interface SqliteTaskPersistence {
  read: TaskRepoReadPort;
  board: TaskBoardReadModelPort;
  conversations: TaskConversationAccessPort;
  uow: TaskUnitOfWork;
}

/** The named narrow conversation face the task domain needs (agent membership,
 *  human membership, conversation row, and the broadcaster's post-commit
 *  participant lists) — backed by ConversationRepo, deliberately NOT the whole
 *  repo surface. */
export function taskConversationAccessPort(db: Db): TaskConversationAccessPort {
  const conversations = new ConversationRepo(db);
  return {
    get: id => conversations.get(id),
    getAgent: (conversationId, agentId) => conversations.getAgent(conversationId, agentId),
    isAgentParticipant: (conversationId, agentId) =>
      conversations.isAgentParticipant(conversationId, agentId),
    // The human per-task ACL, answered by the SAME placement authority the agent
    // arm uses (§4.2 `userParticipates` / `isUserParticipant`) rather than a bare
    // `conversation_users` read. A rosterless DirectPair has no seat, so the bare
    // read judged the DM's OWN human endpoint no-access to its own pair board —
    // the reported bug (`filed #task:N from another conversation`, taskRef raw).
    // Delegating here folds the human arm into the participation authority (the
    // agent arm already reads `isAgentParticipant`); on the workspace arm it is
    // also correctly narrower — a seat that outlived its `workspace_users`
    // membership (the v25 pair) is not a participant and no longer passes.
    userCanAccessConversation: (userId, conversationId) =>
      conversations.isUserParticipant(conversationId, userId),
    listParticipantAgentIds: id => conversations.listParticipantAgentIds(id),
    listParticipantUserIds: id => conversations.listParticipantUserIds(id),
  };
}

/** One-stop composition: read port + board read-model + narrow conversation
 *  port + UoW for atomics. Single-connection SQLite: one scope serves every
 *  transaction (a pooled engine would construct per-transaction ports bound to
 *  the tx connection). `deps.messages` is a test seam for fault-injection on
 *  the system-event insert; production uses a fresh repo on `db`. */
export function createSqliteTaskPersistence(
  db: Db,
  deps: { messages?: MessageRepo } = {},
): SqliteTaskPersistence {
  const conversations = taskConversationAccessPort(db);
  const read = new SqliteTaskRepo({ db, conversations });
  const board = new SqliteTaskBoardReadModel(db);

  // In-transaction system-event insert. SQLite nests MessageRepo's internal
  // transaction as a savepoint (pre-existing create/edit behavior); a future
  // pooled adapter must insert on the tx client WITHOUT opening a new
  // transaction — see the TaskSystemEventPort contract.
  const messages = deps.messages ?? new MessageRepo(db);
  const systemEvents: TaskSystemEventPort = {
    insert(args) {
      return messages.insertForConversation({
        conversationId: args.conversationId,
        fromKind: 'system',
        content: args.content,
        threadRootId: args.threadRootId,
        metadata: args.metadata,
      });
    },
  };

  const baseScope: Omit<TaskTxScope, 'writeAuthority'> = {
    tasks: read,
    systemEvents,
    conversationAccess: conversations,
  };
  const uow: TaskUnitOfWork = {
    atomically<T>(
      writeAuthority: TaskWriteAuthorityPort,
      fn: (tx: TaskTxScope) => T,
    ): T {
      return db.transaction(() => fn({ ...baseScope, writeAuthority }))();
    },
  };

  return { read, board, conversations, uow };
}
