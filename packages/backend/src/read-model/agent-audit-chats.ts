// Read-model for the owner-audit chats list — `GET /api/agents/:id/chats`
// (#task:2036 part ②). The owner of an agent may read, in full and read-only,
// every conversation the agent is a party to (except the agent's own inbox),
// because they bear the agent's runtime and can already see the same content
// through it — so hiding it in the UI protects nothing (@shiki's ruling).
//
// MEMBERSHIP is the transpose of participation, exactly like the DM list: the
// enumeration lives in the single placement authority
// (`AgentRepo.listAuditChats` → `agentParticipates`), so this module never
// re-states which conversations an agent is a party to; it only turns each row
// into the display union. The AgentInbox is dropped by the enumeration, matching
// the per-conversation gate (`canAuditAgentConversation`).
//
// Heterogeneous by placement: a workspace-placed conversation draws by its title
// and workspace coordinates; a `direct_pair` draws by its COUNTERPART — the
// endpoint that is NOT the audited agent — resolved by the ONE shared
// counterpart resolver the DM list also uses, so "the other one" is spelled once.
//
// Nothing here writes and nothing decides authority: the ACL that admits the
// owner is `canAuditAgentChats`, asked in the route before this runs.
import type { Database as Db } from 'better-sqlite3';
import {
  directPairIsReadOnlyForSurvivor,
  type AgentAuditChatListResponse,
  type AgentAuditChatSummary,
} from '@silverhand/shared';
import { AgentRepo, type AgentAuditChatRow } from '../repos/agent-repo.js';
import {
  createPrincipalResolver,
  resolveCounterpart,
  type PrincipalResolver,
} from './direct-pair-counterpart.js';

/** Project the agent's auditable chats. Pure read. Order is the enumeration's:
 *  creation order, oldest first. */
export function listAgentAuditChats(
  db: Db,
  agentId: string,
): AgentAuditChatListResponse {
  const rows = new AgentRepo(db).listAuditChats(agentId);
  if (rows.length === 0) return { chats: [] };

  const { resolve, exists } = createPrincipalResolver(db);
  // The audited agent is one endpoint of each of its direct_pairs; the
  // counterpart is the OTHER side (who the agent is talking to).
  const reference = { kind: 'agent' as const, id: agentId };

  const chats: AgentAuditChatSummary[] = rows.map(row =>
    toSummary(row, reference, resolve, exists),
  );
  return { chats };
}

function toSummary(
  row: AgentAuditChatRow,
  reference: { kind: 'agent'; id: string },
  resolve: PrincipalResolver,
  exists: (endpoint: { kind: 'agent' | 'human'; id: string }) => boolean,
): AgentAuditChatSummary {
  if (row.placement_kind === 'direct_pair') {
    return {
      placement_kind: 'direct_pair',
      conversation_id: row.id,
      counterpart: resolveCounterpart(row, reference, resolve),
      read_only: directPairIsReadOnlyForSurvivor(row, exists),
      archived_at: row.archived_at,
      created_at: row.created_at,
    };
  }
  // Workspace-placed (the enumeration excludes `agent_inbox`, so this is the only
  // other arm). Its workspace coordinates are present-and-non-null by the
  // placement's definition — a workspace conversation has a workspace and a
  // title — so a NULL here is a loader fault, not a state: fail loud rather than
  // ship a half row.
  if (
    row.workspace_id === null
    || row.workspace_name === null
    || row.workspace_kind === null
  ) {
    throw new Error(
      `audit chat ${row.id} is workspace-placed but is missing a workspace coordinate`,
    );
  }
  return {
    placement_kind: 'workspace',
    conversation_id: row.id,
    roster_policy: row.roster_policy,
    title: row.title,
    workspace_id: row.workspace_id,
    workspace_name: row.workspace_name,
    workspace_kind: row.workspace_kind,
    archived_at: row.archived_at,
    created_at: row.created_at,
  };
}

/**
 * The owner-audit chats read surface a caller receives, handle already bound
 * (#task:1983 W2). Route modules declare THIS in their deps.
 */
export interface AgentAuditChatsReadModel {
  readonly listChats: (agentId: string) => AgentAuditChatListResponse;
}

export function createAgentAuditChatsReadModel(
  db: Db,
): AgentAuditChatsReadModel {
  return { listChats: agentId => listAgentAuditChats(db, agentId) };
}
