import { Hono } from 'hono';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type {
  AgentRunState,
  AgentRunTerminalReason,
  BindAddressScope,
  ServerConfig,
} from '@silverhand/shared';
import {
  decodeUserPrincipalHeader,
  isAgentHomeWorkspaceId,
  X_SILVERHAND_LEGACY_USER_ID_HEADER as LEGACY_USER_ID_HEADER,
  X_SILVERHAND_PRINCIPAL_HEADER as PRINCIPAL_HEADER,
} from '@silverhand/shared';
import type {
  BackendContext,
  BackendDeploymentMode,
  BackendLogger,
} from '../../src/context.js';
import { silverhandCors } from '../../src/cors.js';
import type { AppEnv } from '../../src/auth/principal.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { AttachmentRepo } from '../../src/repos/attachment-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { ScheduleRepo } from '../../src/repos/schedule-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { WorkspaceRegistryBackfiller } from '../../src/runtime/workspace-registry-backfill.js';
import { createApiRouter, createInternalRouter } from '../../src/routes.js';
import type { AgentRuntimeHost } from '../../src/runtime/agent-runtime-host.js';
import { AgentTokenStore } from '../../src/auth/agent-token-store.js';
import {
  DEFAULT_AUTH_SESSION_TTL_MS,
  type AuthRuntimeConfig,
} from '../../src/auth/config.js';
import { createDisabledEmbeddedBootstrapState } from '../../src/auth/embedded-bootstrap.js';
import {
  Argon2idPasswordHasher,
  PasswordCredentialService,
  type Argon2idPasswordHashParams,
} from '../../src/auth/password.js';
import { AuthSessionService } from '../../src/auth/session.js';
import { AttachmentService } from '../../src/services/attachment-service.js';
import { AgentService } from '../../src/services/agent-service.js';
import { ChannelService } from '../../src/services/channel-service.js';
import { ConversationMessageService } from '../../src/services/conversation-message-service.js';
import { ScheduleService } from '../../src/services/schedule-service.js';
import { TaskService } from '../../src/services/task-service.js';
import { ThreadService } from '../../src/services/thread-service.js';
import { UserService } from '../../src/services/user-service.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { createLocalBlobFileStorage } from '../../src/storage/blob-file-storage.js';
import { createLogLevelControl } from '../../src/logger.js';
import { makeTempSilverhandDir, openTestDb } from './db.js';
import { RuntimeHostPlacementResolver } from '../../src/runtime/host-placement.js';
import type { HostWsServerController } from '../../src/ws/host-ws-server.js';
import type {
  OutboundServerCommandKind,
  OutboundServerCommandParams,
  OutboundServerCommandResult,
} from '@silverhand/host';
import { ensureAgentL1Dir, initWorkspaceDir } from '../../src/workspace-files.js';
import { join as joinPath } from 'node:path';

/**
 * Records every call routes / provision make into the runtime host.
 * Routes use `.start`, `.stop`, `.deliverMessage`, `.stopAll`,
 * `.reconcileOnBoot`, `.isRunning` — none of which can be allowed to
 * spawn real CLIs in tests. (Class name kept for diff readability;
 * the type cast is to `AgentRuntimeHost` post-Commit B.)
 */
export class FakeConversationManager {
  starts: Array<{ conversationId: string; agentId: string }> = [];
  stops: Array<{
    conversationId: string;
    agentId: string;
    mode: 'soft' | 'hard';
    directive?: string;
  }> = [];
  clearedSessions: Array<{
    conversationId: string;
    agentId: string;
    actorUserId: string | null;
  }> = [];
  delivered: Array<{ conversationId: string; agentId: string; messageId: string }> = [];
  agentRunStates: AgentRunState[] = [];
  resolvedRuns: Array<{
    conversationId: string;
    agentId: string;
    reason: AgentRunTerminalReason;
    runId?: string;
  }> = [];
  resolvedConversations: Array<{ conversationId: string; reason: AgentRunTerminalReason }> = [];
  logDebugSyncs: Array<{
    conversationId: string;
    enabled: boolean;
    expiresAt: number | null;
  }> = [];
  stoppedAll = 0;
  reconciled = 0;

  /** Override to make `.start` reject. */
  startError: Error | null = null;
  /**
   * D4.d D3 round-1 P1.4 — inject a thrown error from
   * `deliverMessage` to exercise the route's post-commit
   * best-effort path (the `await runtimeHost.deliverMessage(...)`
   * call must catch+log and NOT turn the HTTP response into 5xx).
   */
  deliverError: Error | null = null;
  /**
   * D4.c C7 — inject a thrown error from `clearSession`. Unit tests
   * cover the route's typed-error mapping (`ClearSessionExitTimeoutError`
   * → 503 `clear_session_timeout`, `ClearSessionInProgressError` →
   * 409 `clear_session_in_progress`, `HostWsCommandTransportError` →
   * 503 `host_attach_pending`) without standing up a real fanout +
   * outbound transport.
   */
  clearError: Error | null = null;
  clearSessionResult = { prevCliSessionId: 'prev-session-1', wasRunning: false };

  reconcileOnBoot(): void {
    this.reconciled++;
  }
  isRunning(): boolean {
    return false;
  }
  getAgentRunStates(conversationId: string): AgentRunState[] {
    return this.agentRunStates.filter(s => s.conversationId === conversationId);
  }
  resolveRun(
    conversationId: string,
    agentId: string,
    reason: AgentRunTerminalReason,
    runId?: string,
  ): void {
    this.resolvedRuns.push({ conversationId, agentId, reason, runId });
  }
  resolveConversationRuns(
    conversationId: string,
    reason: AgentRunTerminalReason = 'conversation_closed',
  ): void {
    this.resolvedConversations.push({ conversationId, reason });
  }
  async start(conversationId: string, agentId: string): Promise<void> {
    if (this.startError) throw this.startError;
    this.starts.push({ conversationId, agentId });
  }
  async stop(
    conversationId: string,
    agentId: string,
    mode: 'soft' | 'hard' = 'hard',
    directive?: string,
  ): Promise<void> {
    this.stops.push({ conversationId, agentId, mode, directive });
  }
  async clearSession(
    conversationId: string,
    agentId: string,
    actorUserId: string | null = null,
  ): Promise<{ prevCliSessionId: string | null; wasRunning: boolean }> {
    if (this.clearError) throw this.clearError;
    this.clearedSessions.push({ conversationId, agentId, actorUserId });
    return this.clearSessionResult;
  }
  async stopAll(): Promise<void> {
    this.stoppedAll++;
  }
  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    if (this.deliverError) throw this.deliverError;
    this.delivered.push({ conversationId, agentId, messageId });
  }
  async setConversationLogDebug(
    conversationId: string,
    enabled: boolean,
    expiresAt?: number | null,
  ): Promise<void> {
    this.logDebugSyncs.push({
      conversationId,
      enabled,
      expiresAt: expiresAt ?? null,
    });
  }
}

/**
 * D4.d D3 — default in-process fake for `HostWsServerController`.
 *
 * The new `POST /api/agents` route is deployment-agnostic: it always
 * dispatches `agent_materialize` via `ctx.hostWsController?.()`. Pre-D3
 * tests posted to `/api/agents` without ever standing up an outbound
 * transport, and would now fall through to the 503 `host_attach_pending`
 * "no controller installed" branch. To keep legacy tests creating agents
 * working without per-file scaffolding, `buildTestApp` installs this
 * fake by default whenever `options.hostWsController` is unset.
 *
 * Behavior:
 *   - `agent_materialize` auto-acks with
 *     `{ ok: true, agent_dir, agent_home_workspace_path, materialized_at }`
 *     where `agent_dir === agent_home_workspace_path` (§6.5 invariant).
 *     The path matches what a real local daemon would produce —
 *     `<silverhandDir>/agents/<agentId>` — so downstream code that
 *     records the path on `workspaces.workspace_path` stays
 *     consistent with `AgentSystemPromptMemory` conventions.
 *   - Every other command kind returns `{}` (typed-erased) so the
 *     class can be passed wherever the controller interface is
 *     needed without per-kind branches.
 *   - Tests can opt out by passing an explicit factory (including
 *     `() => null` to exercise the "no controller" path) or by
 *     swapping in their own implementation.
 *   - Tests that need to inject typed/transport errors can either
 *     set `sendCommandError` on this instance or supply a custom
 *     controller via `BuildTestAppOptions.hostWsController`.
 */
export class FakeHostWsServerController implements HostWsServerController {
  calls: Array<{
    hostId: string;
    kind: OutboundServerCommandKind;
    params: Record<string, unknown>;
  }> = [];
  /** Inject an error from `sendCommand` (any kind). */
  sendCommandError: Error | null = null;
  /**
   * Override the `agent_materialize` ack body. Tests that want to
   * exercise the `agent_dir !== agent_home_workspace_path` skew or
   * a different path can swap this.
   */
  agentMaterializeAckOverride:
    | ((
        agentId: string,
        agentHomeWorkspaceId: string,
      ) => OutboundServerCommandResult<'agent_materialize'>)
    | null = null;
  /**
   * D4.e-1 3b — override the `workspace_provision` ack. Tests that want to
   * exercise a specific `bound_workspace_path`, a provisioned=false
   * idempotent re-bind, or skip skeleton creation can swap this.
   */
  workspaceProvisionAckOverride:
    | ((
        params: OutboundServerCommandParams<'workspace_provision'>,
      ) => OutboundServerCommandResult<'workspace_provision'>)
    | null = null;
  /**
   * D4.e-1 3b — override the `agent_workspace_index` ack. Tests that want to
   * exercise `unresolved` (read fail-closed) or a specific daemon-stamped
   * `agent_dir` set can swap this. Default stamps every requested id.
   */
  agentWorkspaceIndexAckOverride:
    | ((
        params: OutboundServerCommandParams<'agent_workspace_index'>,
      ) => OutboundServerCommandResult<'agent_workspace_index'>)
    | null = null;

  /**
   * D4.e-1 3b P2 (Cindy) — a tiny in-memory stand-in for the daemon
   * registry: `workspace_provision` records `workspace_id → bound path`, and
   * `agent_workspace_index` resolves regular ids from it (missing → an
   * `unresolved` entry, like a never-provisioned id). This makes list tests
   * actually depend on backfill/provision having run with the right
   * `requested_path` instead of the fake always succeeding.
   */
  private readonly boundWorkspacePaths = new Map<string, string>();

  constructor(private readonly silverhandDir: string) {}

  activeConnectionCount(): number {
    return 1;
  }
  connectedHostIds(): string[] {
    return ['local'];
  }
  connectionIdForHost(_hostId: string): string | null {
    return 'conn-fake-1';
  }
  getAttachment(): null {
    return null;
  }
  async sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
  ): Promise<OutboundServerCommandResult<K>> {
    this.calls.push({
      hostId,
      kind,
      params: params as Record<string, unknown>,
    });
    if (this.sendCommandError) throw this.sendCommandError;
    if (kind === 'agent_materialize') {
      const p = params as OutboundServerCommandParams<'agent_materialize'>;
      if (this.agentMaterializeAckOverride) {
        return this.agentMaterializeAckOverride(
          p.agent_id,
          p.agent_home_workspace_id,
        ) as OutboundServerCommandResult<K>;
      }
      const dir = joinPath(this.silverhandDir, 'agents', p.agent_id);
      // Seed the agent's L1 home with the embedded backend's
      // semantic clone of the daemon's template (per
      // `docs/agent-system-prompt-memory.md`). Backend routes that
      // read these files (e.g. `GET /api/agents/:id/workspace`)
      // can then see the expected shape without per-test
      // scaffolding. `ensureAgentL1Dir` is idempotent — same-key
      // retries reuse the existing files.
      //
      // The dependency-guard tripwire forbids backend code from
      // importing the daemon's `agent-materialize/template.ts`
      // directly. The clone in `workspace-files.ts` is allowed by
      // design; this fake uses it for the same reason.
      await ensureAgentL1Dir(dir);
      return {
        ok: true as const,
        agent_dir: dir,
        agent_home_workspace_path: dir,
        materialized_at: Date.now(),
      } as OutboundServerCommandResult<K>;
    }
    if (kind === 'workspace_provision') {
      const p = params as OutboundServerCommandParams<'workspace_provision'>;
      if (this.workspaceProvisionAckOverride) {
        const ack = this.workspaceProvisionAckOverride(p);
        // Keep the in-memory registry consistent even when a test customizes
        // the ack: `agent_workspace_index` resolves regular ids from this map,
        // so a custom `bound_workspace_path` MUST be recorded too — otherwise
        // the override would ack a bind the fake registry never saw, and a
        // follow-up list would spuriously report the id `unresolved`. A test
        // that specifically wants "ack'd but registry empty" should drive that
        // explicitly via `agentWorkspaceIndexAckOverride` → unresolved.
        if (ack.ok) {
          this.boundWorkspacePaths.set(p.workspace_id, ack.bound_workspace_path);
        }
        return ack as OutboundServerCommandResult<K>;
      }
      // Mirror the real daemon: bind to the caller-proposed path when
      // present, else a deterministic managed default under silverhandDir,
      // and create the `.silverhand/` skeleton so backend code that still
      // reads the cached `workspace_path` (seed/channel) sees a real dir.
      // The embedded test fs is shared, so this stands in for the daemon's
      // `initWorkspaceSkeleton`.
      const boundPath =
        p.requested_path ??
        joinPath(this.silverhandDir, 'workspaces', p.workspace_id);
      await initWorkspaceDir(boundPath);
      // Record the bind so `agent_workspace_index` resolves this id to the
      // SAME path (mirrors the daemon registry; honours custom requested_path).
      this.boundWorkspacePaths.set(p.workspace_id, boundPath);
      return {
        ok: true as const,
        provisioned: true,
        bound_workspace_path: boundPath,
      } as OutboundServerCommandResult<K>;
    }
    if (kind === 'agent_workspace_index') {
      const p = params as OutboundServerCommandParams<'agent_workspace_index'>;
      if (this.agentWorkspaceIndexAckOverride) {
        return this.agentWorkspaceIndexAckOverride(
          p,
        ) as OutboundServerCommandResult<K>;
      }
      // Default: resolve each requested id the way the real daemon would —
      // agent_home (`wsah_<agent_id>`) from the homedir convention, regular
      // from the recorded registry bind (`workspace_provision`). A regular id
      // with NO recorded bind is `unresolved` (read fail-closed), so list
      // tests must drive backfill/provision rather than relying on the fake
      // to always succeed.
      const entries: { workspace_id: string; agent_dir: string }[] = [];
      const unresolved: string[] = [];
      for (const workspace_id of p.workspace_ids) {
        if (isAgentHomeWorkspaceId(workspace_id, p.agent_id)) {
          entries.push({
            workspace_id,
            agent_dir: joinPath(this.silverhandDir, 'agents', p.agent_id),
          });
          continue;
        }
        const boundPath = this.boundWorkspacePaths.get(workspace_id);
        if (!boundPath) {
          unresolved.push(workspace_id);
          continue;
        }
        entries.push({
          workspace_id,
          agent_dir: joinPath(boundPath, '.silverhand', 'agents', p.agent_id),
        });
      }
      return {
        ok: true as const,
        entries,
        unresolved,
      } as OutboundServerCommandResult<K>;
    }
    return {} as OutboundServerCommandResult<K>;
  }
  disconnectHost(_hostId: string): boolean {
    return false;
  }
  async close(): Promise<void> {
    // no-op
  }
}

const silentLogger: BackendLogger = {
  info() {},
  warn() {},
  error() {},
};

const TEST_PASSWORD_HASH_PARAMS: Argon2idPasswordHashParams = {
  algorithm: 'argon2id',
  library: '@node-rs/argon2',
  version: '0x13',
  memoryCostKiB: 64,
  timeCost: 1,
  parallelism: 1,
  outputLen: 16,
  benchmark: {
    targetMs: 1,
    measuredMs: 1,
    candidateCount: 1,
    selectedAt: 1,
    cpuCount: 1,
    totalMemoryMiB: 1,
  },
};

const TEST_FIXTURE_USER_IDS = [
  'local',
  'alice',
  'bob',
  'carol',
  'teammate',
  'other',
  'someone',
  'someone-else',
];

export interface BuildTestAppOptions {
  authConfig?: Partial<AuthRuntimeConfig>;
  ownedLocalHostUserIds?: string[];
  deploymentMode?: BackendDeploymentMode;
  hostWsController?: () => HostWsServerController | null;
  /**
   * D4.a Commit 4 — override the bind-address classification for
   * `/api/server/info` and any route that reads it. Defaults to
   * `'loopback'` because the test app does not actually bind a
   * socket; production callers compute this at boot from the
   * resolved `SILVERHAND_LISTEN` value via `classifyBindAddressScope`.
   */
  bindAddressScope?: BindAddressScope;
}

export interface TestApp {
  app: Hono<AppEnv>;
  ctx: BackendContext;
  fake: FakeConversationManager;
  /**
   * The default in-process fake host controller installed when
   * `BuildTestAppOptions.hostWsController` is unset. Tests that pass
   * their own controller factory get `null` here.
   */
  fakeHostWs: FakeHostWsServerController | null;
  authToken: string;
  legacyServerAuthToken: string;
  /** The resolved viewer id for this test fixture. Always `'local'` —
   *  see `openTestDb` for the test fixture registered users. */
  viewerUserId: string;
  cleanup: () => void;
}

/**
 * Build a Hono app + BackendContext suitable for in-process testing
 * (`app.fetch(req)`). No port is opened. The runtime host is a fake —
 * the real one would try to spawn agent CLI subprocesses on every
 * channel provision, which we don't want in unit tests.
 */
export function buildTestApp(options: BuildTestAppOptions = {}): TestApp {
  const { db, viewerUserId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  // The real `startBackend` mkdirs workspacesRoot before mounting routes.
  mkdirSync(tmp.workspacesRoot, { recursive: true });

  const fake = new FakeConversationManager();
  // D4.d D3 — default fake outbound controller. If the test supplies
  // its own factory, we honor it verbatim (including `() => null` for
  // the "no controller installed" path). Otherwise install a fake that
  // auto-acks `agent_materialize` so legacy agent-creating tests stay
  // on the happy path without per-file scaffolding.
  const fakeHostWs = options.hostWsController
    ? null
    : new FakeHostWsServerController(tmp.silverhandDir);
  const hostWsControllerFactory: () => HostWsServerController | null =
    options.hostWsController ?? (() => fakeHostWs);
  const legacyServerAuthToken = 'a'.repeat(32);
  const deploymentMode = options.deploymentMode ?? 'embedded';
  const serverConfig: ServerConfig = {
    mode: deploymentMode === 'standalone' ? 'remote' : 'embedded',
    url: 'http://127.0.0.1:0',
    auth_token: legacyServerAuthToken,
    refresh_token: null,
    child_sessions: {
      max_concurrent_per_parent: null,
      spawn_cooldown_seconds: null,
      max_depth: 1,
    },
  };
  const authConfig: AuthRuntimeConfig = Object.freeze({
    signupEnabled: options.authConfig?.signupEnabled ?? true,
    sessionTtlMs:
      options.authConfig?.sessionTtlMs ?? DEFAULT_AUTH_SESSION_TTL_MS,
  });

  const blobStorage = createLocalBlobFileStorage({ silverhandDir: tmp.silverhandDir });
  const attachmentService = new AttachmentService({
    storage: blobStorage,
    attachments: new AttachmentRepo(db),
    conversations: new ConversationRepo(db),
  });
  const userService = new UserService({
    db,
    users: new UserRepo(db),
    blobStorage,
  });
  const agentService = new AgentService({
    agents: new AgentRepo(db),
    blobStorage,
  });
  const passwordCredentials = new PasswordCredentialService(
    db,
    new Argon2idPasswordHasher({
      paramsProvider: async () => TEST_PASSWORD_HASH_PARAMS,
      dummyPassword: 'test-dummy-password',
    }),
  );
  const placement = new RuntimeHostPlacementResolver({
    hosts: new HostRepo(db),
    agents: new AgentRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot }),
  });

  const ctx: BackendContext = {
    db,
    deploymentMode,
    readiness: {
      migrationsApplied: true,
      listenReady: true,
      // Tests default to "fanout already installed" so readiness
      // probes pass for both embedded and standalone fixtures. Tests
      // that exercise the standalone fail-loud gate flip this to
      // `false` explicitly via direct ctx mutation.
      outboundEventFanoutInstalled: true,
    },
    serverConfig,
    bindAddressScope: options.bindAddressScope ?? 'loopback',
    authConfig,
    embeddedBootstrap: createDisabledEmbeddedBootstrapState(tmp.silverhandDir),
    logger: silentLogger,
    loggers: { system: silentLogger, agent: silentLogger, cli: silentLogger },
    logControl: createLogLevelControl('warn'),
    silverhandDir: tmp.silverhandDir,
    workspacesRoot: tmp.workspacesRoot,
    blobStorage,
    attachmentService,
    agentService,
    userService,
    channelService: undefined as unknown as ChannelService,
    conversationMessageService: undefined as unknown as ConversationMessageService,
    threadService: undefined as unknown as ThreadService,
    taskService: undefined as unknown as TaskService,
    scheduleService: undefined as unknown as ScheduleService,
    lastSpawnAtByAgent: new Map(),
    events: new ScopeEventBus(),
    silverhandCliLauncher: { command: 'noop', args: [] },
    agentTokens: new AgentTokenStore(),
    passwordCredentials,
    authSessions: new AuthSessionService(db, {
      sessionTtlMs: authConfig.sessionTtlMs,
    }),
    placement,
    hostWsController: hostWsControllerFactory,
    // D5.a-3 — `POST /api/agents` materialize + retry dispatch through
    // `ctx.outboundFrameAdapter`, not `hostWsController`. In production the
    // standalone adapter wraps the same `hostWs` transport, so the test
    // fake host controller doubles as the outbound adapter here (it
    // satisfies the narrower `OutboundFrameAdapter` surface). Tests that
    // override `hostWsController` (incl. `() => null`) therefore also
    // steer the materialize path, preserving pre-D5.a semantics.
    outboundFrameAdapter: hostWsControllerFactory,
    runtimeHost: fake as unknown as AgentRuntimeHost,
  };
  // D4.e-1 3b-2/3b-3 — the same shared registry backfiller production wires,
  // so list_workspaces ensure()s before dispatching agent_workspace_index.
  ctx.workspaceRegistryBackfiller = new WorkspaceRegistryBackfiller({
    workspaces: new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot }),
    outboundFrameAdapter: () => ctx.outboundFrameAdapter?.() ?? null,
  });
  ctx.channelService = new ChannelService({
    db,
    conversations: new ConversationRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot }),
    agents: new AgentRepo(db),
    messages: new MessageRepo(db),
    events: ctx.events,
    runtimeHost: ctx.runtimeHost,
    logger: silentLogger,
  });
  ctx.conversationMessageService = new ConversationMessageService({
    db,
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    agents: new AgentRepo(db),
    users: new UserRepo(db),
    notifications: new NotificationRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot }),
    attachmentService,
    runtimeHost: ctx.runtimeHost,
    events: ctx.events,
    logger: silentLogger,
  });
  ctx.threadService = new ThreadService({
    db,
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    agents: new AgentRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot }),
    runtimeHost: ctx.runtimeHost,
    events: ctx.events,
    logger: silentLogger,
    serverConfig: () => ctx.serverConfig,
    lastSpawnAtByAgent: ctx.lastSpawnAtByAgent,
    taskService: () => ctx.taskService,
  });
  ctx.taskService = new TaskService({
    db,
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    agents: new AgentRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot }),
    runtimeHost: ctx.runtimeHost,
    events: ctx.events,
    logger: silentLogger,
  });
  ctx.scheduleService = new ScheduleService({
    schedules: new ScheduleRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot }),
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    agents: new AgentRepo(db),
    runtimeHost: ctx.runtimeHost,
    events: ctx.events,
    logger: silentLogger,
    disableAutoTick: true,
  });

  const hosts = new HostRepo(db);
  // Stage B.3 create routes require the current user to have an owned
  // local host, matching the desktop login claim path. Most route
  // tests use fixture users directly, so pre-claim their local hosts
  // here; host-claim/registration tests opt out when they need legacy
  // unclaimed-local state.
  for (const userId of options.ownedLocalHostUserIds ?? TEST_FIXTURE_USER_IDS) {
    hosts.claimOrCreateLocal({
      userId,
      installationId: `test-install-${userId}`,
    });
  }
  // D4.e-1 3b P1-2 — mirror prod: the embedded backend's co-located host is the
  // single `local`-named host (`ensureLocal`), which the `local` viewer claims
  // above. Standalone leaves it undefined (backend is remote).
  if (deploymentMode === 'embedded') {
    ctx.coLocatedHostId = hosts.ensureLocal().id;
  }

  const authToken = ctx.authSessions.issueSession({ userId: viewerUserId }).userToken;

  const app = new Hono<AppEnv>();
  app.use('*', silverhandCors());
  app.route('/', createApiRouter(ctx));
  app.route('/', createInternalRouter(ctx));

  return {
    app,
    ctx,
    fake,
    fakeHostWs,
    authToken,
    legacyServerAuthToken,
    viewerUserId,
    cleanup: () => {
      ctx.scheduleService.stop();
      try {
        db.close();
      } catch {}
      tmp.cleanup();
    },
  };
}

/** Convenience: GET/POST/DELETE wrappers around `app.fetch`.
 *  All bodies returned via `.json()` are typed `any` to keep tests terse;
 *  Response itself preserves status/headers. */
export interface HttpHelper {
  get(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  put(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  patch(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  del(path: string, init?: RequestInit): Promise<Response>;
  json<T = any>(res: Promise<Response> | Response): Promise<T>;
}

export function http(
  target: Hono<AppEnv> | TestApp,
  defaultHeaders: Record<string, string> = {},
): HttpHelper {
  const isTestApp = (value: unknown): value is TestApp =>
    typeof value === 'object' && value !== null && 'authToken' in value && 'app' in value;
  const app = isTestApp(target) ? target.app : target;
  const headers: Record<string, string> = { ...defaultHeaders };
  const base = 'http://localhost';
  const merge = (path: string, init?: RequestInit): RequestInit => {
    const mergedHeaders = {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (isTestApp(target)) {
      if (path.startsWith('/internal/')) {
        patchInternalAuthHeader(target, path, mergedHeaders);
      } else {
        ensurePublicSessionHeader(target, mergedHeaders);
      }
    }
    return {
      ...init,
      headers: mergedHeaders,
    };
  };
  const jsonReq = (
    path: string,
    method: 'POST' | 'PUT' | 'PATCH',
    body: unknown,
    init?: RequestInit,
  ) => {
    const mergedInit: RequestInit = {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    };
    // D4.d D3: `POST /api/agents` requires an `Idempotency-Key`
    // header (1..64, [A-Za-z0-9_-]) per §14 Q1. Pre-D3 tests
    // posted without one — auto-inject a per-request random key
    // so legacy test intent (single fresh attempt) stays valid.
    // Tests that exercise idempotency semantics explicitly should
    // pass their own Idempotency-Key in `init.headers`; the
    // request init merge below preserves user-supplied values.
    if (
      method === 'POST' &&
      (path === '/api/agents' || path.startsWith('/api/agents?'))
    ) {
      const existing = (mergedInit.headers as Record<string, string>) ?? {};
      const hasKey = Object.keys(existing).some(
        k => k.toLowerCase() === 'idempotency-key',
      );
      if (!hasKey) {
        mergedInit.headers = {
          ...existing,
          'Idempotency-Key': `t-${randomBytes(8).toString('base64url')}`,
        };
      }
    }
    return merge(path, mergedInit);
  };
  return {
    get: async (p, init) =>
      app.fetch(new Request(base + p, merge(p, { method: 'GET', ...init }))),
    post: async (p, body, init) =>
      app.fetch(new Request(base + p, jsonReq(p, 'POST', body, init))),
    put: async (p, body, init) =>
      app.fetch(new Request(base + p, jsonReq(p, 'PUT', body, init))),
    patch: async (p, body, init) =>
      app.fetch(new Request(base + p, jsonReq(p, 'PATCH', body, init))),
    del: async (p, init) =>
      app.fetch(new Request(base + p, merge(p, { method: 'DELETE', ...init }))),
    json: async <T = any>(res: Promise<Response> | Response): Promise<T> => {
      const r = await res;
      return r.json() as Promise<T>;
    },
  };
}

function patchInternalAuthHeader(
  target: TestApp,
  path: string,
  headers: Record<string, string>,
): void {
  const match = path.match(
    /^\/internal\/conversations\/([^/?#]+)\/agents\/([^/?#]+)(?:[/?#]|$)/,
  );
  if (!match) return;
  const current = headers.authorization ?? headers.Authorization;
  const publicBearer = `Bearer ${target.authToken}`;
  // Most route tests were written before internal tokens became scoped and
  // used the public bearer by default. Preserve their intent by translating
  // the default/public bearer to a valid per-agent token; explicit wrong
  // tokens remain wrong so auth tests still exercise rejection.
  if (current && current !== publicBearer) return;
  const [, conversationId, agentId] = match as [string, string, string];
  headers.authorization = `Bearer ${target.ctx.agentTokens.issue(
    decodeURIComponent(conversationId),
    decodeURIComponent(agentId),
  )}`;
}

function ensurePublicSessionHeader(
  target: TestApp,
  headers: Record<string, string>,
): void {
  if (headers.authorization || headers.Authorization) return;
  const userId = requestedPublicUserId(headers) ?? target.viewerUserId;
  if (userId === target.viewerUserId) {
    headers.authorization = `Bearer ${target.authToken}`;
    return;
  }
  headers.authorization = `Bearer ${target.ctx.authSessions.issueSession({ userId }).userToken}`;
}

function requestedPublicUserId(headers: Record<string, string>): string | null {
  const principal = headers[PRINCIPAL_HEADER]?.trim();
  if (principal) return decodeUserPrincipalHeader(principal);
  return headers[LEGACY_USER_ID_HEADER]?.trim() || null;
}
