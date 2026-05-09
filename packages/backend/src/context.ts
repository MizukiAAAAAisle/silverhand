import type { Database as Db } from 'better-sqlite3';
import type { ServerConfig } from '@silverhand/shared';
import type { ScopeEventBus } from './ws/scope-event-bus.js';
import type { ConversationManager } from './conversation-manager.js';
import type { AttachmentService } from './services/attachment-service.js';
import type { ChannelService } from './services/channel-service.js';
import type { ConversationMessageService } from './services/conversation-message-service.js';
import type { ScheduleService } from './services/schedule-service.js';
import type { TaskService } from './services/task-service.js';
import type { ThreadService } from './services/thread-service.js';
import type { BlobFileStorage } from './storage/blob-file-storage.js';

export interface BackendLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * How to invoke the chat-bridge MCP server. Concrete shape depends on
 * the host: in dev it's `tsx <repo>/packages/chat-bridge/src/cli.ts`;
 * in a packaged Electron build it's a node + bundled JS path. The host
 * supplies this when calling `startBackend`.
 *
 * ConversationManager appends `--conversation-id`, `--agent-id`, `--server-url`
 * arguments and the auth-token env var on top of these baseline args.
 * `env` is merged in alongside the auth token / log dir — used by the
 * Electron host to set `ELECTRON_RUN_AS_NODE=1` when `command` points
 * at the Electron binary in packaged builds.
 */
export interface ChatBridgeLauncher {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface BackendContext {
  db: Db;
  serverConfig: ServerConfig;
  logger: BackendLogger;
  /** Root for all silverhand state (`~/.silverhand`). */
  silverhandDir: string;
  /** `<silverhandDir>/workspaces/` — root for auto-generated channel workspaces. */
  workspacesRoot: string;
  /** Directory where the file logger writes; passed through to chat-bridge
   *  via `SILVERHAND_LOG_DIR` so spawned bridges land in the same place.
   *  Optional — undefined when no file logger is in use (e.g. in tests). */
  logDir?: string;
  /** Shared blob/file storage infra used by application layers like
   *  message attachments and future profile avatars. */
  blobStorage: BlobFileStorage;
  /** Application layer over `blobStorage` that knows about channels,
   *  threads, message snapshots, and access policy. */
  attachmentService: AttachmentService;
  /** Application layer that owns channel create / pin / unpin side effects. */
  channelService: ChannelService;
  /** Application layer that owns user/agent send-message side effects. */
  conversationMessageService: ConversationMessageService;
  /** Application layer that owns thread create / close side effects. */
  threadService: ThreadService;
  /** Application layer that owns task create / claim / unclaim / status side effects. */
  taskService: TaskService;
  /** Agent-owned cron-like scheduler. Owns its own setInterval/setTimeout
   *  lifecycle; `start()`/`stop()` bracket the backend process. */
  scheduleService: ScheduleService;
  /** Per-process state: last child-conversation spawn timestamp per agent (cooldown). */
  lastSpawnAtByAgent: Map<string, number>;
  /** In-process pub/sub for live UI updates. */
  events: ScopeEventBus;
  /** How to spawn the chat-bridge MCP server (host-supplied). */
  chatBridgeLauncher: ChatBridgeLauncher;
  /** Owns running agent CLI child processes. Initialized after the
   *  context object is built (circular dep otherwise). */
  conversationManager: ConversationManager;
}

export const consoleLogger: BackendLogger = {
  info: (obj, msg) => console.log('[backend]', msg ?? '', obj),
  warn: (obj, msg) => console.warn('[backend]', msg ?? '', obj),
  error: (obj, msg) => console.error('[backend]', msg ?? '', obj),
};
