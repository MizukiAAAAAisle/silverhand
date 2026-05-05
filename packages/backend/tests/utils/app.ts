import { Hono } from 'hono';
import { mkdirSync } from 'node:fs';
import type {
  AgentRunState,
  AgentRunTerminalReason,
  ServerConfig,
} from '@silverhand/shared';
import type { BackendContext, BackendLogger } from '../../src/context.js';
import { silverhandCors } from '../../src/cors.js';
import { ConversationEventBus } from '../../src/event-bus.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { createApiRouter, createInternalRouter } from '../../src/routes.js';
import type { ConversationManager } from '../../src/conversation-manager.js';
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
  app: Hono;
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

  const ctx: BackendContext = {
    db,
    serverConfig,
    logger: silentLogger,
    silverhandDir: tmp.silverhandDir,
    workspacesRoot: tmp.workspacesRoot,
    blobStorage: createLocalBlobFileStorage({ silverhandDir: tmp.silverhandDir }),
    lastSpawnAtByAgent: new Map(),
    events: new ConversationEventBus(),
    chatBridgeLauncher: { command: 'noop', args: [] },
    conversationManager: fake as unknown as ConversationManager,
  };

  // routes.ts calls hosts.ensureLocal() at construction; openTestDb() does
  // the same — this is a safety net if anyone changes the helper later.
  new HostRepo(db).ensureLocal();

  const app = new Hono();
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

export function http(app: Hono, defaultHeaders: Record<string, string> = {}): HttpHelper {
  const base = 'http://localhost';
  const merge = (init?: RequestInit): RequestInit => ({
    ...init,
    headers: { ...defaultHeaders, ...(init?.headers as Record<string, string> | undefined) },
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
