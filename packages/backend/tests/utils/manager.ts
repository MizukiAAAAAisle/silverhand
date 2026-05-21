import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from '@silverhand/shared';
import type { BackendContext, BackendLogger } from '../../src/context.js';
import { AgentTokenStore } from '../../src/auth/agent-token-store.js';
import { ScopeEventBus, type ConversationBusEvent } from '../../src/ws/scope-event-bus.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { AttachmentRepo } from '../../src/repos/attachment-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { ScheduleRepo } from '../../src/repos/schedule-repo.js';
import { SettingsRepo } from '../../src/repos/settings-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationManager } from '../../src/conversation-manager.js';
import { AttachmentService } from '../../src/services/attachment-service.js';
import { AgentService } from '../../src/services/agent-service.js';
import { ChannelService } from '../../src/services/channel-service.js';
import { ConversationMessageService } from '../../src/services/conversation-message-service.js';
import { ScheduleService } from '../../src/services/schedule-service.js';
import { ThreadService } from '../../src/services/thread-service.js';
import { TaskService } from '../../src/services/task-service.js';
import { UserService } from '../../src/services/user-service.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { initWorkspaceDir } from '../../src/workspace-files.js';
import { createLocalBlobFileStorage } from '../../src/storage/blob-file-storage.js';
import { makeTempSilverhandDir, openTestDb } from './db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MOCK_CLAUDE_PATH = join(HERE, 'mock-claude.mjs');

export interface MockClaudeEnvOverrides {
  MOCK_CLAUDE_INIT_SESSION_ID?: string;
  MOCK_CLAUDE_INIT_DELAY_MS?: string;
  MOCK_CLAUDE_NO_INIT?: '1';
  MOCK_CLAUDE_EXIT_CODE?: string;
  MOCK_CLAUDE_EXIT_AFTER_INIT_MS?: string;
  MOCK_CLAUDE_EMIT_TURN_END?: '1';
  MOCK_CLAUDE_PROTOCOL_EVENT_DELAY_MS?: string;
  MOCK_CLAUDE_STDERR_INTERVAL_MS?: string;
  MOCK_CLAUDE_FAIL_FIRST_INITS?: string;
  MOCK_CLAUDE_SPAWN_COUNT_FILE?: string;
  MOCK_CLAUDE_STDIN_LOG?: string;
  MOCK_CLAUDE_ARGV_LOG?: string;
  MOCK_CLAUDE_IGNORE_INTERRUPT?: '1';
  MOCK_CLAUDE_ENV_LOG?: string;
}

const silentLogger: BackendLogger = {
  info() {},
  warn() {},
  error() {},
};

export interface ManagerHarness {
  ctx: BackendContext;
  manager: ConversationManager;
  silverhandDir: string;
  workspacePath: string;
  channelId: string;
  agentId: string;
  sessionId: string;
  /** Path the mock-claude appends every received stdin line to. */
  stdinLog: string;
  /** Subscribe to all realtime events for the session. */
  on(handler: (e: ConversationBusEvent) => void): () => void;
  /** Wait until `predicate(events)` returns truthy, or reject after `timeoutMs`. */
  waitForEvent(
    predicate: (e: ConversationBusEvent) => boolean,
    timeoutMs?: number,
  ): Promise<ConversationBusEvent>;
  /** Mutate the env that the next mock-claude spawn will inherit. */
  setMockEnv(overrides: MockClaudeEnvOverrides): void;
  cleanup(): Promise<void>;
}

export interface BuildManagerHarnessOptions {
  /** If set, wired into ctx.logDir so the ConversationManager writes the
   *  dedicated agent-activity-*.log file. */
  logDir?: string;
}

/**
 * Build a real ConversationManager pointed at the mock-claude binary, with all
 * the surrounding fixtures (channel, agent, session) pre-created in an
 * in-memory DB. ConversationManager's `binariesPromise` is monkey-patched to
 * map runtime "claude" → MOCK_CLAUDE_PATH so it never calls `which claude`.
 */
export async function buildManagerHarness(opts: BuildManagerHarnessOptions = {}): Promise<ManagerHarness> {
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  mkdirSync(tmp.workspacesRoot, { recursive: true });

  // Workspace + channel conversation dir
  const workspaces = new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot });
  const workspacePath = workspaces.workspacePathFor('test-ch');
  await initWorkspaceDir(workspacePath);
  const workspace = workspaces.insert({
    name: 'test-ch',
    description: null,
    workspacePath,
    workspaceHostId: localHostId,
  });

  const agents = new AgentRepo(db);
  const agent = agents.create({ name: 'mock', runtime: 'claude' }, localHostId, 'local');
  workspaces.addMember(workspace.id, agent.id);

  const conversations = new ConversationRepo(db);
  const session = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath,
    title: 't',
  });
  conversations.addAgent(session.id, agent.id);

  // Per-test env overrides; we mutate this reference and the manager picks
  // it up because spawn() reads env at call time.
  const mockEnvOverrides: MockClaudeEnvOverrides = {
    MOCK_CLAUDE_INIT_DELAY_MS: '20',
    MOCK_CLAUDE_STDIN_LOG: join(tmp.silverhandDir, 'stdin.log'),
  };

  const serverConfig: ServerConfig = {
    mode: 'embedded',
    url: 'http://127.0.0.1:0',
    auth_token: 'a'.repeat(32),
    refresh_token: null,
    child_sessions: {
      max_concurrent_per_parent: null,
      spawn_cooldown_seconds: null,
      max_depth: 1,
    },
  };

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

  const ctx: BackendContext = {
    db,
    serverConfig,
    logger: silentLogger,
    loggers: { system: silentLogger, agent: silentLogger, cli: silentLogger },
    silverhandDir: tmp.silverhandDir,
    workspacesRoot: tmp.workspacesRoot,
    logDir: opts.logDir,
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
    silverhandCliLauncher: { command: 'true', args: [] },
    agentTokens: new AgentTokenStore(),
    runtimeHost: undefined as unknown as ConversationManager,
    conversationManager: undefined as unknown as ConversationManager,
  };
  // Bootstrap local host (matches what startBackend would do)
  new HostRepo(db).ensureLocal();

  const manager = new ConversationManager(ctx);
  ctx.conversationManager = manager;
  ctx.runtimeHost = manager;
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
  });
  ctx.taskService = new TaskService({
    db,
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    agents: new AgentRepo(db),
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
    settings: new SettingsRepo(db),
    runtimeHost: ctx.runtimeHost,
    events: ctx.events,
    logger: silentLogger,
    disableAutoTick: true,
  });

  // Inject mock binary so resolveBinary returns it without `which claude`.
  (manager as unknown as {
    binariesPromise: Promise<Map<string, string>>;
  }).binariesPromise = Promise.resolve(new Map([['claude', MOCK_CLAUDE_PATH]]));

  // Wrap process.spawn invocation indirectly: ConversationManager calls
  // driver.applyEnv(process.env) and then spawn(binary, args, { env }).
  // We can't intercept spawn, but we CAN inject MOCK_CLAUDE_* into
  // process.env before each start() call via setMockEnv.
  function applyMockEnv() {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('MOCK_CLAUDE_')) delete process.env[k];
    }
    for (const [k, v] of Object.entries(mockEnvOverrides)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
  applyMockEnv();

  // Event subscription helpers
  function on(handler: (e: ConversationBusEvent) => void): () => void {
    return ctx.events.subscribe(session.id, handler);
  }

  function waitForEvent(
    predicate: (e: ConversationBusEvent) => boolean,
    timeoutMs = 3000,
  ): Promise<ConversationBusEvent> {
    return new Promise((resolve, reject) => {
      const unsub = on(e => {
        if (predicate(e)) {
          clearTimeout(timer);
          unsub();
          resolve(e);
        }
      });
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`waitForEvent timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  return {
    ctx,
    manager,
    silverhandDir: tmp.silverhandDir,
    workspacePath,
    channelId: workspace.id,
    agentId: agent.id,
    sessionId: session.id,
    stdinLog: mockEnvOverrides.MOCK_CLAUDE_STDIN_LOG!,
    on,
    waitForEvent,
    setMockEnv: overrides => {
      Object.assign(mockEnvOverrides, overrides);
      applyMockEnv();
    },
    cleanup: async () => {
      ctx.scheduleService.stop();
      try {
        await manager.stopAll();
      } catch {}
      // give exit handlers a beat to flush
      await new Promise(r => setTimeout(r, 50));
      for (const k of Object.keys(process.env)) {
        if (k.startsWith('MOCK_CLAUDE_')) delete process.env[k];
      }
      try {
        db.close();
      } catch {}
      tmp.cleanup();
    },
  };
}

/** Read every stdin line the mock-claude received (one JSON line each). */
export async function readStdinLog(path: string): Promise<string[]> {
  const { promises: fs } = await import('node:fs');
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return raw.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
