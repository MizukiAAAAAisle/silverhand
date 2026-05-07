import { Hono } from 'hono';
import { mkdirSync } from 'node:fs';
import type {
  AgentRunState,
  AgentRunTerminalReason,
  ServerConfig,
} from '@silverhand/shared';
import type { BackendContext, BackendLogger } from '../../src/context.js';
import { silverhandCors } from '../../src/cors.js';
import type { AppEnv } from '../../src/auth/principal.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { AttachmentRepo } from '../../src/repos/attachment-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { createApiRouter, createInternalRouter } from '../../src/routes.js';
import type { ConversationManager } from '../../src/conversation-manager.js';
import { AttachmentService } from '../../src/services/attachment-service.js';
import { ChannelService } from '../../src/services/channel-service.js';
import { ConversationMessageService } from '../../src/services/conversation-message-service.js';
import { TaskService } from '../../src/services/task-service.js';
import { ThreadService } from '../../src/services/thread-service.js';
import { createLocalBlobFileStorage } from '../../src/storage/blob-file-storage.js';
import { makeTempSilverhandDir, openTestDb } from './db.js';

/**
 * Records every call routes / provision make into ConversationManager. Routes
 * use `.start`, `.stop`, `.deliverMessage`, `.stopAll`, `.reconcileOnBoot`,
 * `.isRunning` — none of which can be allowed to spawn real CLIs in tests.
 */
export class FakeConversationManager {
  starts: Array<{ conversationId: string; agentId: string }> = [];
  stops: Array<{
    conversationId: string;
    agentId: string;
    mode: 'soft' | 'hard';
    directive?: string;
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
  stoppedAll = 0;
  reconciled = 0;

  /** Override to make `.start` reject. */
  startError: Error | null = null;

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
  async stopAll(): Promise<void> {
    this.stoppedAll++;
  }
  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    this.delivered.push({ conversationId, agentId, messageId });
  }
}

const silentLogger: BackendLogger = {
  info() {},
  warn() {},
  error() {},
};

export interface TestApp {
  app: Hono<AppEnv>;
  ctx: BackendContext;
  fake: FakeConversationManager;
  authToken: string;
  cleanup: () => void;
}

/**
 * Build a Hono app + BackendContext suitable for in-process testing
 * (`app.fetch(req)`). No port is opened. ConversationManager is a fake — the
 * real one would try to spawn agent CLI subprocesses on every channel
 * provision, which we don't want in unit tests.
 */
export function buildTestApp(): TestApp {
  const { db } = openTestDb();
  const tmp = makeTempSilverhandDir();
  // The real `startBackend` mkdirs workspacesRoot before mounting routes.
  mkdirSync(tmp.workspacesRoot, { recursive: true });

  const fake = new FakeConversationManager();
  const authToken = 'a'.repeat(32);
  const serverConfig: ServerConfig = {
    mode: 'embedded',
    url: 'http://127.0.0.1:0',
    auth_token: authToken,
    user_id: null,
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

  const ctx: BackendContext = {
    db,
    serverConfig,
    logger: silentLogger,
    silverhandDir: tmp.silverhandDir,
    workspacesRoot: tmp.workspacesRoot,
    blobStorage,
    attachmentService,
    channelService: undefined as unknown as ChannelService,
    conversationMessageService: undefined as unknown as ConversationMessageService,
    threadService: undefined as unknown as ThreadService,
    taskService: undefined as unknown as TaskService,
    lastSpawnAtByAgent: new Map(),
    events: new ScopeEventBus(),
    chatBridgeLauncher: { command: 'noop', args: [] },
    conversationManager: fake as unknown as ConversationManager,
  };
  ctx.channelService = new ChannelService({
    db,
    conversations: new ConversationRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot }),
    agents: new AgentRepo(db),
    messages: new MessageRepo(db),
    events: ctx.events,
    conversationManager: ctx.conversationManager,
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
    conversationManager: ctx.conversationManager,
    events: ctx.events,
    logger: silentLogger,
  });
  ctx.threadService = new ThreadService({
    db,
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    agents: new AgentRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot }),
    conversationManager: ctx.conversationManager,
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
    conversationManager: ctx.conversationManager,
    events: ctx.events,
    logger: silentLogger,
  });

  // routes.ts calls hosts.ensureLocal() at construction; openTestDb() does
  // the same — this is a safety net if anyone changes the helper later.
  new HostRepo(db).ensureLocal();

  const app = new Hono<AppEnv>();
  app.use('*', silverhandCors());
  app.route('/', createApiRouter(ctx));
  app.route('/', createInternalRouter(ctx));

  return {
    app,
    ctx,
    fake,
    authToken,
    cleanup: () => {
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
  const headers: Record<string, string> = isTestApp(target)
    ? { authorization: `Bearer ${target.authToken}`, ...defaultHeaders }
    : { ...defaultHeaders };
  const base = 'http://localhost';
  const merge = (init?: RequestInit): RequestInit => ({
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  const jsonReq = (method: 'POST' | 'PATCH', body: unknown, init?: RequestInit) =>
    merge({
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
  return {
    get: async (p, init) =>
      app.fetch(new Request(base + p, merge({ method: 'GET', ...init }))),
    post: async (p, body, init) =>
      app.fetch(new Request(base + p, jsonReq('POST', body, init))),
    patch: async (p, body, init) =>
      app.fetch(new Request(base + p, jsonReq('PATCH', body, init))),
    del: async (p, init) =>
      app.fetch(new Request(base + p, merge({ method: 'DELETE', ...init }))),
    json: async <T = any>(res: Promise<Response> | Response): Promise<T> => {
      const r = await res;
      return r.json() as Promise<T>;
    },
  };
}
