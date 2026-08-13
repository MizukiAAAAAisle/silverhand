import type { Database as Db } from 'better-sqlite3';
import type {
  AgentProvisioningPersistence,
  AgentProvisioningTxScope,
} from '../application/agent-provisioning-ports.js';
import { AgentRepo } from './agent-repo.js';
import { WorkspaceRepo } from './workspace-repo.js';
import { ConversationRepo } from './conversation-repo.js';
import { MessageRepo } from './message-repo.js';

/** The minimal agent face: the conditional transition + authoritative re-read
 *  in ONE operation. `lost` = the UPDATE matched no `pending_materialization`
 *  row (the row is active / failed / vanished) — another transition won, so the
 *  caller fails closed and never compensates. */
function agentProvisioningAgentsPort(db: Db): AgentProvisioningTxScope['agents'] {
  const agents = new AgentRepo(db);
  return {
    flipToActiveAndGet(id: string) {
      const changed = agents.flipToActive(id);
      if (changed === 0) return { status: 'lost' };
      const dto = agents.get(id);
      return dto
        ? { status: 'transitioned', row: { id: dto.id, name: dto.name } }
        : { status: 'lost' };
    },
  };
}

/** The workspace face: home insert + owner stamping (owner-role fixed here). */
function workspaceProvisioningPort(
  db: Db,
): AgentProvisioningTxScope['workspaces'] {
  const workspaces = new WorkspaceRepo(db);
  return {
    insertAgentHome(args) {
      const home = workspaces.insertAgentHome(args);
      return { id: home.id };
    },
    addOwnerMember(workspaceId, userId): void {
      workspaces.addUserMember(workspaceId, userId, 'owner');
    },
    setOwnerUserId(workspaceId, userId): void {
      workspaces.setOwnerUserId(workspaceId, userId);
    },
  };
}

/** The conversation face: DM insert + the two membership edges. */
function conversationProvisioningPort(
  db: Db,
): AgentProvisioningTxScope['conversations'] {
  const conversations = new ConversationRepo(db);
  return {
    insertDmChannel(args) {
      const dm = conversations.insertDmChannel(args);
      return { id: dm.id };
    },
    addAgent(conversationId, agentId): void {
      conversations.addAgent(conversationId, agentId);
    },
    addUser(conversationId, userId): void {
      conversations.addUser(conversationId, userId);
    },
  };
}

/** The message face: the onboarding system message. */
function messageProvisioningPort(db: Db): AgentProvisioningTxScope['messages'] {
  const messages = new MessageRepo(db);
  return {
    insertForConversation(args) {
      const message = messages.insertForConversation(args);
      return { id: message.id };
    },
  };
}

/**
 * One-stop composition for the agent-provisioning dependent-graph transaction.
 *
 * `atomically` is deliberately **deferred / unkeyed / no BEGIN IMMEDIATE**: the
 * scope promises atomicity only (see the port module doc). Inside the callback,
 * `insertForConversation` and `setOwnerUserId` open their own nested
 * transactions, which SQLite runs as savepoints — pre-existing behavior kept
 * exactly. A pooled/PG adapter must run the same statements on the TX client
 * without opening new transactions.
 */
export function createSqliteAgentProvisioningPersistence(
  db: Db,
): AgentProvisioningPersistence {
  const scope: AgentProvisioningTxScope = {
    agents: agentProvisioningAgentsPort(db),
    workspaces: workspaceProvisioningPort(db),
    conversations: conversationProvisioningPort(db),
    messages: messageProvisioningPort(db),
  };
  return {
    uow: {
      atomically<T>(fn: (tx: AgentProvisioningTxScope) => T): T {
        return db.transaction(() => fn(scope))();
      },
    },
  };
}
