import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { openDatabase } from './db.js';
import { createApiRouter, createInternalRouter } from './routes.js';
import {
  consoleLogger,
  type BackendContext,
  type BackendLogger,
  type ChatBridgeLauncher,
} from './context.js';
import { HostRepo } from './repos/host-repo.js';
import { ensureWorkspacesRoot } from './provision.js';
import { SessionEventBus } from './event-bus.js';
import { SessionManager } from './session-manager.js';
import type { ServerConfig } from '@silverhand/shared';

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
  await ensureWorkspacesRoot(workspacesRoot);

  // Fail loudly if the chat-bridge launcher is bogus. claude silently
  // continues without MCP tools when it can't spawn the server, which
  // makes every agent reply "invisible" (text only, no send_message).
  // Absolute path → check it exists. Bare name (e.g. `npx`) → resolve
  // through PATH; missing PATH binaries surface as ENOENT only when the
  // first agent spawns, which is too late.
  assertLauncherResolvable(opts.chatBridgeLauncher.command);

  // Bootstrap: ensure 'local' host exists.
  new HostRepo(db).ensureLocal();

  const ctx: BackendContext = {
    db,
    serverConfig: opts.serverConfig,
    logger,
    silverhandDir: opts.silverhandDir,
    workspacesRoot,
    logDir: opts.logDir,
    lastSpawnAtByAgent: new Map(),
    events: new SessionEventBus(),
    chatBridgeLauncher: opts.chatBridgeLauncher,
    // Placeholder; replaced immediately below (SessionManager needs ctx).
    sessionManager: undefined as unknown as SessionManager,
  };
  ctx.sessionManager = new SessionManager(ctx);
  ctx.sessionManager.reconcileOnBoot();

  const app = new Hono();
  app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }));
  app.route('/', createApiRouter(ctx));
  app.route('/', createInternalRouter(ctx));

  return new Promise<RunningBackend>((resolve, reject) => {
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
            // Phase 1: stop all agents (must finish before activity-log flush
            // so terminal events are written before the stream closes).
            await ctx.sessionManager.stopAll().catch(() => undefined);

            // Phase 2: flush activity log AND drain the HTTP server
            // concurrently — they are independent of each other.
            //
            // Order matters for the server drain:
            //   1. `server.close()` first — stops accepting new connections
            //      immediately, so a reconnecting EventSource can't sneak in.
            //   2. `closeAllConnections()` second — terminates all existing
            //      sockets (including SSE/EventSource long-lived streams)
            //      so `server.close()` resolves right away instead of waiting
            //      for the renderer to unmount.
            // The `in` guard handles the Http2Server union member which lacks
            // this method (we always use HTTP/1.1, but the type is a union).
            const serverDrained = new Promise<void>(res => server.close(() => res()));
            if ('closeAllConnections' in server) server.closeAllConnections();
            await Promise.allSettled([
              ctx.sessionManager.closeActivityLog(),
              serverDrained,
            ]);

            // Phase 3: close the DB. At this point all connections —
            // including in-flight HTTP requests — have been forcibly
            // terminated by closeAllConnections(). Strict in-flight write
            // safety is sacrificed for a clean quit; if that becomes a
            // concern, use SSE-specific tracking/abort before this point.
            db.close();
          },
        });
      },
    );
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
