import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { silverhandCors } from './cors.js';
import { openDatabase } from './db.js';
import { createApiRouter, createInternalRouter } from './routes.js';
import type { AppEnv } from './auth/principal.js';
import {
  consoleLogger,
  type BackendContext,
  type BackendLogger,
  type ChatBridgeLauncher,
} from './context.js';
import { HostRepo } from './repos/host-repo.js';
import { ensureWorkspacesRoot } from './provision.js';
import { ScopeEventBus } from './ws/scope-event-bus.js';
import {
  installEventWebSocketServer,
  type EventWsServerController,
} from './ws/ws-server.js';
import { ConversationManager } from './conversation-manager.js';
import { AgentRepo } from './repos/agent-repo.js';
import { AttachmentRepo } from './repos/attachment-repo.js';
import { ConversationRepo } from './repos/conversation-repo.js';
import { MessageRepo } from './repos/message-repo.js';
import { NotificationRepo } from './repos/notification-repo.js';
import { WorkspaceRepo } from './repos/workspace-repo.js';
import { AttachmentService } from './services/attachment-service.js';
import { ChannelService } from './services/channel-service.js';
import { ConversationMessageService } from './services/conversation-message-service.js';
import { ThreadService } from './services/thread-service.js';
import { TaskService } from './services/task-service.js';
import { createLocalBlobFileStorage } from './storage/blob-file-storage.js';
import type { ServerConfig } from '@silverhand/shared';
import type { Server as HttpServer } from 'node:http';

export interface CreateBackendOptions {
  dbPath: string;
  silverhandDir: string;
  serverConfig: ServerConfig;
  chatBridgeLauncher: ChatBridgeLauncher;
  logger?: BackendLogger;
  /** Where the file logger writes — passed through to chat-bridge child
   *  processes via `SILVERHAND_LOG_DIR`. Optional. */
  logDir?: string;
}

export interface RunningBackend {
  url: string;
  port: number;
  context: BackendContext;
  close(): Promise<void>;
}

export async function startBackend(opts: CreateBackendOptions): Promise<RunningBackend> {
  const logger = opts.logger ?? consoleLogger;
  const db = openDatabase(opts.dbPath);
  const workspacesRoot = join(opts.silverhandDir, 'workspaces');
  const blobStorage = createLocalBlobFileStorage({ silverhandDir: opts.silverhandDir });
  await ensureWorkspacesRoot(workspacesRoot);
  await blobStorage.ensureReady();

  // Fail loudly if the chat-bridge launcher is bogus. claude silently
  // continues without MCP tools when it can't spawn the server, which
  // makes every agent reply "invisible" (text only, no send_message).
  // Absolute path → check it exists. Bare name (e.g. `npx`) → resolve
  // through PATH; missing PATH binaries surface as ENOENT only when the
  // first agent spawns, which is too late.
  assertLauncherResolvable(opts.chatBridgeLauncher.command);

  // Bootstrap: ensure 'local' host exists.
  new HostRepo(db).ensureLocal();

  const attachmentService = new AttachmentService({
    storage: blobStorage,
    attachments: new AttachmentRepo(db),
    conversations: new ConversationRepo(db),
  });

  const ctx: BackendContext = {
    db,
    serverConfig: opts.serverConfig,
    logger,
    silverhandDir: opts.silverhandDir,
    workspacesRoot,
    logDir: opts.logDir,
    blobStorage,
    attachmentService,
    channelService: undefined as unknown as ChannelService,
    conversationMessageService: undefined as unknown as ConversationMessageService,
    threadService: undefined as unknown as ThreadService,
    taskService: undefined as unknown as TaskService,
    lastSpawnAtByAgent: new Map(),
    events: new ScopeEventBus(),
    chatBridgeLauncher: opts.chatBridgeLauncher,
    // Placeholder; replaced immediately below (ConversationManager needs ctx).
    conversationManager: undefined as unknown as ConversationManager,
  };
  ctx.conversationManager = new ConversationManager(ctx);
  ctx.channelService = new ChannelService({
    db,
    conversations: new ConversationRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot }),
    agents: new AgentRepo(db),
    messages: new MessageRepo(db),
    events: ctx.events,
    conversationManager: ctx.conversationManager,
    logger,
  });
  ctx.conversationMessageService = new ConversationMessageService({
    db,
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    agents: new AgentRepo(db),
    notifications: new NotificationRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot }),
    attachmentService,
    conversationManager: ctx.conversationManager,
    events: ctx.events,
    logger,
  });
  ctx.threadService = new ThreadService({
    db,
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    agents: new AgentRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot }),
    conversationManager: ctx.conversationManager,
    events: ctx.events,
    logger,
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
    logger,
  });
  ctx.conversationManager.reconcileOnBoot();
  const stopEventLoopLagProbe = startEventLoopLagProbe(logger);

  const app = new Hono<AppEnv>();
  app.use('*', silverhandCors());
  app.route('/', createApiRouter(ctx));
  app.route('/', createInternalRouter(ctx));

  return new Promise<RunningBackend>((resolve, reject) => {
    let eventWs: EventWsServerController | null = null;
    const server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      info => {
        const address = info as AddressInfo;
        const port = address.port;
        const url = `http://127.0.0.1:${port}`;
        ctx.serverConfig = { ...opts.serverConfig, url };
        logger.info({ url }, 'backend listening');
        resolve({
          url,
          port,
          context: ctx,
          close: async () => {
            stopEventLoopLagProbe();
            // Phase 1: stop all agents (must finish before activity-log flush
            // so terminal events are written before the stream closes).
            await ctx.conversationManager.stopAll().catch(() => undefined);

            // Phase 2: close WS lifecycle before the HTTP drain removes sockets.
            await eventWs?.close();

            // Phase 3: flush activity log AND drain the HTTP server
            // concurrently — they are independent of each other.
            //
            // Order matters for the server drain:
            //   1. `server.close()` first — stops accepting new connections
            //      immediately, so no new HTTP work can sneak in.
            //   2. `closeAllConnections()` second — terminates all existing
            //      sockets so `server.close()` resolves right away.
            // The `in` guard handles the Http2Server union member which lacks
            // this method (we always use HTTP/1.1, but the type is a union).
            const serverDrained = new Promise<void>(res => server.close(() => res()));
            if ('closeAllConnections' in server) server.closeAllConnections();
            await Promise.allSettled([
              ctx.conversationManager.closeActivityLog(),
              serverDrained,
            ]);

            // Phase 4: close the DB. At this point all connections —
            // including in-flight HTTP requests — have been forcibly
            // terminated by closeAllConnections(). Strict in-flight write
            // safety is sacrificed for a clean quit; if that becomes a
            // concern, use route-specific request tracking before this point.
            db.close();
          },
        });
      },
    );
    eventWs = installEventWebSocketServer(server as HttpServer, ctx);
    server.on('error', reject);
  });
}

export type { BackendContext, BackendLogger } from './context.js';
export { createFileLogger, type FileLogger, type FileLoggerOptions } from './logger.js';

function assertLauncherResolvable(command: string): void {
  if (isAbsolute(command)) {
    if (!existsSync(command)) {
      throw new Error(
        `chat-bridge launcher not found: ${command}. ` +
          `Without it claude can't spawn the MCP server and agents won't be able to reply.`,
      );
    }
    return;
  }
  // Bare name — probe PATH. `command -v` is POSIX shell syntax, so use
  // `which` on Unix and `where` on Windows. We avoid spawning a shell
  // (no PATH-injection vector); execFileSync throws on non-zero exit.
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(probe, [command], { stdio: 'ignore' });
  } catch {
    throw new Error(
      `chat-bridge launcher \`${command}\` is not on PATH. ` +
        `Without it claude can't spawn the MCP server and agents won't be able to reply.`,
    );
  }
}

const EVENT_LOOP_LAG_INTERVAL_MS = 500;
const EVENT_LOOP_LAG_WARN_MS = 250;

function startEventLoopLagProbe(logger: BackendLogger): () => void {
  let expectedAt = performance.now() + EVENT_LOOP_LAG_INTERVAL_MS;
  const timer = setInterval(() => {
    const now = performance.now();
    const lagMs = now - expectedAt;
    expectedAt = now + EVENT_LOOP_LAG_INTERVAL_MS;
    if (lagMs >= EVENT_LOOP_LAG_WARN_MS) {
      logger.warn(
        {
          lagMs: roundMs(lagMs),
          intervalMs: EVENT_LOOP_LAG_INTERVAL_MS,
          thresholdMs: EVENT_LOOP_LAG_WARN_MS,
        },
        'backend: event loop lag detected',
      );
    }
  }, EVENT_LOOP_LAG_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}
