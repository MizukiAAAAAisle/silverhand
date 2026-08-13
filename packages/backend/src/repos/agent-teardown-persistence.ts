import type { Database as Db } from 'better-sqlite3';
import type { AgentDto } from '@silverhand/shared';
import type {
  AgentTeardownCapture,
  AgentDeletionAttempt,
  AgentTeardownFacts,
  AgentTeardownKey,
  AgentTeardownPersistence,
  AgentTeardownReadPort,
  AgentTeardownTxPort,
  ComputerTeardownFacts,
  ComputerTeardownKey,
  ComputerTeardownTxScope,
  SingleAgentTeardownTxScope,
} from '../application/agent-teardown-ports.js';
import { AgentRepo } from './agent-repo.js';
import { WorkspaceRepo } from './workspace-repo.js';
import { ConversationRepo } from './conversation-repo.js';
import { AttachmentRepo, rowToStoredRef } from './attachment-repo.js';
import { HostRepo } from './host-repo.js';

/** The ONE agent projection both axes and the pre-flight read share. Physical
 *  rows and DTOs stop here (R4): a column added to `agents` cannot reach a
 *  delete decision without being named on {@link AgentTeardownFacts}. */
function toAgentFacts(dto: AgentDto): AgentTeardownFacts {
  return {
    id: dto.id,
    name: dto.name,
    displayName: dto.display_name,
    runtime: dto.runtime,
    hostId: dto.host_id,
    materializationStatus: dto.materialization_status,
    failedCode: dto.materialization_failed_code,
    deletionStartedAt: dto.deletion_started_at,
  };
}

interface TeardownRepos {
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  attachments: AttachmentRepo;
  hosts: HostRepo;
}

/**
 * The SINGLE implementation of the per-agent teardown face, bound to `agentId`.
 * Both axes mint it from here — the computer cascade cannot capture or delete
 * differently from a single-agent delete because there is nothing else to call.
 */
function agentTeardownFace(
  repos: TeardownRepos,
  agentId: string,
): AgentTeardownTxPort {
  const { agents, workspaces, conversations, attachments } = repos;
  return {
    readFacts(): AgentTeardownFacts | null {
      const dto = agents.get(agentId);
      return dto ? toAgentFacts(dto) : null;
    },
    capture(): AgentTeardownCapture {
      // RAW statuses — the "which of these is still running" rule is the use
      // case's (see the port doc); filtering here would hide it from its tests.
      const runtimeSessions = agents
        .listRuntimeConversations(agentId)
        .map(session => ({
          conversationId: session.conversation_id,
          status: session.status,
        }));
      // The agent's own home is the ONLY discovery path for its DM blobs: the
      // `attachments` rows hang off those channels and cascade away with the
      // home, so a post-commit sweep could not find them again.
      const ownedHome = workspaces.getAgentHomeByOwner(agentId);
      const dmChannels = ownedHome
        ? conversations.listAllDmChannelsForWorkspace(ownedHome.id)
        : [];
      const dmBlobRefs = dmChannels.flatMap(channel =>
        attachments.listByChannel(channel.id).map(rowToStoredRef),
      );
      const regularWorkspaceCount = workspaces
        .listForAgent(agentId)
        .filter(workspace => workspace.workspace_kind === 'regular').length;
      return {
        runtimeSessions,
        dmBlobRefs,
        dmChannelId: dmChannels[0]?.id ?? null,
        regularWorkspaceCount,
      };
    },
    deleteAgentRow(): void {
      // The whole dependent graph goes by FOREIGN KEY — pinned as a persistence
      // contract in `tests/repos/agent-teardown-persistence.test.ts`.
      agents.delete(agentId);
    },
  };
}

/**
 * Persistence for the two destructive cascades (#task:1987 D).
 *
 * Both axes are ROOT-ONLY `BEGIN IMMEDIATE`: each scope decides from an
 * authoritative read (eligibility, host membership) that PRECEDES its writes, so
 * the write lock must already be held when the callback starts. Nested use is
 * refused loudly — inside an open transaction better-sqlite3's `.immediate()`
 * silently degrades to a savepoint that takes no lock, and the in-scope re-read
 * would then rest on nothing.
 *
 * SQLite's write lock is file-wide, so the agent axis and the computer axis
 * already exclude each other with nothing extra. A pooled/PG adapter owes that
 * exclusion explicitly — see the UnitOfWork doc in
 * `application/agent-teardown-ports.ts`.
 */
export function createSqliteAgentTeardownPersistence(
  db: Db,
): AgentTeardownPersistence {
  // Hoisted: a pooled adapter would build these per connection inside the
  // scope instead. Under better-sqlite3 there is one connection, and the
  // transaction runs on it, so construction order is irrelevant.
  const repos: TeardownRepos = {
    agents: new AgentRepo(db),
    workspaces: new WorkspaceRepo(db),
    conversations: new ConversationRepo(db),
    attachments: new AttachmentRepo(db),
    hosts: new HostRepo(db),
  };

  const assertRoot = (): void => {
    if (db.inTransaction) {
      throw new Error(
        'agent teardown UnitOfWork: immediate transactions are root-only; already inside a transaction',
      );
    }
  };

  const deletionMarkerRead = createSqliteAgentDeletionMarkerReadPort(db);
  const read: AgentTeardownReadPort = {
    readAgentFacts(agentId: string): AgentTeardownFacts | null {
      const dto = repos.agents.get(agentId);
      return dto ? toAgentFacts(dto) : null;
    },
    isDeletionPending(agentId: string): boolean {
      return deletionMarkerRead.isDeletionPending(agentId);
    },
    listRuntimeSessions(agentId: string) {
      return repos.agents.listRuntimeConversations(agentId).map(session => ({
        conversationId: session.conversation_id,
        status: session.status,
      }));
    },
    readComputerFacts(hostId: string): ComputerTeardownFacts | null {
      const row = repos.hosts.get(hostId);
      return row
        ? {
            id: row.id,
            userId: row.user_id,
            kind: row.kind,
            provisioningSource: row.provisioning_source,
          }
        : null;
    },
  };

  return {
    read,
    deletion: {
      begin(agentId, startedAt) {
        assertRoot();
        return db.transaction(() => {
          const before = repos.agents.getRow(agentId);
          if (!before) return { kind: 'notFound' } as const;
          if (before.deletion_started_at !== null) {
            return {
              kind: 'alreadyPending',
              attempt: {
                agentId,
                hostId: before.host_id,
                deletionStartedAt: before.deletion_started_at,
              },
            } as const;
          }
          if (before.materialization_status !== 'active') {
            return { kind: 'notActive' } as const;
          }
          if (before.runtime_transition_target !== null) {
            return { kind: 'runtimeTransitionInProgress' } as const;
          }
          const changed = db
            .prepare(
              `UPDATE agents
                  SET deletion_started_at = ?,
                      updated_at = ?
                WHERE id = ?
                  AND materialization_status = 'active'
                  AND deletion_started_at IS NULL
                  AND runtime_transition_target IS NULL`,
            )
            .run(startedAt, startedAt, agentId).changes;
          if (changed !== 1) {
            throw new Error(
              `begin agent deletion lost serialized CAS for ${agentId}`,
            );
          }
          return {
            kind: 'started',
            attempt: {
              agentId,
              hostId: before.host_id,
              deletionStartedAt: startedAt,
            },
          } as const;
        }).immediate();
      },
      listPending(): AgentDeletionAttempt[] {
        return db
          .prepare<[], {
            id: string;
            host_id: string;
            deletion_started_at: number;
          }>(
            `SELECT id, host_id, deletion_started_at
               FROM agents
              WHERE deletion_started_at IS NOT NULL
              ORDER BY deletion_started_at ASC, id ASC`,
          )
          .all()
          .map(row => ({
            agentId: row.id,
            hostId: row.host_id,
            deletionStartedAt: row.deletion_started_at,
          }));
      },
      complete(attempt) {
        assertRoot();
        return db.transaction(() => {
          const facts = agentTeardownFace(repos, attempt.agentId).readFacts();
          if (!facts) return { kind: 'gone' } as const;
          if (
            facts.materializationStatus !== 'active' ||
            facts.hostId !== attempt.hostId ||
            facts.deletionStartedAt !== attempt.deletionStartedAt
          ) {
            return { kind: 'attemptLost' } as const;
          }
          const face = agentTeardownFace(repos, attempt.agentId);
          const capture = face.capture();
          face.deleteAgentRow();
          return { kind: 'committed', facts, capture } as const;
        }).immediate();
      },
    },
    uow: {
      atomicallyForAgent<T>(
        key: AgentTeardownKey,
        fn: (tx: SingleAgentTeardownTxScope) => T,
      ): T {
        assertRoot();
        return db
          .transaction(() => fn({ agent: agentTeardownFace(repos, key.agentId) }))
          .immediate();
      },
      atomicallyForComputer<T>(
        key: ComputerTeardownKey,
        fn: (tx: ComputerTeardownTxScope) => T,
      ): T {
        assertRoot();
        const scope: ComputerTeardownTxScope = {
          computer: {
            listAgentsForUpdate(): AgentTeardownFacts[] {
              return repos.agents.listByHost(key.hostId).map(toAgentFacts);
            },
            forAgent(agentId: string): AgentTeardownTxPort {
              // The binding rule: an id that names something the KEY does not.
              // Read under the mechanism, so a concurrent host move cannot slip
              // an agent past it; a violation aborts the whole scope.
              const dto = repos.agents.get(agentId);
              if (!dto || dto.host_id !== key.hostId) {
                throw new Error(
                  `agent teardown UnitOfWork: agent ${agentId} is not on coordinated computer ${key.hostId}`,
                );
              }
              return agentTeardownFace(repos, agentId);
            },
            deleteComputerRow(): boolean {
              // Conditional by contract (remote / user_invite / owned by the
              // key's user) — `false` means "not deletable by this request".
              return repos.hosts.deleteOwnedUserInvite({
                hostId: key.hostId,
                userId: key.userId,
              });
            },
          },
        };
        return db.transaction(() => fn(scope)).immediate();
      },
    },
  };
}

/** Hot-path boolean projection used by the outbound mutator gate. It does not
 * hydrate an AgentRow or decode unrelated columns for every runtime frame. */
export function createSqliteAgentDeletionMarkerReadPort(
  db: Db,
): Pick<AgentTeardownReadPort, 'isDeletionPending'> {
  const pending = db.prepare<[string], { present: 1 }>(
    `SELECT 1 AS present
       FROM agents
      WHERE id = ?
        AND deletion_started_at IS NOT NULL`,
  );
  return {
    isDeletionPending(agentId: string): boolean {
      return pending.get(agentId) !== undefined;
    },
  };
}
