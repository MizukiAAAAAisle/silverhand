import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from '@silverhand/shared';
import type { BackendContext, BackendLogger } from '../../src/context.js';
import { SessionEventBus, type SessionBusEvent } from '../../src/event-bus.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ChannelRepo } from '../../src/repos/channel-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { SessionRepo } from '../../src/repos/session-repo.js';
import { SessionManager } from '../../src/session-manager.js';
import { initWorkspaceDir } from '../../src/repos/channel-repo.js';
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
  MOCK_CLAUDE_STDIN_LOG?: string;
}

const silentLogger: BackendLogger = {
  info() {},
  warn() {},
  error() {},
};

export interface ManagerHarness {
  ctx: BackendContext;
  manager: SessionManager;
  silverhandDir: string;
  workspacePath: string;
  channelId: string;
  agentId: string;
  sessionId: string;
  /** Path the mock-claude appends every received stdin line to. */
  stdinLog: string;
  /** Subscribe to all SSE events for the session. */
  on(handler: (e: SessionBusEvent) => void): () => void;
  /** Wait until `predicate(events)` returns truthy, or reject after `timeoutMs`. */
  waitForEvent(
    predicate: (e: SessionBusEvent) => boolean,
    timeoutMs?: number,
  ): Promise<SessionBusEvent>;
  /** Mutate the env that the next mock-claude spawn will inherit. */
  setMockEnv(overrides: MockClaudeEnvOverrides): void;
  cleanup(): Promise<void>;
}

/**
 * Build a real SessionManager pointed at the mock-claude binary, with all
 * the surrounding fixtures (channel, agent, session) pre-created in an
 * in-memory DB. SessionManager's `binariesPromise` is monkey-patched to
 * map runtime "claude" → MOCK_CLAUDE_PATH so it never calls `which claude`.
 */
export async function buildManagerHarness(): Promise<ManagerHarness> {
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  mkdirSync(tmp.workspacesRoot, { recursive: true });

  // Channel + workspace dir
  const channels = new ChannelRepo(db, { workspacesRoot: tmp.workspacesRoot });
  const workspacePath = channels.workspacePathFor('test-ch');
  await initWorkspaceDir(workspacePath);
  const channel = channels.insert({
    name: 'test-ch',
    description: null,
    kind: 'regular',
    workspace_path: workspacePath,
    workspace_host_id: localHostId,
    dm_agent_id: null,
  });

  const agents = new AgentRepo(db);
  const agent = agents.create({ name: 'mock', runtime: 'claude' }, localHostId);

  const sessions = new SessionRepo(db);
  const session = sessions.insert({ channelId: channel.id, title: 't' });
  sessions.addAgent(session.id, agent.id);

  // Per-test env overrides; we mutate this reference and the manager picks
  // it up because spawn() reads env at call time.
  const mockEnvOverrides: MockClaudeEnvOverrides = {
    MOCK_CLAUDE_STDIN_LOG: join(tmp.silverhandDir, 'stdin.log'),
  };

  const serverConfig: ServerConfig = {
    mode: 'embedded',
    url: 'http://127.0.0.1:0',
    auth_token: 'a'.repeat(32),
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
    lastSpawnAtByAgent: new Map(),
    events: new SessionEventBus(),
    chatBridgeLauncher: { command: 'true', args: [] }, // never invoked in L3
    sessionManager: undefined as unknown as SessionManager,
  };
  // Bootstrap local host (matches what startBackend would do)
  new HostRepo(db).ensureLocal();

  const manager = new SessionManager(ctx);
  ctx.sessionManager = manager;

  // Inject mock binary so resolveBinary returns it without `which claude`.
  (manager as unknown as {
    binariesPromise: Promise<Map<string, string>>;
  }).binariesPromise = Promise.resolve(new Map([['claude', MOCK_CLAUDE_PATH]]));

  // Wrap process.spawn invocation indirectly: SessionManager calls
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
  function on(handler: (e: SessionBusEvent) => void): () => void {
    return ctx.events.subscribe(session.id, handler);
  }

  function waitForEvent(
    predicate: (e: SessionBusEvent) => boolean,
    timeoutMs = 3000,
  ): Promise<SessionBusEvent> {
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
    channelId: channel.id,
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
