/**
 * #task:1983 W1 — the application's persistence composition entry point.
 *
 * This module is where the driver handle is SPENT: `createBackendPersistence`
 * takes the raw `Db` and returns only driver-free repositories, unit-of-work
 * ports and persistence adapters. It is deliberately NOT the only place in the
 * process that may hold a handle — boot still opens the file, runs migrations,
 * instruments statements and closes it, and the offline `admin` composition owns
 * its own short-lived handle. The contract is exactly this, and it is
 * mechanically enforced rather than promised:
 *
 *   **No module outside this file names a `repos/*` module or a persistence
 *   adapter. Boot owns the DRIVER (open / migrate / observe / close); it
 *   composes no persistence, and the handle never enters `BackendContext` or
 *   the router.**
 *
 * The two gates that hold it up are `tests/db-boundary/port-contract.test.ts`
 * (`index.ts` is fenced from `repos/*` and off the concrete-import allowlist, so
 * a new `createSqliteX(db)` in boot cannot be written without naming a module
 * boot may not name) and the composition-zone cardinality check in
 * `import-ratchet.test.ts`. Neither is a claim about instance counts:
 *
 *   - Repos are NOT process-singletons and this file does not make them so.
 *     The sub-compositions below (`createSqliteConversationPersistence`, the
 *     effect builders, `createSqliteTaskPersistence`) each construct their own
 *     repo instances internally. That is fine — a repo owns nothing but its
 *     prepared statements over the one shared connection — and pretending
 *     otherwise would be a promise the code does not keep.
 *   - What IS single is the assembly site. Before this file, `index.ts` and
 *     `routes.ts` each built their own set from `ctx.db` (`new AgentRepo(db)`
 *     appeared four times across the two), so "who composes persistence?" had
 *     two answers that could drift apart. Now it has one.
 *
 * Because the bag is assembled here, `createApiRouter` takes it as a parameter
 * instead of reaching into the context for a handle — which is what lets
 * #task:1983 W5 delete `BackendContext.db` outright.
 *
 * This bag is a COMPOSITION-LAYER value, not a service locator: route modules
 * keep taking the individual repos/ports they need through their existing
 * `*RouteDeps` objects. Nothing below the composition root should accept
 * `BackendPersistence` itself — a handler that holds the whole bag can reach
 * persistence it never declared, which is the ambient-capability problem this
 * task exists to remove, one level up.
 *
 * Scope limit, stated so nobody reads more into the file than it earns: this is
 * NOT a swappable-engine seam yet. `BackendRepos` names concrete SQLite classes
 * and `hostTokens` is a concrete bundle, so a PostgreSQL adapter would first
 * have to turn those into ports (the incremental work #task:1978 → #1990 has
 * been doing domain by domain). What this file buys today is that the CALL
 * SITES stop naming concretes, which is the precondition for that swap, not the
 * swap itself.
 */
import type { Database as Db } from 'better-sqlite3';

import { AgentRepo } from '../repos/agent-repo.js';
import { AgentCapabilityRepo } from '../repos/agent-capability-repo.js';
import { AttachmentRepo } from '../repos/attachment-repo.js';
import { AttentionBadgeRepo } from '../repos/attention-badge-repo.js';
import { ChannelAttentionPreferenceRepo } from '../repos/channel-attention-preference-repo.js';
import { ConversationEventRepo } from '../repos/conversation-event-repo.js';
import { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import { ConversationReadRepo } from '../repos/conversation-read-repo.js';
import { ConversationRepo } from '../repos/conversation-repo.js';
import { HostRepo } from '../repos/host-repo.js';
import { MessageReactionRepo } from '../repos/message-reaction-repo.js';
import { MessageRepo } from '../repos/message-repo.js';
import { NotificationRepo } from '../repos/notification-repo.js';
import { SavedMessageRepo } from '../repos/saved-message-repo.js';
import { ScheduleRepo } from '../repos/schedule-repo.js';
import { SearchRepo } from '../repos/search-repo.js';
import { SortRepo } from '../repos/sort-repo.js';
import { UserRepo } from '../repos/user-repo.js';
import { WorkspaceAttentionPreferenceRepo } from '../repos/workspace-attention-preference-repo.js';
import { WorkspaceRepo } from '../repos/workspace-repo.js';

import {
  createHandleNamespacePort,
  createSqliteAuthUnitOfWork,
} from '../repos/auth-uow.js';
import { SqliteAuthCredentialsRepo } from '../repos/auth-credentials-repo.js';
import { SqliteAuthSessionsRepo } from '../repos/auth-sessions-repo.js';
import {
  createSqliteHostPersistence,
  type SqliteHostPersistence,
} from '../repos/host-uow.js';
import {
  createSqliteConversationPersistence,
  type SqliteConversationPersistence,
} from '../repos/conversation-persistence.js';
import {
  createSqliteTaskPersistence,
  type SqliteTaskPersistence,
} from '../repos/task-persistence.js';
import { createSqliteAuthorizationReads } from '../repos/authorization-reads.js';
import { createSqliteMembershipPersistence } from '../repos/membership-persistence.js';
import { createSqliteAgentProvisioningPersistence } from '../repos/agent-provisioning-persistence.js';
import { createSqliteAgentTeardownPersistence } from '../repos/agent-teardown-persistence.js';
import { createSqliteObservationPersistence } from '../repos/observation-persistence.js';
import { createSqliteUserPersistence } from '../repos/user-persistence.js';
import { createMentionCcAdapter } from '../adapters/mention-cc.js';
import {
  createRuntimeFanoutDbDeps,
  type RuntimeFanoutDbDeps,
} from '../adapters/runtime-fanout.js';
import { createUnreadPublishAdapter } from '../adapters/unread-publish.js';
import {
  createReadModels,
  type BackendReadModels,
} from '../read-model/index.js';

import type {
  AuthCredentialsPort,
  AuthSessionsPort,
  AuthUnitOfWork,
  HandleNamespacePort,
} from '../auth/ports.js';
import type { AgentProvisioningPersistence } from '../application/agent-provisioning-ports.js';
import type { AuthorizationReadPort } from '../authorization-ports.js';
import type { AgentTeardownPersistence } from '../application/agent-teardown-ports.js';
import type { MembershipPersistence } from '../application/membership-ports.js';
import type { ObservationPersistence } from '../application/observation-ports.js';
import type { BackendLogger } from '../context.js';
import type { AgentRuntimeHost } from '../runtime/agent-runtime-host.js';
import type { EventPublisher } from '../runtime/event-handler.js';
import type { ConversationUnreadPublishPort } from '../services/conversation/unread-publish-port.js';
import type { MentionCcPort } from '../services/conversation-message/ports.js';
import type { UserPersistence } from '../services/user/ports.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';

/**
 * The repository set the composition hands out. Assembled once here; a
 * sub-composition that needs its own instances still builds them (see the file
 * header on why that is not a contradiction).
 */
export interface BackendRepos {
  readonly agents: AgentRepo;
  /** Per-(workspace, agent) capability grants — the graded-permissions axis. */
  readonly agentCapabilities: AgentCapabilityRepo;
  readonly attachments: AttachmentRepo;
  readonly attentionBadges: AttentionBadgeRepo;
  readonly channelAttentionPrefs: ChannelAttentionPreferenceRepo;
  readonly conversationEvents: ConversationEventRepo;
  readonly conversationInboxes: ConversationInboxRepo;
  readonly conversationReads: ConversationReadRepo;
  readonly conversations: ConversationRepo;
  readonly hosts: HostRepo;
  readonly messages: MessageRepo;
  readonly notifications: NotificationRepo;
  readonly reactions: MessageReactionRepo;
  readonly saved: SavedMessageRepo;
  readonly schedules: ScheduleRepo;
  readonly search: SearchRepo;
  readonly sort: SortRepo;
  readonly users: UserRepo;
  readonly workspaceAttentionPrefs: WorkspaceAttentionPreferenceRepo;
  readonly workspaces: WorkspaceRepo;
}

/**
 * The effect-carrying persistence adapters. Each one needs a runtime effect
 * (the event bus, the runtime host, a logger) that persistence has no business
 * owning, so they are exposed as NAMED builders instead of values: boot passes
 * the effects, the raw handle stays closed over here. That keeps the "boot never
 * holds persistence" rule true without moving the event bus into this file.
 */
export interface BackendPersistenceEffects {
  /** Conversation-scoped `unread_updated` + its co-emitted badge (#task:1870). */
  readonly unreadPublish: (deps: {
    events: ScopeEventBus;
  }) => ConversationUnreadPublishPort;
  /** Cross-channel mention cc fan-out (#task:1982 W2). */
  readonly mentionCc: (deps: {
    runtimeHost: AgentRuntimeHost;
    events: ScopeEventBus;
    logger: BackendLogger;
  }) => MentionCcPort;
  /** The outbound runtime fanout's durable facets (#task:1982 W3). */
  readonly runtimeFanout: (deps: {
    events: EventPublisher;
    logger: BackendLogger;
  }) => RuntimeFanoutDbDeps;
}

/**
 * Everything the runtime layers may obtain from persistence. Every member is
 * driver-free: no field of this type names `better-sqlite3`.
 */
export interface BackendPersistence {
  readonly repos: BackendRepos;
  /** The narrow fact set `permissions.ts` decides on (#task:1983 W3). Installed
   *  on the context as `authorizationReads`; read by that module alone. */
  readonly authorizationReads: AuthorizationReadPort;
  /** Auth write boundary, the handle-uniqueness namespace it guards, and the
   *  two direct credential / session ports the auth services sit on. */
  readonly auth: {
    readonly uow: AuthUnitOfWork;
    readonly handles: HandleNamespacePort;
    readonly credentials: AuthCredentialsPort;
    readonly sessions: AuthSessionsPort;
  };
  /** Host-token rotation persistence (carries its own UoW). */
  readonly hostTokens: SqliteHostPersistence;
  /** User read / profile / registration ports (#task:1902). */
  readonly users: UserPersistence;
  /** Membership write boundary shared by every membership surface (#task:1987). */
  readonly membership: MembershipPersistence;
  /** create-agent dependent-row transaction (#task:1990). */
  readonly agentProvisioning: AgentProvisioningPersistence;
  /** The single destructive-teardown UoW for agent + computer deletes (#task:1987 D). */
  readonly agentTeardown: AgentTeardownPersistence;
  /** Viewer-keyed observation write boundary (#task:1987 E). */
  readonly observations: ObservationPersistence;
  /** Channel / message / thread-follow / delivery ports (#task:1981). */
  readonly conversation: SqliteConversationPersistence;
  /** Task read + board + narrow conversation access + UoW (#task:1980). */
  readonly tasks: SqliteTaskPersistence;
  /** The projection surfaces, handle bound at assembly time (#task:1983 W2). */
  readonly readModels: BackendReadModels;
  readonly effects: BackendPersistenceEffects;
}

export function createBackendPersistence(db: Db): BackendPersistence {
  const repos: BackendRepos = {
    agents: new AgentRepo(db),
    agentCapabilities: new AgentCapabilityRepo(db),
    attachments: new AttachmentRepo(db),
    attentionBadges: new AttentionBadgeRepo(db),
    channelAttentionPrefs: new ChannelAttentionPreferenceRepo(db),
    conversationEvents: new ConversationEventRepo(db),
    conversationInboxes: new ConversationInboxRepo(db),
    conversationReads: new ConversationReadRepo(db),
    conversations: new ConversationRepo(db),
    hosts: new HostRepo(db),
    messages: new MessageRepo(db),
    notifications: new NotificationRepo(db),
    reactions: new MessageReactionRepo(db),
    saved: new SavedMessageRepo(db),
    schedules: new ScheduleRepo(db),
    search: new SearchRepo(db),
    sort: new SortRepo(db),
    users: new UserRepo(db),
    workspaceAttentionPrefs: new WorkspaceAttentionPreferenceRepo(db),
    workspaces: new WorkspaceRepo(db),
  };
  return {
    repos,
    authorizationReads: createSqliteAuthorizationReads({
      workspaces: repos.workspaces,
      conversations: repos.conversations,
      agents: repos.agents,
      capabilities: repos.agentCapabilities,
      attachments: repos.attachments,
    }),
    auth: {
      // `deferred` is the auth boundary's reviewed mode (#task:1982): the
      // transaction upgrades to a write lock at its first write, so read-only
      // auth paths do not serialize behind it.
      uow: createSqliteAuthUnitOfWork(db, { txMode: 'deferred' }),
      handles: createHandleNamespacePort(db),
      credentials: new SqliteAuthCredentialsRepo(db),
      sessions: new SqliteAuthSessionsRepo(db),
    },
    hostTokens: createSqliteHostPersistence(db),
    users: createSqliteUserPersistence(db),
    membership: createSqliteMembershipPersistence(db),
    agentProvisioning: createSqliteAgentProvisioningPersistence(db),
    agentTeardown: createSqliteAgentTeardownPersistence(db),
    observations: createSqliteObservationPersistence(db),
    conversation: createSqliteConversationPersistence(db),
    tasks: createSqliteTaskPersistence(db),
    readModels: createReadModels(db),
    effects: {
      unreadPublish: ({ events }) => createUnreadPublishAdapter({ db, events }),
      mentionCc: ({ runtimeHost, events, logger }) =>
        createMentionCcAdapter({ db, runtimeHost, events, logger }),
      runtimeFanout: ({ events, logger }) =>
        createRuntimeFanoutDbDeps({ db, events, logger }),
    },
  };
}
