/**
 * Outbound runtime fanout composition (#task:1982 W3).
 *
 * THE one place where the fanout's durable needs meet a driver handle. This is
 * a persistence composition module, not an allowlist of convenience: it may do
 * `Db → RuntimeFanoutPersistence` concrete wiring and nothing else. It holds no
 * fanout business judgement, no cache / coordinator / event logic, and its
 * return surface exposes neither the raw `Db` nor any concrete repo — only the
 * driver-free facets of {@link RuntimeFanoutPersistence} plus the collaborators
 * whose construction is DB-backed (`members`, `perimeter`, `statusProjector`,
 * `conversationActivity`). Production `index.ts` and every test construction
 * site consume THIS factory, so there is one wiring rather than five drifting
 * copies.
 *
 * ## Where the R4 projections happen
 *
 * Physical rows stop here. Three conversions are load-bearing rather than
 * cosmetic, because each drops columns a runtime decision must not be able to
 * read:
 *  - `inbox.*` → {@link RuntimeInboxMessage}: the joined `MessageRow` also
 *    carries `conversation_id`, the author snapshot and the retired `task_*`
 *    columns.
 *  - `hosts.get` → {@link RuntimeHostRoutingView}: `HostRow` also carries
 *    install identity and onboarding phase markers, and a routing decision
 *    must not see them.
 *  - the reconcile JOIN → {@link DbLiveRuntime}: `ConversationRepo`'s
 *    snake_case columns become the three facts the pass folds over.
 * `users.nameOf` is the same rule at field granularity: the fanout needs a
 * handle, so it never receives a `UserRow`. The perimeter guard's two reads are
 * projected here for the same reason — it is handed an owning host id and two
 * existence answers, so its policy cannot start depending on a row it was never
 * given, and the guard itself names no repo.
 *
 * Everything durable is delegated to an existing repo method — the only driver
 * call this file makes itself is the `db.transaction` behind
 * `RuntimeSessionUnitOfWork`, because a transaction boundary is precisely the
 * thing a composition module owes and a repo cannot decide.
 */
import type { Database as Db } from 'better-sqlite3';
import { AgentRepo } from '../repos/agent-repo.js';
import { ConversationEventRepo } from '../repos/conversation-event-repo.js';
import { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import { ConversationRepo } from '../repos/conversation-repo.js';
import { HostRepo } from '../repos/host-repo.js';
import { MessageRepo } from '../repos/message-repo.js';
import { RuntimeSlotRepo } from '../repos/runtime-slot-repo.js';
import { UserRepo } from '../repos/user-repo.js';
import { WorkspaceRepo } from '../repos/workspace-repo.js';
import { MembershipService } from '../services/membership-service.js';
import { EventPerimeterGuard } from '../runtime/event-perimeter.js';
import { DbRuntimeStatusProjector } from '../runtime/status-projector.js';
import type { ConversationActivitySink } from '../runtime/event-handler.js';
import type { RuntimeEventPerimeterPort } from '../runtime/event-perimeter.js';
import type { RuntimeStatusProjector } from '../runtime/status-projector.js';
import type {
  DbLiveRuntime,
  RuntimeFanoutPersistence,
  RuntimeHostRoutingView,
  RuntimeInboxDelivery,
  RuntimeInboxDeliveryKind,
  RuntimeInboxMessage,
  RuntimeMemberRosterPort,
} from '../runtime/persistence-ports.js';
import { singleConversationViewerUserId } from '../viewer-scope.js';
import type { BackendLogger } from '../context.js';
import type { EventPublisher } from '../runtime/event-handler.js';
import {
  agentRuntimePrincipal,
  conversationRuntimePrincipal,
  type RuntimePrincipal,
  type RuntimePrincipalScope,
} from '../auth/runtime-principal.js';

function principalForScope(input: {
  scope: RuntimePrincipalScope;
  generation: number;
  daemonInstanceId: string;
}): RuntimePrincipal {
  return input.scope.kind === 'agent'
    ? agentRuntimePrincipal({
        agentId: input.scope.agentId,
        generation: input.generation,
        daemonInstanceId: input.daemonInstanceId,
      })
    : conversationRuntimePrincipal({
        conversationId: input.scope.conversationId,
        agentId: input.scope.agentId,
        generation: input.generation,
        daemonInstanceId: input.daemonInstanceId,
      });
}

/**
 * Everything `OutboundRuntimeEventFanout` needs that is DB-backed. Spread into
 * its options at the call site; the fanout's own process-state authority
 * (cache, coordinator, waiter registry) is NOT here and is not constructed
 * from a driver.
 */
export interface RuntimeFanoutDbDeps {
  persistence: RuntimeFanoutPersistence;
  members: RuntimeMemberRosterPort;
  perimeter: RuntimeEventPerimeterPort;
  statusProjector: RuntimeStatusProjector;
  conversationActivity: ConversationActivitySink;
}

/** Field-by-field, so a column added to `messages` cannot ride along into the
 *  runtime by virtue of being on the joined row. The parameter is the
 *  projection itself: a `MessageRow` satisfies it structurally, and the surplus
 *  columns are dropped by construction rather than by a cast. */
function toRuntimeInboxMessage(row: RuntimeInboxMessage): RuntimeInboxMessage {
  return {
    id: row.id,
    seq: row.seq,
    thread_root_id: row.thread_root_id,
    from_kind: row.from_kind,
    from_agent_id: row.from_agent_id,
    from_user_id: row.from_user_id,
    content: row.content,
    created_at: row.created_at,
    metadata: row.metadata,
  };
}

/** `deliveryKind`'s assignment here is the drift alarm: a persistence-side
 *  vocabulary that grows a member stops type-checking in this file rather than
 *  reaching the runtime as an unmodelled string. */
function toRuntimeInboxDelivery(item: {
  inboxId: number;
  deliveryKind: RuntimeInboxDeliveryKind;
  message: RuntimeInboxMessage;
}): RuntimeInboxDelivery {
  return {
    inboxId: item.inboxId,
    deliveryKind: item.deliveryKind,
    message: toRuntimeInboxMessage(item.message),
  };
}

export function createRuntimeFanoutDbDeps(deps: {
  db: Db;
  events: EventPublisher;
  logger: BackendLogger;
}): RuntimeFanoutDbDeps {
  const agents = new AgentRepo(deps.db);
  const conversations = new ConversationRepo(deps.db);
  const conversationEvents = new ConversationEventRepo(deps.db);
  const hosts = new HostRepo(deps.db);
  const inbox = new ConversationInboxRepo(deps.db);
  const messages = new MessageRepo(deps.db);
  const runtimeSlots = new RuntimeSlotRepo(deps.db);
  const users = new UserRepo(deps.db);
  const workspaces = new WorkspaceRepo(deps.db);

  const persistence: RuntimeFanoutPersistence = {
    inbox: {
      ensureDelivery: (conversationId, agentId, messageId) =>
        inbox.ensureDelivery(conversationId, agentId, messageId),
      listPending: (conversationId, agentId) =>
        inbox.listPending(conversationId, agentId).map(toRuntimeInboxDelivery),
      listPendingConversationIdsForAgent: agentId =>
        inbox.listPendingConversationIdsForAgent(agentId),
      claimPending: (conversationId, agentId, inFlightOwner) =>
        inbox
          .claimPending(conversationId, agentId, inFlightOwner)
          .map(item => ({
            ...toRuntimeInboxDelivery(item),
            inFlightOwner: item.inFlightOwner,
          })),
      hasUndeliveredForPair: (conversationId, agentId) =>
        inbox.hasUndeliveredForPair(conversationId, agentId),
      countInFlightForPairOwner: (conversationId, agentId, inFlightOwner) =>
        inbox.countInFlightForPairOwner(conversationId, agentId, inFlightOwner),
      settleDelivered: input => inbox.settleDelivered(input),
      settleUndelivered: input => inbox.settleUndelivered(input),
      rollbackInFlight: (inboxIds, inFlightOwner) => {
        inbox.rollbackInFlight(inboxIds, inFlightOwner);
      },
      rollbackInFlightAnyOwner: inboxIds => {
        inbox.rollbackInFlightAnyOwner(inboxIds);
      },
      rollbackInFlightForOwner: inFlightOwner => {
        inbox.rollbackInFlightForOwner(inFlightOwner);
      },
      rollbackInFlightForPairExceptOwner: (conversationId, agentId, currentOwner) =>
        inbox.rollbackInFlightForPairExceptOwner(
          conversationId,
          agentId,
          currentOwner,
        ),
    },
    agents: {
      get: agentId => agents.get(agentId),
      isRuntimeTransitioning: agentId => agents.isRuntimeTransitioning(agentId),
    },
    conversations: {
      get: conversationId => conversations.get(conversationId),
      isAgentParticipant: (conversationId, agentId) =>
        conversations.isAgentParticipant(conversationId, agentId),
      getAgent: (conversationId, agentId) =>
        conversations.getAgent(conversationId, agentId),
      listAgents: conversationId => conversations.listAgents(conversationId),
      singleViewerUserId: conversationId =>
        singleConversationViewerUserId(conversations, conversationId),
    },
    workspaces: {
      get: workspaceId => workspaces.get(workspaceId),
      listForAgent: agentId => workspaces.listForAgent(agentId),
    },
    users: {
      nameOf: userId => users.get(userId)?.name ?? null,
    },
    hosts: {
      routingView: hostId => {
        const row = hosts.get(hostId);
        if (!row) return null;
        const view: RuntimeHostRoutingView = {
          id: row.id,
          ownerUserId: row.user_id,
          revokedAt: row.revoked_at,
        };
        return view;
      },
    },
    runtimeCustody: {
      snapshot: scope => {
        const row = runtimeSlots.get(scope);
        return row
          ? {
              generation: row.generation,
              daemonInstanceId: row.claimed_by_daemon_instance_id,
              cliSessionId: row.cli_session_id,
            }
          : null;
      },
      cliSessionId: scope => runtimeSlots.get(scope)?.cli_session_id ?? null,
      current: scope => {
        const row = runtimeSlots.get(scope);
        if (!row || !row.claimed_by_daemon_instance_id) return null;
        return principalForScope({
          scope,
          generation: row.generation,
          daemonInstanceId: row.claimed_by_daemon_instance_id,
        });
      },
      claim: ({ scope, daemonInstanceId }) => {
        const row = runtimeSlots.claimGeneration({
          scope,
          daemonInstanceId,
        });
        return row
          ? principalForScope({
              scope,
              generation: row.generation,
              daemonInstanceId,
            })
          : null;
      },
      finalize: input => {
        const row = runtimeSlots.finalizeGeneration({
          scope: input.scope,
          expectedGeneration: input.generation,
          expectedDaemonInstanceId: input.daemonInstanceId,
          status: input.status,
        });
        return row
          ? principalForScope({
              scope: input.scope,
              generation: row.generation,
              daemonInstanceId: input.daemonInstanceId,
            })
          : null;
      },
    },
    hydrateReconcile: {
      listDbLiveRuntimesForHost: hostId =>
        runtimeSlots.listLiveSlotsForHost(hostId).map<DbLiveRuntime>(row => ({
          scope: row.conversation_id === null
            ? { kind: 'agent', agentId: row.agent_id }
            : {
                kind: 'conversation',
                conversationId: row.conversation_id,
                agentId: row.agent_id,
              },
          focusConversationId: row.conversation_id,
          agentId: row.agent_id,
          generation: row.generation,
          daemonInstanceId: row.claimed_by_daemon_instance_id,
          status: row.observed_status as 'active' | 'starting',
          pid: row.observed_pid,
        })),
      markCrashed: runtime => {
        const scope = runtime.scope;
        const updated = runtime.daemonInstanceId
          ? runtimeSlots.finalizeGeneration({
              scope,
              expectedGeneration: runtime.generation,
              expectedDaemonInstanceId: runtime.daemonInstanceId,
              status: 'crashed',
            })
          : runtimeSlots.updateCurrentProjection(scope, {
              status: 'crashed',
              pid: null,
            });
        return updated !== null;
      },
    },
    session: {
      // SQLite BEGIN IMMEDIATE owns the writer reservation before the first
      // participation read. This is isolation, not just atomicity: no rival
      // writer can invalidate authorization/custody between that read, the
      // generation CAS, and its audit write. See the R5 port contract.
      atomically: fn => {
        // Root-only: better-sqlite3 silently degrades nested `.immediate()` to
        // a SAVEPOINT, which takes no writer reservation. Entering the
        // authorization callback in that state would invalidate R5.
        if (deps.db.inTransaction) {
          throw new Error(
            'runtime session UnitOfWork: immediate transactions are root-only; already inside a transaction',
          );
        }
        return deps.db.transaction(() =>
          fn({
            clearCliSession: input => {
              if (
                input.scope.kind === 'conversation'
                && !conversations.isAgentParticipant(
                  input.scope.conversationId,
                  input.scope.agentId,
                )
              ) return null;
              const slot = runtimeSlots.clearCliSession(input);
              return slot
                ? {
                    scope: input.scope,
                    generation: input.expectedGeneration,
                    projection: {
                      status: slot.observed_status,
                      pid: slot.observed_pid,
                      cli_session_id: slot.cli_session_id,
                    },
                  }
                : null;
            },
            insertAgentControlEvent: input =>
              runtimeSlots.insertControlEvent(input),
            insertSystemMessage: input =>
              messages.insertForConversation({
                conversationId: input.conversationId,
                fromKind: 'system',
                fromUserId: input.fromUserId,
                content: input.content,
                metadata: input.metadata,
              }),
          }),
        ).immediate();
      },
    },
  };

  return {
    persistence,
    members: new MembershipService({ agents, users, conversations }),
    perimeter: new EventPerimeterGuard({
      // The guard's reads are projections too (R4): it receives the owning
      // host id and two existence answers, never an agent or conversation row.
      agents: { ownerHostIdOf: agentId => agents.get(agentId)?.host_id ?? null },
      conversations: {
        exists: conversationId => conversations.get(conversationId) !== null,
        hasAgent: (conversationId, agentId) =>
          conversations.getAgent(conversationId, agentId) !== null,
      },
      logger: deps.logger,
    }),
    // DB-backed but stateless — the whole runtime-event → status mapping lives
    // in the projector, so ONE instance serves every host the fanout tracks.
    statusProjector: new DbRuntimeStatusProjector(runtimeSlots, deps.events, {
      listProjectionConversationIds: agentId =>
        agents.listRuntimeParticipations(agentId).map(row => row.conversation_id),
    }),
    conversationActivity: conversationEvents,
  };
}
