/**
 * D5.a-3 P1 regressions (Cindy `KuHXrKuCv9nPU28M`) — real `startBackend`
 * embedded boot + shutdown against a fake local-outbound daemon over a
 * Unix socket. Unlike the fanout unit pins (which prove "whatever
 * `serverUrl()` returns ends up in `runtime_start`"), this exercises the
 * actual `startBackend` BOOT ORDER and SHUTDOWN ORDER.
 *
 * P1-1 — the embedded adapter must `connect()` only AFTER the listen
 * callback has swapped `ctx.serverConfig.url` from the input placeholder
 * (`http://127.0.0.1:0`) to the real bound URL. We assert the
 * `runtime_start` the daemon receives carries
 * `options.env_policy.silverhand.server_url === running.url`, never the
 * `:0` placeholder.
 *
 * P1-2 — `closeActivityLog()` must dispatch `runtime_close_activity_log`
 * WHILE the outbound transport is still connected. We assert the daemon
 * actually receives that command during `running.close()`. If shutdown
 * tore down the transport first (the pre-fix order) the daemon would
 * never see it.
 */
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KNOWN_CAPABILITIES_V1, splitNdjson } from '@silverhand/host';
import type { ServerConfig } from '@silverhand/shared';
import { startBackend, type RunningBackend } from '../../src/index.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';

interface ReceivedCommand {
  id: string;
  kind: string;
  params: unknown;
}

/**
 * Minimal fake daemon outbound-frame server. Accepts ONE backend
 * connection, parses NDJSON `server_to_daemon` command frames, and lets
 * the test drive when `ready` is sent + inspect received commands. It
 * auto-answers `runtime_status` (empty snapshot), `runtime_start`
 * (started), and `runtime_close_activity_log` (ack), and records every
 * command kind in arrival order.
 */
class FakeOutboundDaemon {
  readonly server: NetServer;
  socket: Socket | null = null;
  private buffer = '';
  readonly commands: ReceivedCommand[] = [];
  private connectedResolve: (() => void) | null = null;
  private readonly connected: Promise<void>;

  constructor(private readonly socketPath: string) {
    this.connected = new Promise<void>(resolve => {
      this.connectedResolve = resolve;
    });
    this.server = createServer(sock => {
      this.socket = sock;
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string | Buffer) => this.onData(chunk));
      this.connectedResolve?.();
      this.connectedResolve = null;
    });
  }

  async listen(): Promise<void> {
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  waitConnected(): Promise<void> {
    return this.connected;
  }

  /** Push the connection-scoped `ready` event the backend hydrates from. */
  sendReady(): void {
    this.write({
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'ready',
      protocol_version: 1,
      daemon_version: '0.0.0-fake',
      daemon_id: 'local',
      instance_id: 'instance-fake-1',
      host_descriptor: { name: 'local', kind: 'local' },
      capabilities: [...KNOWN_CAPABILITIES_V1],
      daemon_pid: 4242,
      started_at: 1,
    });
  }

  kinds(): string[] {
    return this.commands.map(c => c.kind);
  }

  find(kind: string): ReceivedCommand | undefined {
    return this.commands.find(c => c.kind === kind);
  }

  async close(): Promise<void> {
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {
      /* best-effort */
    }
  }

  private onData(chunk: string | Buffer): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const { frames, leftover } = splitNdjson(this.buffer, text);
    this.buffer = leftover;
    for (const line of frames) {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (frame.type !== 'command') continue;
      const cmd: ReceivedCommand = {
        id: String(frame.id),
        kind: String(frame.kind),
        params: frame.params,
      };
      this.commands.push(cmd);
      this.respond(cmd);
    }
  }

  private respond(cmd: ReceivedCommand): void {
    // Results MUST satisfy each command's strict result schema, else the
    // adapter treats the response frame as a protocol violation and drops
    // the socket (which is exactly the bug that masked P1-2 the first time).
    if (cmd.kind === 'runtime_status') {
      this.respondResult(cmd, { runtimes: [] });
    } else if (cmd.kind === 'runtime_start') {
      this.respondResult(cmd, {
        started: true,
        pid: 9001,
        started_at: 2,
        startup_delivery_accepted: true,
      });
    } else if (cmd.kind === 'runtime_stop_all') {
      this.respondResult(cmd, { stopped_count: 0 });
    } else if (cmd.kind === 'runtime_close_activity_log') {
      this.respondResult(cmd, { flushed: true });
    } else if (cmd.kind === 'workspace_provision') {
      // D4.e-6: runtime_start is preceded by a bounded lazy registry
      // backfill — ack the re-bind with a valid provision result so the
      // start can proceed (idempotent re-bind to the requested path).
      const requested = (cmd.params as { requested_path?: string }).requested_path;
      this.respondResult(cmd, {
        ok: true,
        provisioned: true,
        bound_workspace_path: requested ?? '/host/ws/provisioned',
      });
    } else {
      this.respondResult(cmd, {});
    }
  }

  private respondResult(cmd: ReceivedCommand, result: unknown): void {
    this.write({
      direction: 'daemon_to_server',
      type: 'command_response',
      id: cmd.id,
      kind: cmd.kind,
      result,
    });
  }

  private write(frame: Record<string, unknown>): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${JSON.stringify(frame)}\n`);
    }
  }
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 3_000, label = 'condition' }: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('D5.a-3 embedded boot + shutdown order (real startBackend)', () => {
  let running: RunningBackend | null = null;
  let daemon: FakeOutboundDaemon | null = null;
  let tmpDir: string | null = null;

  afterEach(async () => {
    await running?.close().catch(() => undefined);
    running = null;
    await daemon?.close().catch(() => undefined);
    daemon = null;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('runtime_start carries the finalized listen URL (P1-1) and close() dispatches runtime_close_activity_log before transport teardown (P1-2)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silverhand-d5a-boot-'));
    const socketPath = join(tmpDir, 'daemon-outbound.sock');
    daemon = new FakeOutboundDaemon(socketPath);
    await daemon.listen();

    const config: ServerConfig = {
      mode: 'embedded',
      url: 'http://127.0.0.1:0', // placeholder; replaced at listen-time
      auth_token: 'c'.repeat(32),
      refresh_token: null,
      child_sessions: {
        max_concurrent_per_parent: null,
        spawn_cooldown_seconds: null,
        max_depth: 1,
      },
    };

    running = await startBackend({
      mode: 'embedded',
      dbPath: join(tmpDir, 'silverhand.db'),
      silverhandDir: tmpDir,
      serverConfig: config,
      silverhandCliLauncher: { command: 'true', args: [] },
      logger: { info() {}, warn() {}, error() {} },
      outboundSocketPath: socketPath,
    });

    // Sanity: the listen callback finalized the URL away from the
    // placeholder before we proceed.
    expect(running.url).not.toContain(':0');
    expect(running.context.serverConfig.url).toBe(running.url);

    const db = running.context.db;
    const localHostId = new HostRepo(db).ensureLocal().id;

    // Seed a (workspace, agent, conversation, conversation_agents=idle)
    // owned by the local host + one pending inbox row, so the daemon's
    // `ready` triggers hydrate → auto-replay → runtime_start.
    const now = Date.now();
    const userId = 'user-d5a-boot';
    const workspaceId = 'ws-d5a-boot';
    const agentId = 'agent-d5a-boot';
    const conversationId = 'conv-d5a-boot';
    const workspacePath = join(tmpDir, 'workspaces', workspaceId);

    db.prepare(
      `INSERT INTO users (id, name, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`,
    ).run(userId, 'd5a-boot-user', 'D5a Boot User', now, now);
    db.prepare(
      `INSERT INTO workspaces
        (id, name, description, workspace_kind, workspace_path,
         workspace_host_id, owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'regular', ?, ?, NULL, NULL, ?, ?)`,
    ).run(workspaceId, 'd5a-boot-ws', workspacePath, localHostId, now, now);
    db.prepare(
      `INSERT INTO agents
        (id, name, runtime, model, host_id, description, created_at,
         updated_at, display_name, reasoning_effort, fast_mode,
         created_by_user_id, avatar_storage_key, avatar_content_type)
        VALUES (?, ?, 'claude', NULL, ?, NULL, ?, ?, ?, NULL, NULL,
                ?, NULL, NULL)`,
    ).run(agentId, 'd5a-boot-agent', localHostId, now, now, 'D5a Boot Agent', userId);
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
        VALUES (?, ?, ?)`,
    ).run(workspaceId, agentId, now);
    db.prepare(
      `INSERT INTO conversations
        (id, workspace_id, workspace_path, kind, parent_conversation_id,
         title, status, spawned_by_agent_id, closed_at, close_summary,
         pinned_at, created_at, updated_at)
        VALUES (?, ?, ?, 'channel', NULL, ?, 'active', NULL, NULL, NULL,
                NULL, ?, ?)`,
    ).run(conversationId, workspaceId, workspacePath, 'd5a-boot-channel', now, now);
    db.prepare(
      `INSERT INTO conversation_agents
        (conversation_id, agent_id, cli_session_id, pid, status, joined_at)
        VALUES (?, ?, NULL, NULL, 'idle', ?)`,
    ).run(conversationId, agentId, now);

    const messageId = 'msg-d5a-boot';
    db.prepare(
      `INSERT INTO messages
        (id, conversation_id, from_kind, from_agent_id, from_user_id,
         content, metadata, seq, created_at)
        VALUES (?, ?, 'user', NULL, NULL, ?, NULL, 1, ?)`,
    ).run(messageId, conversationId, 'hello agent', now);
    new ConversationInboxRepo(db).enqueue(conversationId, agentId, messageId);

    // The backend has dialed by now (connect fired from the listen
    // callback). Release `ready` so hydrate → auto-replay runs.
    await daemon.waitConnected();
    daemon.sendReady();

    // ── P1-1 assertion ──
    await waitFor(() => !!daemon!.find('runtime_start'), {
      label: 'runtime_start dispatch',
    });
    const start = daemon.find('runtime_start')!;
    const params = start.params as {
      options: { env_policy: { silverhand: { server_url: string } } };
    };
    expect(params.options.env_policy.silverhand.server_url).toBe(running.url);
    expect(params.options.env_policy.silverhand.server_url).not.toContain(':0');

    // ── P1-2 assertion ──
    // Close the backend; the daemon must receive runtime_close_activity_log
    // (which is only possible if the dispatch ran before transport teardown).
    const toClose = running;
    running = null;
    await toClose.close();
    expect(daemon.kinds()).toContain('runtime_close_activity_log');
    // Ordering proof: stop_all + close_activity_log are dispatched in the
    // runtime-shutdown phase (before transport teardown). close_activity_log
    // lands after stop_all and BOTH are received over the live connection.
    const kinds = daemon.kinds();
    expect(kinds.indexOf('runtime_close_activity_log')).toBeGreaterThan(
      kinds.indexOf('runtime_stop_all'),
    );
  });
});
