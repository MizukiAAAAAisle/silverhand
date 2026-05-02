import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AUTH_TOKEN_ENV } from '@silverhand/shared';
import type { AgentDto, FromKind, McpServerConfig } from '@silverhand/shared';

import type { BackendContext } from './context.js';
import {
  getDriver,
  type Driver,
  type DriverPromptContext,
  type DriverSpawnContext,
  type ParsedEvent,
  type SessionContextInput,
} from './drivers/index.js';
import { detectRuntimes } from './runtimes.js';
import { prepareSpawnFiles, type SpawnPrepHandle } from './spawn-prep.js';
import { AgentRepo } from './repos/agent-repo.js';
import { ChannelRepo } from './repos/channel-repo.js';
import { InboxRepo, type PendingInboxItem } from './repos/inbox-repo.js';
import { MessageRepo } from './repos/message-repo.js';
import { SessionRepo } from './repos/session-repo.js';
import { SettingsRepo, SETTINGS_KEYS } from './repos/settings-repo.js';

/** §3.5 watchdog window. Slock's `COMPACTION_STALE_MS` = 5 min. */
const COMPACTION_STALE_MS = 5 * 60 * 1000;

/**
 * One running agent CLI = one AgentHandle. Keyed by `${sessionId}:${agentId}`
 * in SessionManager.handles. Owns: child process, temp file scaffolding,
 * driver, observed runtime state for gated steering.
 */
interface AgentHandle {
  sessionId: string;
  agentId: string;
  driver: Driver;
  child: ChildProcessWithoutNullStreams;
  rl: ReadlineInterface;
  spawnPrep: SpawnPrepHandle;
  /** Most recent CLI session id from `system.init`. Persisted to
   *  session_agents on receipt; lets `--resume` recover after restart. */
  cliSessionId: string | null;
  /** Gated-steering state — Phase 3E uses this to decide flush timing. */
  busy: { outstandingToolUses: number; compacting: boolean };
  /** Pending deliveries for gated mode. Phase 3E flushes; Phase 2C
   *  just appends. */
  pendingDeliveries: string[];
  /** Watchdog timer started on `compaction_started`; cleared on
   *  `compaction_finished`. Fires once after 5min if compaction never
   *  reports completion (slock's `COMPACTION_STALE_MS`). */
  compactionWatchdog: NodeJS.Timeout | null;
  /** Detached when stop() runs to suppress crash-status updates on
   *  intentional shutdown. */
  intentionallyStopped: boolean;
  /** Serializes drainInbox calls. Without this, a spawn-time drain and
   *  a session_init drain can race: both call `listPending` before
   *  either calls `markDelivered`, so claude receives the same message
   *  twice. The chain ensures each drain awaits the previous one's
   *  `markDelivered` before its own `listPending`. */
  drainChain: Promise<void>;
}

export interface StartOptions {
  /** Override the model (e.g. `sonnet-4-6`). Falls back to agent.model. */
  model?: string | null;
}

/**
 * Owns the lifecycle of every running agent CLI process. Single instance
 * per backend, held in BackendContext. All public methods are idempotent
 * w.r.t. duplicate calls (start when already running is a no-op).
 *
 * Phase 2C scope: spawn / pipe / event fan-out / busyState tracking.
 * Phase 3E adds delivery scheduling, 3F adds soft+hard interrupt,
 * 3G adds compaction watchdog. The skeleton accommodates all of those.
 */
export class SessionManager {
  private readonly handles = new Map<string, AgentHandle>();
  private readonly agents: AgentRepo;
  private readonly channels: ChannelRepo;
  private readonly sessions: SessionRepo;
  private readonly inboxes: InboxRepo;
  private readonly messages: MessageRepo;
  private readonly settings: SettingsRepo;
  private binariesPromise: Promise<Map<string, string>> | null = null;

  constructor(private readonly ctx: BackendContext) {
    this.agents = new AgentRepo(ctx.db);
    this.channels = new ChannelRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot });
    this.sessions = new SessionRepo(ctx.db);
    this.inboxes = new InboxRepo(ctx.db);
    this.messages = new MessageRepo(ctx.db);
    this.settings = new SettingsRepo(ctx.db);
  }

  isRunning(sessionId: string, agentId: string): boolean {
    return this.handles.has(handleKey(sessionId, agentId));
  }

  /**
   * Reconcile DB state with reality on backend boot. Any session_agent
   * row marked `starting` / `active` is stale (its child died with the
   * previous backend process) — flip to `idle`. We keep `cli_session_id`
   * so a subsequent `start()` call passes `--resume` and the agent
   * picks up its prior CLI conversation.
   *
   * No auto-spawn here per §3.1: agents wake only when a user opens the
   * session or sends to them. The UI / route layer triggers `start()`.
   */
  reconcileOnBoot(): void {
    const stale = this.sessions.listLiveStatusAgents();
    if (stale.length === 0) return;
    for (const sa of stale) {
      this.sessions.updateAgentRuntime(sa.session_id, sa.agent_id, {
        status: 'idle',
        pid: null,
      });
    }
    this.ctx.logger.info(
      { count: stale.length },
      'reconciled stale session_agents from prior boot',
    );
  }

  /**
   * Spawn the (session, agent) CLI. Idempotent: returns silently if
   * already running. Throws on missing entities or uninstalled runtime.
   *
   * Lifecycle wiring:
   *  - session_agents row is upserted (status: starting → active on
   *    `system.init`, → idle/crashed on exit)
   *  - stdout lines flow through driver.parseLine; events fan out to
   *    ctx.events keyed by sessionId
   *  - On exit, handle is removed and temp files are cleaned up
   */
  async start(sessionId: string, agentId: string, opts: StartOptions = {}): Promise<void> {
    const key = handleKey(sessionId, agentId);
    if (this.handles.has(key)) {
      this.ctx.logger.info(
        { sessionId, agentId },
        'session: start no-op, already running',
      );
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);
    if (session.closed_at !== null) {
      throw new Error(`session ${sessionId} is closed`);
    }
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const channel = this.channels.get(session.channel_id);
    if (!channel) throw new Error(`channel ${session.channel_id} not found`);

    // Make sure the join row exists (callers may have skipped addAgent).
    let sessionAgent = this.sessions.getAgent(sessionId, agentId);
    if (!sessionAgent) sessionAgent = this.sessions.addAgent(sessionId, agentId);

    const driver = getDriver(agent.runtime);
    const binary = await this.resolveBinary(agent.runtime);
    if (!binary) {
      this.ctx.logger.error(
        { sessionId, agentId, runtime: agent.runtime },
        "session: runtime binary not found on PATH",
      );
      throw new Error(
        `runtime '${agent.runtime}' is not installed (no binary on PATH)`,
      );
    }

    // Synthesize prompt + write spawn files.
    const promptCtx = await this.buildPromptContext(session, channel, agent);
    const systemPromptText = driver.buildSystemPrompt(promptCtx);
    const chatBridge: McpServerConfig = {
      command: this.ctx.chatBridgeLauncher.command,
      args: [
        ...this.ctx.chatBridgeLauncher.args,
        '--session-id',
        sessionId,
        '--agent-id',
        agentId,
        '--server-url',
        this.ctx.serverConfig.url,
      ],
      env: {
        [AUTH_TOKEN_ENV]: this.ctx.serverConfig.auth_token,
        // Pass through so chat-bridge writes its own JSONL alongside ours.
        ...(this.ctx.logDir ? { SILVERHAND_LOG_DIR: this.ctx.logDir } : {}),
        // Host-supplied env (e.g. ELECTRON_RUN_AS_NODE=1 in packaged builds).
        ...(this.ctx.chatBridgeLauncher.env ?? {}),
      },
    };
    const spawnPrep = await prepareSpawnFiles({
      sessionId,
      agentId,
      systemPromptText,
      chatBridge,
    });

    // For oneShot drivers, the inbox can't be drained over stdin —
    // there is no persistent stdin loop. So we drain it now and pass
    // the formatted text to the driver as `initialPrompt` (which will
    // become argv content for cursor-agent).
    let initialPrompt = '';
    let preDrainedInboxIds: number[] = [];
    if (driver.oneShot) {
      const items = this.inboxes.listPending(sessionId, agentId);
      if (items.length > 0) {
        initialPrompt = formatInboxBatch(items, id => this.agents.get(id)?.name);
        preDrainedInboxIds = items.map(i => i.inboxId);
      }
    }

    const spawnCtx: DriverSpawnContext = {
      agentId,
      agentName: agent.name,
      workspacePath: channel.workspace_path,
      cliSessionId: sessionAgent.cli_session_id,
      model: opts.model ?? agent.model,
      mcpConfigPath: spawnPrep.mcpConfigPath,
      systemPromptPath: spawnPrep.systemPromptPath,
      chatBridge,
      initialPrompt,
    };

    const args = driver.buildArgs(spawnCtx);
    const env = this.applyProxySetting(driver.applyEnv(process.env), agent.runtime);

    this.ctx.logger.info(
      { sessionId, agentId, runtime: agent.runtime, binary, args },
      'session: spawning agent',
    );

    const child = spawn(binary, args, {
      cwd: channel.workspace_path,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const rl = createInterface({ input: child.stdout });

    const handle: AgentHandle = {
      sessionId,
      agentId,
      driver,
      child,
      rl,
      spawnPrep,
      cliSessionId: sessionAgent.cli_session_id,
      busy: { outstandingToolUses: 0, compacting: false },
      pendingDeliveries: [],
      compactionWatchdog: null,
      intentionallyStopped: false,
      drainChain: Promise.resolve(),
    };
    this.handles.set(key, handle);

    this.sessions.updateAgentRuntime(sessionId, agentId, {
      status: 'starting',
      pid: child.pid ?? null,
    });
    this.publish(sessionId, 'agent_status', {
      agent_id: agentId,
      status: 'starting',
      pid: child.pid ?? null,
    });

    rl.on('line', line => {
      const events = driver.parseLine(line);
      for (const ev of events) this.handleParsedEvent(handle, ev);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      // Surface stderr to logs; not modeled as a chat event.
      this.ctx.logger.warn({ sessionId, agentId, text }, 'agent stderr');
    });

    child.on('error', err => {
      this.ctx.logger.error({ sessionId, agentId, err }, 'agent process error');
    });

    child.on('exit', (code, signal) => {
      this.ctx.logger.info(
        { sessionId, agentId, code, signal },
        'agent process exited',
      );
      const status: 'idle' | 'crashed' =
        handle.intentionallyStopped || code === 0 ? 'idle' : 'crashed';
      this.sessions.updateAgentRuntime(sessionId, agentId, {
        status,
        pid: null,
      });
      this.publish(sessionId, 'agent_status', {
        agent_id: agentId,
        status,
        exit_code: code,
        signal,
      });
      this.handles.delete(key);
      this.clearCompactionWatchdog(handle);
      rl.close();
      void spawnPrep.cleanup();

      // OneShot drivers (cursor) exit after each turn. If new messages
      // arrived in the inbox while the agent was running, respawn so
      // they actually get processed — otherwise they sit forever.
      if (
        driver.oneShot &&
        !handle.intentionallyStopped &&
        this.inboxes.listPending(sessionId, agentId).length > 0
      ) {
        this.start(sessionId, agentId, opts).catch(err =>
          this.ctx.logger.error(
            { sessionId, agentId, err },
            'oneShot: auto-respawn after exit failed',
          ),
        );
      }
    });

    // Driver-level post-spawn hook (codex uses it to fire the
    // `initialize` JSON-RPC handshake before any inbox drain happens).
    driver.bindIO?.({
      writeLine: line => this.writeLine(handle, line),
      spawnCtx,
    });

    if (driver.oneShot) {
      // The inbox content we drained pre-spawn is about to be processed
      // via argv. Mark it delivered so we don't re-deliver on respawn.
      if (preDrainedInboxIds.length > 0) {
        this.inboxes.markDelivered(preDrainedInboxIds);
      }
      return;
    }

    // Prime stdin synchronously after spawn. claude in
    // `--input-format stream-json` mode sometimes never emits
    // session_init when stdin starts empty — reproduced by
    // observation, matches `@slock-ai/daemon`'s pattern (slock always
    // writes the first user message right after spawn). The
    // session_init handler still calls drainInbox as a fallback for
    // messages that arrive *after* spawn but before init; the
    // serializing chain on `handle.drainChain` makes the double-call
    // safe — see drainInbox / doDrainInbox.
    this.drainInbox(handle).catch(err =>
      this.ctx.logger.error(
        { sessionId, agentId, err },
        'spawn-time inbox drain failed',
      ),
    );
  }

  /**
   * Stop the agent. Two layers per §3.2:
   *   - 'soft': inject a directive user message; agent finishes current
   *             tool then reads it on next turn. Process keeps running.
   *   - 'hard': fire driver.encodeInterruptControl() to terminate the
   *             current turn cleanly. If the process is still alive
   *             after 5s, SIGTERM. After another 5s, SIGKILL.
   */
  async stop(
    sessionId: string,
    agentId: string,
    mode: 'soft' | 'hard' = 'hard',
    softDirective?: string,
  ): Promise<void> {
    const key = handleKey(sessionId, agentId);
    const h = this.handles.get(key);
    if (!h) return;

    if (mode === 'soft') {
      const directive =
        softDirective ??
        '[user requested a course correction — pause your current direction and ' +
          'wait for the next instruction]';
      await this.writeUserMessage(h, directive).catch(err =>
        this.ctx.logger.warn(
          { sessionId, agentId, err },
          'soft interrupt write failed',
        ),
      );
      return;
    }

    // hard: control_request first, then process signals as fallback.
    h.intentionallyStopped = true;
    const interruptLine = h.driver.encodeInterruptControl();
    if (interruptLine) {
      try {
        await this.writeLine(h, interruptLine);
      } catch (err) {
        this.ctx.logger.warn(
          { sessionId, agentId, err },
          'interrupt control write failed; falling back to signals',
        );
      }
    }
    setTimeout(() => {
      if (!this.handles.has(key)) return;
      this.ctx.logger.info(
        { sessionId, agentId },
        'hard stop: control_request didn\'t exit, sending SIGTERM',
      );
      h.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.handles.has(key)) h.child.kill('SIGKILL');
      }, 5_000).unref();
    }, 5_000).unref();
  }

  /** Stop every running handle. Used on backend shutdown. Hard mode. */
  async stopAll(): Promise<void> {
    await Promise.all(
      Array.from(this.handles.keys()).map(k => {
        const [sid, aid] = k.split(':') as [string, string];
        return this.stop(sid, aid, 'hard');
      }),
    );
  }

  // ── internals ──────────────────────────────────────────────────────

  private handleParsedEvent(handle: AgentHandle, ev: ParsedEvent): void {
    const { sessionId, agentId } = handle;
    switch (ev.kind) {
      case 'session_init':
        // claude --input-format stream-json emits {type:'system',
        // subtype:'init', session_id} at the start of EVERY user-message
        // turn cycle, not just once at process startup — and it reuses
        // the same session_id across turns within one process. So a
        // repeat with the same id means "next turn started", not "agent
        // re-initialized": skip the side effects (status flip, publish,
        // log, drainInbox) which were intended for first-init only.
        if (handle.cliSessionId === ev.sessionId) break;
        handle.cliSessionId = ev.sessionId;
        this.sessions.updateAgentRuntime(sessionId, agentId, {
          status: 'active',
          cliSessionId: ev.sessionId,
        });
        this.publish(sessionId, 'agent_status', {
          agent_id: agentId,
          status: 'active',
          cli_session_id: ev.sessionId,
        });
        this.ctx.logger.info(
          { sessionId, agentId, cliSessionId: ev.sessionId },
          'agent: session_init received, status → active',
        );
        // §3.1 C: spawn-time inbox drain. Anything queued while the
        // agent was asleep gets injected now as one stdin user message.
        this.drainInbox(handle).catch(err =>
          this.ctx.logger.error(
            { sessionId, agentId, err },
            'inbox drain failed',
          ),
        );
        break;
      case 'tool_call':
        handle.busy.outstandingToolUses += 1;
        this.ctx.logger.info(
          {
            sessionId,
            agentId,
            tool: ev.name,
            toolCallId: ev.toolCallId,
            outstandingToolUses: handle.busy.outstandingToolUses,
          },
          'agent: tool_call',
        );
        break;
      case 'tool_output':
        handle.busy.outstandingToolUses = Math.max(
          0,
          handle.busy.outstandingToolUses - 1,
        );
        break;
      case 'turn_end':
        handle.busy.outstandingToolUses = 0;
        this.ctx.logger.info(
          { sessionId, agentId, pendingDeliveries: handle.pendingDeliveries.length },
          'agent: turn_end',
        );
        void this.flushPending(handle);
        break;
      case 'compaction_started':
        handle.busy.compacting = true;
        this.ctx.logger.info({ sessionId, agentId }, 'agent: compaction_started');
        this.startCompactionWatchdog(handle);
        break;
      case 'compaction_finished':
        handle.busy.compacting = false;
        this.ctx.logger.info({ sessionId, agentId }, 'agent: compaction_finished');
        this.clearCompactionWatchdog(handle);
        void this.flushPending(handle);
        break;
      case 'error':
        this.ctx.logger.warn(
          { sessionId, agentId, event: ev },
          'agent: parsed error event from CLI',
        );
        break;
      case 'thinking':
      case 'text':
      case 'unknown':
        break;
    }
    // Fan out everything (including state-affecting events) to UI.
    this.publish(sessionId, 'agent_event', { agent_id: agentId, event: ev });
  }

  private publish(sessionId: string, kind: string, payload: unknown): void {
    this.ctx.events.publish(sessionId, { kind, payload });
  }

  private async buildPromptContext(
    session: ReturnType<SessionRepo['get']> & {},
    channel: ReturnType<ChannelRepo['get']> & {},
    agent: AgentDto,
  ): Promise<DriverPromptContext> {
    const others = this.sessions
      .listAgents(session.id)
      .filter(sa => sa.agent_id !== agent.id)
      .map(sa => this.agents.get(sa.agent_id))
      .filter((a): a is AgentDto => a !== null)
      .map(a => ({ name: a.name, runtime: a.runtime }));

    let parentSessionTitle: string | null = null;
    if (session.parent_session_id) {
      const parent = this.sessions.get(session.parent_session_id);
      parentSessionTitle = parent?.title ?? null;
    }

    const l2Path = join(
      channel.workspace_path,
      '.silverhand',
      'agents',
      agent.id,
      'system_prompt.md',
    );
    const l2SystemPrompt = await readFile(l2Path, 'utf-8').catch(() => '');

    const sessionContext: SessionContextInput = {
      channelName: channel.name,
      channelKind: channel.kind,
      sessionTitle: session.title,
      otherMembers: others,
      isChildSession: session.parent_session_id !== null,
      parentSessionTitle,
    };

    return {
      agentId: agent.id,
      agentName: agent.name,
      l2SystemPrompt,
      sessionContext,
    };
  }

  /**
   * Deliver a message that already exists in the `messages` table to one
   * specific (session, agent). The caller wrote the row + decided this
   * agent should see it. We pick the path:
   *
   *   - agent not running       → enqueue to `agent_inboxes` (drained on
   *                               next spawn, §3.1 C 档)
   *   - direct mode             → write immediately (§3.1 A 档)
   *   - gated mode at boundary  → write immediately
   *   - gated mode mid-turn     → push to handle.pendingDeliveries; flush
   *                               at next safe boundary
   */
  async deliverMessage(sessionId: string, agentId: string, messageId: string): Promise<void> {
    const handle = this.handles.get(handleKey(sessionId, agentId));
    if (!handle) {
      this.inboxes.enqueue(sessionId, agentId, messageId);
      this.ctx.logger.info(
        { sessionId, agentId, messageId },
        'deliver: agent not running, enqueued to inbox',
      );
      // Look up the agent to decide if we need to wake it up: oneShot
      // drivers (cursor) only consume the inbox at spawn time, so they
      // need an explicit kick. start() is idempotent.
      const agent = this.agents.get(agentId);
      if (agent) {
        const driver = getDriver(agent.runtime);
        if (driver.oneShot) {
          this.start(sessionId, agentId).catch(err =>
            this.ctx.logger.error(
              { sessionId, agentId, err },
              'oneShot: auto-start on deliverMessage failed',
            ),
          );
        }
      }
      return;
    }
    const msg = this.messages.getById(messageId);
    if (!msg) {
      this.ctx.logger.warn(
        { sessionId, agentId, messageId },
        'deliver: messageId not found in messages table',
      );
      return;
    }
    const text = formatLiveMessage(msg, id => this.agents.get(id)?.name);

    // Drivers that don't accept stdin notifications: enqueue. The
    // oneShot exit handler (or the next manual start) will respawn and
    // drain. Note: handle existence implies the agent IS running, so
    // we don't double-start here — the exit handler covers the
    // race-with-just-finishing case.
    if (handle.driver.busyDeliveryMode === 'none') {
      this.inboxes.enqueue(sessionId, agentId, messageId);
      this.ctx.logger.info(
        { sessionId, agentId, messageId },
        'deliver: oneShot agent running; queued for next respawn',
      );
      return;
    }

    if (handle.driver.busyDeliveryMode === 'direct' || isSafeBoundary(handle)) {
      // Try the direct stdin path. Stateful drivers (codex) may not be
      // ready yet (no thread/started → no threadId) and return null;
      // in that case fall back to the inbox so the session_init drain
      // catches up.
      const line = handle.driver.encodeStdinMessage(text, handle.cliSessionId);
      if (line === null) {
        this.inboxes.enqueue(sessionId, agentId, messageId);
        this.ctx.logger.info(
          { sessionId, agentId, messageId },
          'deliver: driver not yet ready (e.g. codex pre-thread); enqueued to inbox',
        );
        return;
      }
      this.ctx.logger.info(
        {
          sessionId,
          agentId,
          messageId,
          mode: handle.driver.busyDeliveryMode,
          bytes: text.length,
        },
        'deliver: writing to agent stdin',
      );
      await this.writeLine(handle, line);
    } else {
      handle.pendingDeliveries.push(text);
      this.ctx.logger.info(
        {
          sessionId,
          agentId,
          messageId,
          pendingCount: handle.pendingDeliveries.length,
          outstandingToolUses: handle.busy.outstandingToolUses,
          compacting: handle.busy.compacting,
        },
        'deliver: agent busy, queued for next safe boundary',
      );
    }
  }

  /** Flush pending deliveries when a safe boundary opens. No-op when
   *  not at a boundary or queue empty. */
  private async flushPending(handle: AgentHandle): Promise<void> {
    if (!isSafeBoundary(handle)) return;
    if (handle.pendingDeliveries.length === 0) return;
    const batch = handle.pendingDeliveries.splice(0);
    const combined =
      batch.length === 1
        ? batch[0]!
        : combineGatedBatch(batch);
    this.ctx.logger.info(
      {
        sessionId: handle.sessionId,
        agentId: handle.agentId,
        batchSize: batch.length,
        bytes: combined.length,
      },
      'deliver: flushing pending batch at safe boundary',
    );
    await this.writeUserMessage(handle, combined);
  }

  private writeUserMessage(handle: AgentHandle, content: string): Promise<void> {
    const line = handle.driver.encodeStdinMessage(content, handle.cliSessionId);
    if (line === null) {
      // Driver doesn't accept stdin notifications. Caller should have
      // routed via the inbox path; getting here is a bug.
      this.ctx.logger.warn(
        { sessionId: handle.sessionId, agentId: handle.agentId },
        'writeUserMessage: driver returned null encoding; dropped',
      );
      return Promise.resolve();
    }
    return this.writeLine(handle, line);
  }

  private startCompactionWatchdog(handle: AgentHandle): void {
    this.clearCompactionWatchdog(handle);
    handle.compactionWatchdog = setTimeout(() => {
      handle.compactionWatchdog = null;
      // Per slock §3.5: stale, but don't kill — just surface it.
      this.publish(handle.sessionId, 'compaction_stale', {
        agent_id: handle.agentId,
        elapsed_ms: COMPACTION_STALE_MS,
      });
      this.ctx.logger.warn(
        { sessionId: handle.sessionId, agentId: handle.agentId },
        'compaction has been running for 5min with no finish event',
      );
    }, COMPACTION_STALE_MS);
  }

  private clearCompactionWatchdog(handle: AgentHandle): void {
    if (handle.compactionWatchdog) {
      clearTimeout(handle.compactionWatchdog);
      handle.compactionWatchdog = null;
    }
  }

  private async resolveBinary(runtime: string): Promise<string | null> {
    if (!this.binariesPromise) {
      this.binariesPromise = detectRuntimes().then(infos => {
        const m = new Map<string, string>();
        for (const info of infos) {
          if (info.installed && info.binary) m.set(info.kind, info.binary);
        }
        return m;
      });
    }
    const m = await this.binariesPromise;
    return m.get(runtime) ?? null;
  }

  /**
   * Read the host-wide `proxy_url` + `proxy_runtimes` settings; if the
   * URL is set AND this agent's runtime is in the allowlist, inject
   * `HTTP[S]_PROXY` / `ALL_PROXY` (uppercase + lowercase) into the
   * spawned env. Otherwise return env unchanged.
   *
   * Per-runtime opt-in (rather than blanket "apply to everyone") because
   * different runtimes hit different endpoints — codex needs the proxy
   * to reach chatgpt.com through corporate firewalls; claude/anthropic
   * may not. The user picks which runtimes need it in Settings.
   *
   * Why both cases: most CLIs respect either, but Rust/reqwest prefers
   * uppercase; many shell-launched tools (curl, git) use lowercase.
   * Setting both is harmless and avoids subtle "works in zsh but not
   * in app" surprises.
   */
  private applyProxySetting(
    env: NodeJS.ProcessEnv,
    runtime: string,
  ): NodeJS.ProcessEnv {
    const proxyUrl = this.settings.get(SETTINGS_KEYS.PROXY_URL);
    if (!proxyUrl) return env;
    const allowlist = parseRuntimeList(
      this.settings.get(SETTINGS_KEYS.PROXY_RUNTIMES),
    );
    if (!allowlist.has(runtime)) return env;
    return {
      ...env,
      HTTP_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      ALL_PROXY: proxyUrl,
      all_proxy: proxyUrl,
    };
  }

  /** Fetch + format pending inbox items, write one combined stdin user
   *  message, mark delivered. No-op when inbox is empty.
   *
   *  Concurrent calls serialize via `handle.drainChain` — see field
   *  comment for why this matters (otherwise spawn-time + session_init
   *  drains race and double-write). */
  private drainInbox(handle: AgentHandle): Promise<void> {
    const next = handle.drainChain.then(() => this.doDrainInbox(handle));
    // Don't poison the chain on failure — subsequent drains should
    // still be attempted (e.g. an inbox that grows after a failed
    // write may succeed on retry once the pipe is healthy again).
    handle.drainChain = next.catch(() => {});
    return next;
  }

  private async doDrainInbox(handle: AgentHandle): Promise<void> {
    const items = this.inboxes.listPending(handle.sessionId, handle.agentId);
    if (items.length === 0) return;
    const text = formatInboxBatch(items, id => this.agents.get(id)?.name);
    const line = handle.driver.encodeStdinMessage(text, handle.cliSessionId);
    if (line === null) {
      // Driver isn't ready to accept stdin yet — typical for codex
      // between `bindIO` (initialize sent) and `thread/started`. Bail
      // *without* marking inbox delivered; the session_init handler's
      // retry will pick the items up once the driver flips to ready.
      this.ctx.logger.info(
        {
          sessionId: handle.sessionId,
          agentId: handle.agentId,
          itemCount: items.length,
        },
        'inbox: driver not ready (e.g. codex pre-thread); deferred',
      );
      return;
    }
    this.ctx.logger.info(
      {
        sessionId: handle.sessionId,
        agentId: handle.agentId,
        itemCount: items.length,
        bytes: text.length,
      },
      'inbox: draining queued items into agent stdin',
    );
    await this.writeLine(handle, line);
    this.inboxes.markDelivered(items.map(i => i.inboxId));
  }

  /** Best-effort write of one JSON line to the agent's stdin. */
  private writeLine(handle: AgentHandle, line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ok = handle.child.stdin.write(line + '\n', err =>
        err ? reject(err) : resolve(),
      );
      if (!ok) handle.child.stdin.once('drain', () => resolve());
    });
  }
}

function handleKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

/**
 * Format an inbox batch as one human-readable user message. Mirrors §3.1
 * "A 档" payload shape — gives the agent enough metadata to address each
 * sender appropriately. Order = enqueue order.
 */
function formatInboxBatch(
  items: PendingInboxItem[],
  agentNameById: (id: string) => string | undefined,
): string {
  const header =
    items.length === 1
      ? 'You have one message waiting since you were last active:'
      : `You have ${items.length} messages waiting since you were last active (oldest first):`;
  const body = items
    .map(({ message }) => {
      const sender = describeSender(message, agentNameById);
      return `[from ${sender}]\n${message.content}`;
    })
    .join('\n\n---\n\n');
  return `${header}\n\n${body}\n\nRespond as appropriate.`;
}

function describeSender(
  msg: MessageLite,
  agentNameById: (id: string) => string | undefined,
): string {
  switch (msg.from_kind) {
    case 'agent': {
      const name = msg.from_agent_id
        ? agentNameById(msg.from_agent_id)
        : undefined;
      return `@${name ?? 'agent'}`;
    }
    case 'user':
      return 'user';
    case 'system':
      return 'system';
  }
}

/** Single live message as "A 档" payload — same shape as inbox batches
 *  but with a "just arrived" framing so the agent treats it as fresh. */
function formatLiveMessage(
  message: MessageLite,
  agentNameById: (id: string) => string | undefined,
): string {
  const sender = describeSender(message, agentNameById);
  return `New message from ${sender}:\n${message.content}\n\nRespond as appropriate.`;
}

/** Minimal projection both InboxRepo's joined rows and MessageRepo
 *  DTOs satisfy — the formatters only need these three fields. */
interface MessageLite {
  from_kind: FromKind;
  from_agent_id: string | null;
  content: string;
}

/** When multiple gated deliveries pile up between safe boundaries, we
 *  flush as one combined user message so claude sees them in order. */
function combineGatedBatch(messages: string[]): string {
  return (
    `You have ${messages.length} new messages that arrived while you were busy ` +
    `(oldest first):\n\n${messages.join('\n\n---\n\n')}\n\nRespond as appropriate.`
  );
}

function isSafeBoundary(h: AgentHandle): boolean {
  return h.busy.outstandingToolUses === 0 && !h.busy.compacting;
}

/** Comma-separated runtime kinds → Set, robust to whitespace + empty entries. */
function parseRuntimeList(raw: string | null): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0),
  );
}
