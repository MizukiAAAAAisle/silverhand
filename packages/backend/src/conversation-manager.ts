import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { systemSubtype } from '@silverhand/shared';
import type {
  AgentDto,
  AgentRunState,
  AgentRunStatus,
  AgentRunTerminalReason,
  ConversationDto,
  MessageDto,
  WorkspaceDto,
} from '@silverhand/shared';

import type { BackendContext } from './context.js';
import {
  buildSystemPromptFor,
  getDriver,
  type Driver,
  type DriverPromptContext,
  type DriverSpawnContext,
  type InjectedFileContent,
  type ParsedEvent,
  type SessionContextInput,
  type WorkspaceMemoryIndexEntry,
} from './drivers/index.js';
import { detectRuntimes } from '@silverhand/host/runtimes';
import { sanitizeParsedEventForBroadcast } from './runtime/event-sanitize.js';
import {
  combineGatedBatch,
  formatAttachmentSuffix,
  formatInboxBatch,
  formatLiveMessage,
  sendMessageToolName,
} from './runtime/stdin-format.js';
import { buildAgentSpawnEnv } from './runtime/spawn-env.js';
import type { AgentRuntimeHost } from './runtime/agent-runtime-host.js';
import { activeAgentProfileDir, agentL1ProfileDir, agentMemoryDirFor } from './agent-profile.js';
import { prepareSpawnFiles, type SpawnPrepHandle } from './spawn-prep.js';
import { AgentRepo } from './repos/agent-repo.js';
import { ConversationInboxRepo } from './repos/conversation-inbox-repo.js';
import { ConversationRepo } from './repos/conversation-repo.js';
import { MessageRepo } from './repos/message-repo.js';
import { NotificationRepo } from './repos/notification-repo.js';
import { SettingsRepo, SETTINGS_KEYS } from './repos/settings-repo.js';
import { UserRepo } from './repos/user-repo.js';
import { WorkspaceRepo } from './repos/workspace-repo.js';
import { MembershipService } from './services/membership-service.js';

/** §3.5 watchdog window. Slock's `COMPACTION_STALE_MS` = 5 min. */
const COMPACTION_STALE_MS = 5 * 60 * 1000;

/** Fallbacks for drivers that do not override init watchdog windows. */
const DEFAULT_INIT_LIVENESS_SILENCE_MS = 30 * 1000;
const DEFAULT_INIT_PRE_PROTOCOL_CAP_MS = 5 * 60 * 1000;
const DEFAULT_INIT_POST_PROTOCOL_MS = 30 * 1000;
const INIT_TIMEOUT_MAX_RETRIES = 1;
const INIT_FAILURE_COOLDOWN_THRESHOLD = 3;
const INIT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const AGENT_ACTIVITY_HEARTBEAT_MS = 2 * 1000;
const ACTIVITY_SNIPPET_MAX_CHARS = 200;
const ACTIVITY_SNIPPET_BUFFER_MAX_CHARS = ACTIVITY_SNIPPET_MAX_CHARS * 4;
// RAW_AGENT_EVENT_* caps moved to runtime/event-sanitize.ts alongside
// the sanitizer functions; CM no longer references them directly.

/**
 * Caps for auto-injected context files (MEMORY.md / CONSENSUS.md). The
 * platform prompt embeds the file contents verbatim; oversized files
 * blow context budgets and have historically been a sign that an agent
 * was using MEMORY.md as a work log instead of an index. Keeping
 * MEMORY <= 16KB and CONSENSUS <= 4KB is the documented soft target;
 * the assembler enforces it as a hard truncation point with an explicit
 * `…(truncated)` marker so the agent knows when content was clipped.
 */
const MEMORY_INJECT_CAP_BYTES = 16 * 1024;
const CONSENSUS_INJECT_CAP_BYTES = 4 * 1024;

/**
 * Read a UTF-8 text file but cap the returned size to `capBytes`. The
 * result is a discriminated union so the system-prompt assembler can
 * render the right thing per case:
 *
 *   - `present`: file existed and read OK; body is the (possibly
 *     truncated) UTF-8 text. Truncation is signalled with a trailing
 *     `\n…(truncated)` marker so the agent knows the content was
 *     clipped.
 *   - `missing`: ENOENT — file simply does not exist. Renderer shows
 *     the "create one when…" hint.
 *   - `unreadable`: any other error (EACCES, EISDIR, IO, …). Renderer
 *     shows an explicit `[unable to read …: <reason>]` so the agent
 *     does not falsely conclude the file is missing and create a
 *     duplicate.
 *
 * The cap is measured in bytes (Buffer.byteLength) — multi-byte runes
 * near the boundary are dropped together rather than producing a
 * malformed code unit.
 */
async function readFileWithCap(
  path: string,
  capBytes: number,
): Promise<InjectedFileContent> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { kind: 'missing' };
    const reason = code ?? (err as Error | undefined)?.message ?? 'unknown error';
    return { kind: 'unreadable', reason };
  }
  if (buf.byteLength <= capBytes) {
    return { kind: 'present', body: buf.toString('utf-8') };
  }
  // UTF-8-safe truncation: walk back from `capBytes` until the byte at
  // the boundary is not a continuation byte (0b10xxxxxx). Treat
  // out-of-bounds reads as "not a continuation byte" so the loop
  // terminates cleanly.
  let cut = capBytes;
  while (cut > 0 && (buf[cut] !== undefined && (buf[cut]! & 0xc0) === 0x80)) cut -= 1;
  return {
    kind: 'present',
    body: `${buf.subarray(0, cut).toString('utf-8')}\n…(truncated)`,
  };
}

type ActivitySnippetKind = 'thinking' | 'text';
type InitTimeoutReason =
  | 'silence'
  | 'pre_protocol_cap'
  | 'post_protocol';
type InitTimeoutField =
  | 'initLivenessSilenceMs'
  | 'initPreProtocolCapMs'
  | 'initPostProtocolMs';

interface ActivitySnippetBuffer {
  runId: string;
  kind: ActivitySnippetKind;
  text: string;
}

interface InitRetryState {
  failures: number;
  cooldownUntil: number;
}

/**
 * One running agent CLI = one AgentHandle. Keyed by `${conversationId}:${agentId}`
 * in ConversationManager.handles. Owns: child process, temp file scaffolding,
 * driver, observed runtime state for gated steering.
 */
interface AgentHandle {
  conversationId: string;
  agentId: string;
  driver: Driver;
  child: ChildProcessWithoutNullStreams;
  rl: ReadlineInterface;
  spawnPrep: SpawnPrepHandle;
  agentToken: string;
  /** Most recent CLI conversation id from `system.init`. Persisted to
   *  conversation_agents on receipt; lets `--resume` recover after restart.
   *  May be non-null at spawn time when resuming — see `initObserved`
   *  for "has the live process actually emitted init yet". */
  cliSessionId: string | null;
  /** Set true the first time this process emits `session_init`. Used
   *  to dedupe claude's per-turn re-inits AND to gate init completion.
   *  Critical to track separately from `cliSessionId`: when resuming,
   *  cliSessionId is preloaded from DB and matches whatever the
   *  resumed CLI emits, so equality-on-cliSessionId would (a) skip the
   *  status→active flip on first init and (b) make the watchdog think
   *  init had already landed. Both bugs let a wedged resumed agent sit
   *  in `starting` forever with the UI showing "connecting".
   *
   *  For drivers with `kickoffMode='requires_first_message'`, an empty-inbox
   *  spawn may deliberately be `status='active'` while `initObserved=false`:
   *  the process is alive and can receive stdin, but the runtime will not emit
   *  init until the first real user message is written. */
  initObserved: boolean;
  /** Gated-steering state — Phase 3E uses this to decide flush timing. */
  busy: { outstandingToolUses: number; compacting: boolean };
  /** A turn_end arrived while the run could not be resolved yet, usually
   *  because compaction was still active or pending deliveries need flush. */
  pendingTurnEnd: boolean;
  /** Pending deliveries for gated mode. The durable source of truth is
   *  `conversation_inboxes`; this in-memory list only remembers the already
   *  formatted messages for the currently running process so a safe boundary
   *  can flush them without re-querying. If the process is hard-stopped,
   *  these entries may disappear, but their inbox rows remain pending. */
  pendingDeliveries: PendingDelivery[];
  /** Watchdog timer started on `compaction_started`; cleared on
   *  `compaction_finished`. Fires once after 5min if compaction never
   *  reports completion (slock's `COMPACTION_STALE_MS`). */
  compactionWatchdog: NodeJS.Timeout | null;
  /** Init watchdog timers. Pre-protocol silence/cap run from spawn
   *  until the first driver-classified protocol frame; the post-protocol
   *  timer then waits for the real session-ready init. */
  initLivenessSilenceWatchdog: NodeJS.Timeout | null;
  initPreProtocolCapWatchdog: NodeJS.Timeout | null;
  initPostProtocolWatchdog: NodeJS.Timeout | null;
  initWatchdogArmed: boolean;
  initStartedAt: number;
  initProtocolObserved: boolean;
  initAttempt: number;
  initRetryPlanned: boolean;
  initTimeoutReason: InitTimeoutReason | null;
  /** Set by the init watchdog when it kills the child. Takes precedence
   *  over `intentionallyStopped` in the exit handler so the status
   *  flips to `crashed` (not `idle`) and oneShot agents don't auto
   *  respawn into the same hang. */
  initTimedOut: boolean;
  /** Fatal runtime error surfaced before process exit. Used for Codex
   *  resume failures such as "thread not found" so we can clear stale
   *  resume state and terminally clear the current activity run. */
  fatalError: { reason: string; error: string } | null;
  /** Guards persistent crash notifications when a fatal error is
   *  surfaced immediately and the exit handler runs shortly after. */
  crashNotificationRecorded: boolean;
  /** Detached when stop() runs to suppress crash-status updates on
   *  intentional shutdown. */
  intentionallyStopped: boolean;
  /** Serializes drainInbox calls. Without this, a spawn-time drain and
   *  a session_init drain can race: both call `listPending` before
   *  either calls `markDelivered`, so claude receives the same message
   *  twice. The chain ensures each drain awaits the previous one's
   *  `markDelivered` before its own `listPending`. */
  drainChain: Promise<void>;
  /** Inbox rows written to stdin before a first session_init for drivers with
   *  `kickoffMode='requires_first_message'`. Write success only proves the OS
   *  pipe accepted bytes; if the process never reaches init, retry/restart must
   *  replay those rows rather than losing the user's message. We mark them
   *  delivered only once the driver's parsed session_init proves the runtime
   *  actually consumed the kickoff turn. */
  initPendingInboxIds: number[];
}

interface PendingDelivery {
  inboxId: number;
  messageId: string;
  text: string;
}

export interface StartOptions {
  /** Override the model (e.g. `sonnet-4-6`). Falls back to agent.model. */
  model?: string | null;
}

export interface ClearSessionResult {
  prevCliSessionId: string | null;
  wasRunning: boolean;
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
export class ConversationManager implements AgentRuntimeHost {
  private readonly handles = new Map<string, AgentHandle>();
  private readonly agents: AgentRepo;
  private readonly workspaces: WorkspaceRepo;
  private readonly conversations: ConversationRepo;
  private readonly inboxes: ConversationInboxRepo;
  private readonly messages: MessageRepo;
  private readonly notifications: NotificationRepo;
  private readonly users: UserRepo;
  private readonly membership: MembershipService;
  private readonly settings: SettingsRepo;
  private binariesPromise: Promise<Map<string, string>> | null = null;
  /** Legacy test override for all init watchdog windows. Prefer the
   *  phase-specific knobs below in new tests. */
  initWatchdogMs: number | null = null;
  initLivenessSilenceMs: number | null = null;
  initPreProtocolCapMs: number | null = null;
  initPostProtocolMs: number | null = null;
  initMaxRetries = INIT_TIMEOUT_MAX_RETRIES;
  initFailureCooldownThreshold = INIT_FAILURE_COOLDOWN_THRESHOLD;
  initFailureCooldownMs = INIT_FAILURE_COOLDOWN_MS;
  /** Visible-for-testing knobs for stop(hard) escalation delays.
   *  Dialed down in tests so the SIGTERM/SIGKILL fallback path can be
   *  exercised without waiting 5s/10s in real time. */
  stopSigtermMs = 5_000;
  stopSigkillMs = 10_000;
  /** Visible-for-testing knob for `agent_activity` heartbeat cadence. */
  activityHeartbeatMs = AGENT_ACTIVITY_HEARTBEAT_MS;
  private readonly initRetryStates = new Map<string, InitRetryState>();
  private readonly runStates = new Map<string, AgentRunState>();
  private readonly activitySnippetBuffers = new Map<string, ActivitySnippetBuffer>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private activityHeartbeat: NodeJS.Timeout | null = null;
  /** Dedicated JSONL log for agent_activity events — written in addition
   *  to realtime broadcasts so release builds leave a paper trail for debugging. Null
   *  when `ctx.logDir` is not configured (e.g. in tests). */
  private readonly activityLogStream: WriteStream | null;

  constructor(private readonly ctx: BackendContext) {
    this.agents = new AgentRepo(ctx.db);
    this.workspaces = new WorkspaceRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot });
    this.conversations = new ConversationRepo(ctx.db);
    this.inboxes = new ConversationInboxRepo(ctx.db);
    this.messages = new MessageRepo(ctx.db);
    this.notifications = new NotificationRepo(ctx.db);
    this.settings = new SettingsRepo(ctx.db);
    this.users = new UserRepo(ctx.db);
    this.membership = new MembershipService({
      agents: this.agents,
      users: this.users,
      conversations: this.conversations,
    });

    if (ctx.logDir) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const logPath = join(ctx.logDir, `agent-activity-${ts}.log`);
      this.activityLogStream = createWriteStream(logPath, { flags: 'a' });
      this.activityLogStream.on('error', err => {
        // Write failures must never crash the backend or block realtime broadcasts.
        ctx.logger.warn({ err, logPath }, 'agent-activity log write error');
      });
    } else {
      this.activityLogStream = null;
    }
  }

  isRunning(conversationId: string, agentId: string): boolean {
    return this.handles.has(handleKey(conversationId, agentId));
  }

  private async withLifecycleLock<T>(
    conversationId: string,
    agentId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = handleKey(conversationId, agentId);
    const prev = this.lifecycleTails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const next = prev.catch(() => undefined).then(() => current);
    this.lifecycleTails.set(key, next);

    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.lifecycleTails.get(key) === next) {
        this.lifecycleTails.delete(key);
      }
    }
  }

  getAgentRunStates(conversationId: string): AgentRunState[] {
    return Array.from(this.runStates.values()).filter(
      state => state.conversationId === conversationId,
    );
  }

  resolveRun(
    conversationId: string,
    agentId: string,
    reason: AgentRunTerminalReason,
    runId?: string,
  ): void {
    this.resolveRunByKey(handleKey(conversationId, agentId), reason, runId);
  }

  resolveConversationRuns(
    conversationId: string,
    reason: AgentRunTerminalReason = 'conversation_closed',
  ): void {
    for (const state of this.getAgentRunStates(conversationId)) {
      this.resolveRun(state.conversationId, state.agentId, reason, state.runId);
    }
  }

  /**
   * Record a pre-spawn failure (before the child process is created).
   * Writes a notification row, flips conversation_agent status to `crashed`,
   * and publishes an `agent_status` realtime event so the renderer can show
   * an error badge and — once useNotificationToasts is wired — a toast.
   */
  private recordStartFailure(conversationId: string, agentId: string, error: Error): void {
    const agent = this.agents.get(agentId);
    const conversation = this.conversations.get(conversationId);
    // Ensure the conversation_agent row exists so we can update its status.
    let sa = this.conversations.getAgent(conversationId, agentId);
    if (!sa) sa = this.conversations.addAgent(conversationId, agentId);

    this.conversations.updateAgentRuntime(conversationId, agentId, { status: 'crashed', pid: null });

    try {
      this.notifications.insert({
        kind: 'agent_start_failed',
        agentId,
        conversationId: conversationId,
        workspaceId: conversation?.workspace_id ?? null,
        payload: {
          agent_name: agent?.name ?? agentId,
          error: error.message,
          reason: 'spawn_error',
        },
      });
      // Push to the resolved viewer's private scope so notification
      // hooks invalidate without polling. Pre-PR1 hardcoded
      // 'viewer:local'; the registered random-id viewer needs
      // the resolved id.
      const viewerUserId = this.settings.getViewerUserId();
      if (viewerUserId) {
        this.ctx.events.publishToScope(`viewer:${viewerUserId}`, 'notification', {
          kind: 'agent_start_failed',
          conversation_id: conversationId,
        });
      }
    } catch (e) {
      this.ctx.logger.error({ conversationId, agentId, e }, 'conversation: failed to insert start-failure notification');
    }

    this.ctx.events.publish(conversationId, {
      kind: 'agent_status',
      payload: {
        agent_id: agentId,
        status: 'crashed',
        reason: 'spawn_error',
        error: error.message,
      },
    });
  }

  /**
   * Record a runtime crash from the exit handler (process died with non-zero
   * exit or init watchdog timeout). Does NOT update conversation_agent status —
   * the exit handler already does that. Just writes the notification row.
   */
  private recordCrashNotification(
    conversationId: string,
    agentId: string,
    opts: {
      initTimedOut: boolean;
      exitCode: number | null;
      reason?: string;
      error?: string;
    },
  ): void {
    const agent = this.agents.get(agentId);
    const conversation = this.conversations.get(conversationId);
    const reason = opts.initTimedOut ? 'init_timeout' : opts.reason ?? 'runtime_crash';
    try {
      this.notifications.insert({
        kind: 'agent_start_failed',
        agentId,
        conversationId: conversationId,
        workspaceId: conversation?.workspace_id ?? null,
        payload: {
          agent_name: agent?.name ?? agentId,
          reason,
          exit_code: opts.exitCode,
          ...(opts.error ? { error: opts.error } : {}),
        },
      });
      // Push to the resolved viewer's private scope so notification
      // hooks invalidate without polling. Pre-PR1 hardcoded 'viewer:local'.
      const viewerUserId = this.settings.getViewerUserId();
      if (viewerUserId) {
        this.ctx.events.publishToScope(`viewer:${viewerUserId}`, 'notification', {
          kind: 'agent_start_failed',
          conversation_id: conversationId,
        });
      }
    } catch (e) {
      this.ctx.logger.error({ conversationId, agentId, e }, 'conversation: failed to insert crash notification');
    }
  }

  /**
   * Reconcile DB state with reality on backend boot. Any conversation_agent
   * row marked `starting` / `active` is stale (its child belonged to
   * the previous backend process). For each row:
   *   - if `pid` is non-null AND that pid is still alive, SIGKILL it.
   *     Until 2026-05 the Electron `before-quit` handler returned its
   *     async work as a Promise that Electron didn't await, so the
   *     parent could exit while children were still being asked to
   *     stop — leaving orphan claude/codex processes
   *     alive. Without this kill step a fresh `start()` would spawn
   *     a duplicate (codex would then fail with `thread not found`
   *     because the orphan still owns the thread server-side).
   *   - flip status to `idle`. Keep `cli_session_id` so a subsequent
   *     `start()` passes `--resume` and the agent picks up its prior
   *     CLI conversation.
   *
   * No auto-spawn here per §3.1: agents wake only when a user opens the
   * conversation or sends to them. The UI / route layer triggers `start()`.
   */
  reconcileOnBoot(): void {
    const stale = this.conversations.listLiveStatusAgents();
    if (stale.length === 0) return;
    let killed = 0;
    for (const sa of stale) {
      if (sa.pid !== null && sa.pid > 0) {
        // PID recycle is a theoretical risk (some unrelated process
        // could have reused this pid since the prior boot), but in
        // practice silverhand restarts happen within seconds-to-minutes
        // and macOS doesn't wrap pids that fast. We accept the risk
        // for now — a stale-but-alive agent is the higher-frequency,
        // higher-impact failure mode.
        try {
          process.kill(sa.pid, 0); // probe — throws ESRCH if dead
          process.kill(sa.pid, 'SIGKILL');
          killed += 1;
          this.ctx.logger.warn(
            { conversationId: sa.conversation_id, agentId: sa.agent_id, pid: sa.pid },
            'reconcile: SIGKILL\'d orphaned agent process from prior boot',
          );
        } catch (err) {
          // ESRCH = already dead. Anything else (EPERM etc.) we log
          // and move on — better than letting the boot fail entirely.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') {
            this.ctx.logger.warn(
              { conversationId: sa.conversation_id, agentId: sa.agent_id, pid: sa.pid, err },
              'reconcile: failed to kill orphan pid',
            );
          }
        }
      }
      this.conversations.updateAgentRuntime(sa.conversation_id, sa.agent_id, {
        status: 'idle',
        pid: null,
      });
    }
    this.ctx.logger.info(
      { count: stale.length, killed },
      'reconciled stale conversation_agents from prior boot',
    );
  }

  /**
   * Spawn the (conversation, agent) CLI. Idempotent: returns silently if
   * already running. Throws on missing entities or uninstalled runtime.
   *
   * Lifecycle wiring:
   *  - conversation_agents row is upserted (status: starting → active on
   *    `system.init`, → idle/crashed on exit)
   *  - stdout lines flow through driver.parseLine; events fan out to
   *    ctx.events keyed by conversationId
   *  - On exit, handle is removed and temp files are cleaned up
   */
  /**
   * Resolve the registered viewer's mention handle, used as the
   * fallback `sender=` value when a user message has a null
   * `from_user_id` (legacy pre-PR-A rows) or its `from_user_id` no
   * longer resolves. Returns `undefined` when registration hasn't
   * completed yet — callers degrade to the bare token `user`.
   */
  private resolveDefaultUserHandle(): string | undefined {
    const viewerId = this.settings.getViewerUserId();
    if (!viewerId) return undefined;
    return this.users.get(viewerId)?.name ?? undefined;
  }

  async start(conversationId: string, agentId: string, opts: StartOptions = {}): Promise<void> {
    return this.startWithLifecycleLock(conversationId, agentId, opts, 0);
  }

  private async startWithLifecycleLock(
    conversationId: string,
    agentId: string,
    opts: StartOptions = {},
    initAttempt = 0,
  ): Promise<void> {
    return this.withLifecycleLock(conversationId, agentId, () =>
      this.startUnlocked(conversationId, agentId, opts, initAttempt),
    );
  }

  private async startUnlocked(
    conversationId: string,
    agentId: string,
    opts: StartOptions = {},
    initAttempt = 0,
  ): Promise<void> {
    const key = handleKey(conversationId, agentId);
    if (this.handles.has(key)) {
      this.ctx.logger.info(
        { conversationId, agentId },
        'conversation: start no-op, already running',
      );
      return;
    }

    if (initAttempt === 0 && this.isInitCoolingDown(conversationId, agentId)) {
      this.publishInitCooldown(conversationId, agentId);
      return;
    }

    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`conversation ${conversationId} not found`);
    if (conversation.closed_at !== null) {
      throw new Error(`conversation ${conversationId} is closed`);
    }
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const workspace = this.workspaces.get(conversation.workspace_id);
    if (!workspace) throw new Error(`workspace ${conversation.workspace_id} not found`);

    // Make sure the join row exists (callers may have skipped addAgent).
    let sessionAgent = this.conversations.getAgent(conversationId, agentId);
    if (!sessionAgent) sessionAgent = this.conversations.addAgent(conversationId, agentId);

    const driver = getDriver(agent.runtime);
    const binary = await this.resolveBinary(agent.runtime);
    if (!binary) {
      const err = new Error(
        `runtime '${agent.runtime}' is not installed (no binary on PATH)`,
      );
      this.ctx.logger.error(
        { conversationId, agentId, runtime: agent.runtime },
        "conversation: runtime binary not found on PATH",
      );
      this.recordStartFailure(conversationId, agentId, err);
      throw err;
    }

    // Synthesize prompt + write spawn files.
    const agentToken = this.ctx.agentTokens.issue(conversationId, agentId);
    const promptCtx = await this.buildPromptContext(conversation, workspace, agent);
    const systemPromptText = buildSystemPromptFor(driver.kind, promptCtx);
    const spawnPrep = await prepareSpawnFiles({
      conversationId,
      agentId,
      systemPromptText,
      silverhandCli: this.ctx.silverhandCliLauncher,
    });

    // For oneShot drivers, the inbox can't be drained over stdin —
    // there is no persistent stdin loop. So we drain it now and pass
    // the formatted text to the driver as `initialPrompt` (which will
    // become argv content for cursor-agent).
    let initialPrompt = '';
    let preDrainedInboxIds: number[] = [];
    if (driver.oneShot) {
      const items = this.inboxes.listPending(conversationId, agentId);
      if (items.length > 0) {
        initialPrompt = formatInboxBatch(
          items,
          id => this.agents.get(id)?.name,
          id => this.users.get(id)?.name,
          this.resolveDefaultUserHandle(),
          agent.name,
          sendMessageToolName(driver),
        );
        preDrainedInboxIds = items.map(i => i.inboxId);
      }
    }
    const hasKickoffInbox =
      preDrainedInboxIds.length > 0 ||
      (!driver.oneShot && this.inboxes.listPending(conversationId, agentId).length > 0);
    // Claude Code's stream-json init is tied to the first real user turn:
    // with empty stdin it may emit protocol noise such as `hook_started`, but
    // it will not emit `system.init`. Sending an artificial primer would create
    // a real API turn and transcript entry, so empty-inbox Claude starts as a
    // live process and arms the init watchdog only when we later write a real
    // inbox/direct message. If a timeout retry gets here, keep the watchdog
    // armed even with an empty inbox; otherwise a failed first-use attempt could
    // silently turn into an unguarded active process.
    const deferInitWatchdog =
      initAttempt === 0 &&
      driver.kickoffMode === 'requires_first_message' &&
      !hasKickoffInbox;

    const spawnCtx: DriverSpawnContext = {
      agentId,
      agentName: agent.name,
      workspacePath: conversation.workspace_path,
      cliSessionId: sessionAgent.cli_session_id,
      model: opts.model ?? agent.model,
      reasoningEffort: agent.reasoning_effort,
      fastMode: agent.fast_mode,
      systemPromptPath: spawnPrep.systemPromptPath,
      initialPrompt,
    };

    const args = driver.buildArgs(spawnCtx);
    // Spawn env composition moved into a shared helper so the
    // daemon-path (`RuntimeBridge`) can build the same env from the
    // same inputs. Behavior is byte-equivalent to the prior inline
    // `withSilverhandCliEnv(applyProxySetting(driver.applyEnv(process.env), runtime), {...})`.
    const env = buildAgentSpawnEnv({
      driver,
      runtime: agent.runtime,
      conversationId,
      agentId,
      serverUrl: this.ctx.serverConfig.url,
      token: agentToken,
      binDir: spawnPrep.binDir,
      baseProcessEnv: process.env,
      proxySettings: {
        get: (key: 'proxy_url' | 'proxy_runtimes') => this.settings.get(key),
      },
    });

    this.ctx.logger.info(
      { conversationId, agentId, runtime: agent.runtime, binary, args },
      'conversation: spawning agent',
    );

    const child = spawn(binary, args, {
      cwd: conversation.workspace_path,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const rl = createInterface({ input: child.stdout });

    const handle: AgentHandle = {
      conversationId,
      agentId,
      driver,
      child,
      rl,
      spawnPrep,
      agentToken,
      cliSessionId: sessionAgent.cli_session_id,
      initObserved: false,
      busy: { outstandingToolUses: 0, compacting: false },
      pendingTurnEnd: false,
      pendingDeliveries: [],
      compactionWatchdog: null,
      initLivenessSilenceWatchdog: null,
      initPreProtocolCapWatchdog: null,
      initPostProtocolWatchdog: null,
      initWatchdogArmed: false,
      initStartedAt: Date.now(),
      initProtocolObserved: false,
      initAttempt,
      initRetryPlanned: false,
      initTimeoutReason: null,
      initTimedOut: false,
      fatalError: null,
      crashNotificationRecorded: false,
      intentionallyStopped: false,
      drainChain: Promise.resolve(),
      initPendingInboxIds: [],
    };
    this.handles.set(key, handle);

    const spawnStatus = deferInitWatchdog ? 'active' : 'starting';
    this.conversations.updateAgentRuntime(conversationId, agentId, {
      status: spawnStatus,
      pid: child.pid ?? null,
    });
    this.publish(conversationId, 'agent_status', {
      agent_id: agentId,
      status: spawnStatus,
      pid: child.pid ?? null,
      ...(deferInitWatchdog
        ? {
            reason: 'awaiting_first_message',
          }
        : {}),
      ...(!deferInitWatchdog && initAttempt > 0
        ? {
            reason: 'init_timeout_retrying',
            retry_attempt: initAttempt,
            max_retries: this.initMaxRetries,
          }
        : {}),
    });
    if (hasKickoffInbox) {
      this.startRun(handle, 'starting');
    }

    // Arm before stdin is primed so a child that hangs on the very first
    // read still hits the timeout. Runtimes that require a first user message
    // (Claude stream-json) defer this until ConversationManager actually
    // writes a real stdin message; their empty-inbox armed state is a live
    // process waiting for input, not an init failure.
    if (!deferInitWatchdog) this.startInitWatchdog(handle);

    child.stdout.on('data', () => {
      this.refreshInitLiveness(handle);
    });

    rl.on('line', line => {
      this.touchRunActivity(handle);
      this.observeInitProgress(handle, line);
      const events = driver.parseLine(line);
      for (const ev of events) this.handleParsedEvent(handle, ev);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      this.refreshInitLiveness(handle);
      const text = chunk.toString();
      // Surface stderr to logs; not modeled as a chat event.
      this.ctx.logger.warn({ conversationId, agentId, text }, 'agent stderr');
    });

    child.on('error', err => {
      this.ctx.logger.error({ conversationId, agentId, err }, 'agent process error');
    });

    child.on('exit', (code, signal) => {
      this.ctx.logger.info(
        { conversationId, agentId, code, signal },
        'agent process exited',
      );
      if (
        handle.initTimedOut &&
        handle.initRetryPlanned &&
        !handle.intentionallyStopped &&
        !handle.fatalError
      ) {
        this.conversations.updateAgentRuntime(conversationId, agentId, {
          status: 'starting',
          pid: null,
        });
        this.publish(conversationId, 'agent_status', {
          agent_id: agentId,
          status: 'starting',
          pid: null,
          reason: 'init_timeout_retrying',
          retry_attempt: handle.initAttempt + 1,
          max_retries: this.initMaxRetries,
          timeout_reason: handle.initTimeoutReason,
        });
        this.handles.delete(key);
        this.ctx.agentTokens.revoke(handle.agentToken);
        this.clearCompactionWatchdog(handle);
        this.clearInitWatchdog(handle);
        rl.close();
        void spawnPrep.cleanup();
        this.startWithLifecycleLock(
          conversationId,
          agentId,
          opts,
          handle.initAttempt + 1,
        ).catch(
          err =>
            this.ctx.logger.error(
              { conversationId, agentId, err },
              'init watchdog retry failed to start agent',
            ),
        );
        return;
      }
      // initTimedOut/fatalError win over intentionallyStopped — in
      // both cases we explicitly killed the child because the runtime
      // became unusable, which is a crash from the user's POV.
      const fatalReason = handle.fatalError?.reason;
      const fatalError = handle.fatalError?.error;
      const status: 'idle' | 'crashed' =
        handle.initTimedOut || handle.fatalError
          ? 'crashed'
          : handle.intentionallyStopped || code === 0
            ? 'idle'
            : 'crashed';
      this.conversations.updateAgentRuntime(conversationId, agentId, {
        status,
        pid: null,
      });
      this.publish(conversationId, 'agent_status', {
        agent_id: agentId,
        status,
        exit_code: code,
        signal,
        ...(handle.initTimedOut
          ? {
              reason: 'init_timeout',
              timeout_reason: handle.initTimeoutReason,
              ...(this.isInitCoolingDown(conversationId, agentId)
                ? { cooldown_until: this.initRetryStates.get(key)?.cooldownUntil }
                : {}),
            }
          : {}),
        ...(fatalReason ? { reason: fatalReason, error: fatalError } : {}),
      });
      // Write a persistent notification for unexpected crashes so the
      // global toast hook can alert the user even if they aren't watching
      // this conversation's realtime stream.
      if (
        status === 'crashed' &&
        !handle.intentionallyStopped &&
        !handle.crashNotificationRecorded
      ) {
        handle.crashNotificationRecorded = true;
        this.recordCrashNotification(conversationId, agentId, {
          initTimedOut: handle.initTimedOut,
          exitCode: code,
          reason: fatalReason,
          error: fatalError,
        });
      }
      this.resolveRunByKey(
        key,
        handle.initTimedOut
          ? 'timeout'
          : status === 'crashed'
            ? 'crashed'
            : handle.intentionallyStopped
              ? 'stopped'
              : 'replied',
      );
      this.handles.delete(key);
      this.ctx.agentTokens.revoke(handle.agentToken);
      this.clearCompactionWatchdog(handle);
      this.clearInitWatchdog(handle);
      rl.close();
      void spawnPrep.cleanup();

      // OneShot drivers (cursor) exit after each turn. If new messages
      // arrived in the inbox while the agent was running, respawn so
      // they actually get processed — otherwise they sit forever.
      // Don't respawn if we just timed out at init: looping into the
      // same hang would burn cycles and pollute the UI with crashes.
      if (
        driver.oneShot &&
        !handle.intentionallyStopped &&
        !handle.initTimedOut &&
        !handle.fatalError &&
        this.inboxes.listPending(conversationId, agentId).length > 0
      ) {
        this.start(conversationId, agentId, opts).catch(err =>
          this.ctx.logger.error(
            { conversationId, agentId, err },
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
        this.markRunThinking(handle);
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
        { conversationId, agentId, err },
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
   *
   * Hard mode awaits the child's actual `exit` event before returning.
   * Callers (notably the Electron `before-quit` shutdown path) rely on
   * this to know the spawn graph is gone — returning before exit was
   * the bug that left orphan claude/codex processes alive
   * across app restarts.
   */
  async stop(
    conversationId: string,
    agentId: string,
    mode: 'soft' | 'hard' = 'hard',
    softDirective?: string,
  ): Promise<void> {
    return this.withLifecycleLock(conversationId, agentId, () =>
      this.stopUnlocked(conversationId, agentId, mode, softDirective),
    );
  }

  private async stopUnlocked(
    conversationId: string,
    agentId: string,
    mode: 'soft' | 'hard' = 'hard',
    softDirective?: string,
  ): Promise<void> {
    const key = handleKey(conversationId, agentId);
    const h = this.handles.get(key);
    if (!h) return;

    if (mode === 'soft') {
      const directive =
        softDirective ??
        '[user requested a course correction — pause your current direction and ' +
          'wait for the next instruction]';
      await this.writeUserMessage(h, directive, false).catch(err =>
        this.ctx.logger.warn(
          { conversationId, agentId, err },
          'soft interrupt write failed',
        ),
      );
      return;
    }

    // hard: control_request first, then process signals as fallback.
    h.intentionallyStopped = true;
    this.resolveRunByKey(key, 'stopped');
    // No point waiting for an init that the user clearly doesn't want.
    this.clearInitWatchdog(h);

    // Arm the exit promise and the signal timers BEFORE writing the
    // control_request. writeLine depends on stdin write callbacks / drain
    // events — if the child or its stdio is wedged those may never settle,
    // which would block the timers from firing. By registering timers first
    // we guarantee the SIGTERM/SIGKILL fallback always runs regardless of
    // the protocol layer's health.
    const exited = new Promise<void>(resolve => {
      if (h.child.exitCode !== null || h.child.signalCode !== null) {
        resolve();
        return;
      }
      h.child.once('exit', () => resolve());
    });

    // Escalation timers are NOT `.unref()`'d: we await `exited` below
    // and the timers must keep the event loop alive long enough to fire.
    // They self-clear in the finally block (or on child exit the kill
    // calls are no-ops because the handle is already gone from the map).
    const sigtermTimer = setTimeout(() => {
      if (!this.handles.has(key)) return;
      this.ctx.logger.info(
        { conversationId, agentId },
        'hard stop: control_request didn\'t exit, sending SIGTERM',
      );
      h.child.kill('SIGTERM');
    }, this.stopSigtermMs);
    const sigkillTimer = setTimeout(() => {
      if (this.handles.has(key)) {
        this.ctx.logger.warn(
          { conversationId, agentId },
          'hard stop: SIGTERM did not exit, sending SIGKILL',
        );
        h.child.kill('SIGKILL');
      }
    }, this.stopSigkillMs);

    // Best-effort: send the driver-level interrupt so the CLI can exit
    // cleanly. Fire-and-forget — we never await this; if stdin is wedged
    // the timers above take over.
    const interruptLine = h.driver.encodeInterruptControl();
    if (interruptLine) {
      void this.writeLine(h, interruptLine).catch(err =>
        this.ctx.logger.warn(
          { conversationId, agentId, err },
          'interrupt control write failed; signals will handle shutdown',
        ),
      );
    }

    try {
      await exited;
    } finally {
      clearTimeout(sigtermTimer);
      clearTimeout(sigkillTimer);
    }
  }

  async clearSession(
    conversationId: string,
    agentId: string,
    actorUserId: string | null = null,
  ): Promise<ClearSessionResult> {
    return this.withLifecycleLock(conversationId, agentId, () =>
      this.clearSessionUnlocked(conversationId, agentId, actorUserId),
    );
  }

  private async clearSessionUnlocked(
    conversationId: string,
    agentId: string,
    actorUserId: string | null,
  ): Promise<ClearSessionResult> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`conversation ${conversationId} not found`);
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const existing = this.conversations.getAgent(conversationId, agentId);
    if (!existing) {
      throw new Error(`agent ${agentId} is not a member of conversation ${conversationId}`);
    }

    const wasRunning = this.handles.has(handleKey(conversationId, agentId));
    if (wasRunning) {
      await this.stopUnlocked(conversationId, agentId, 'hard');
    }

    const beforeClear = this.conversations.getAgent(conversationId, agentId) ?? existing;
    const prevCliSessionId = beforeClear.cli_session_id;
    const shouldAudit = wasRunning || prevCliSessionId !== null;
    const { updated, auditMessage } = this.ctx.db.transaction(() => {
      const updated = this.conversations.updateAgentRuntime(conversationId, agentId, {
        cliSessionId: null,
      });
      if (!updated) {
        throw new Error(
          `agent ${agentId} is not a member of conversation ${conversationId}`,
        );
      }
      const auditMessage = shouldAudit
        ? this.insertSessionClearedAuditMessage({
            conversationId,
            agentId,
            agentName: agent.name,
            actorUserId,
            prevCliSessionId,
            wasRunning,
          })
        : null;
      return { updated, auditMessage };
    })();
    this.publish(conversationId, 'agent_status', {
      agent_id: agentId,
      status: updated.status,
      pid: updated.pid,
      cli_session_id: null,
    });

    if (auditMessage) {
      await this.publishAndDeliverSessionClearedAudit(
        conversationId,
        agentId,
        auditMessage,
      );
    }

    return { prevCliSessionId, wasRunning };
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

  /**
   * Flush and close the dedicated activity log stream. Must be called
   * after `stopAll()` so terminal events (idle/failed) are written first.
   * Safe to call when `logDir` is not configured — resolves immediately.
   */
  async closeActivityLog(): Promise<void> {
    if (!this.activityLogStream) return;
    return new Promise<void>((resolve, reject) => {
      this.activityLogStream!.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ── internals ──────────────────────────────────────────────────────

  private insertSessionClearedAuditMessage(params: {
    conversationId: string;
    agentId: string;
    agentName: string;
    actorUserId: string | null;
    prevCliSessionId: string | null;
    wasRunning: boolean;
  }): MessageDto {
    const actor = params.actorUserId ? `@${params.actorUserId}` : 'A user';
    const prevLabel = params.prevCliSessionId
      ? `${params.prevCliSessionId.slice(0, 8)}...`
      : 'none';
    return this.messages.insertForConversation({
      conversationId: params.conversationId,
      fromKind: 'system',
      fromUserId: params.actorUserId,
      content:
        `${actor} cleared @${params.agentName}'s CLI session context ` +
        `(prev session: ${prevLabel}). Next start will use a fresh session; ` +
        'pending deliveries remain queued.',
      metadata: {
        subtype: systemSubtype('session_cleared'),
        agent_id: params.agentId,
        agent_name: params.agentName,
        actor_user_id: params.actorUserId,
        previous_cli_session_id_prefix: params.prevCliSessionId
          ? params.prevCliSessionId.slice(0, 8)
          : null,
        was_running: params.wasRunning,
      },
    });
  }

  private async publishAndDeliverSessionClearedAudit(
    conversationId: string,
    clearedAgentId: string,
    message: MessageDto,
  ): Promise<void> {
    this.publish(conversationId, 'message', { message });
    for (const ca of this.conversations.listAgents(conversationId)) {
      if (ca.agent_id === clearedAgentId) continue;
      await this.deliverMessage(conversationId, ca.agent_id, message.id).catch(err =>
        this.ctx.logger.warn(
          { conversationId, agentId: ca.agent_id, messageId: message.id, err },
          'session clear audit delivery failed',
        ),
      );
    }
  }

  private handleParsedEvent(handle: AgentHandle, ev: ParsedEvent): void {
    const { conversationId, agentId } = handle;
    switch (ev.kind) {
      case 'session_init':
        // claude --input-format stream-json emits {type:'system',
        // subtype:'init', session_id} at the start of EVERY user-message
        // turn cycle, not just once at process startup. Dedup by a
        // per-process flag rather than by cliSessionId equality —
        // resuming an existing thread preloads cliSessionId from DB,
        // and the resumed CLI emits the same id, so equality-dedup
        // would silently skip the first init's side effects and leave
        // the row in `starting` forever.
        if (handle.initObserved) break;
        handle.initObserved = true;
        handle.cliSessionId = ev.sessionId;
        this.clearInitRetryState(conversationId, agentId);
        // First init landed → cancel the watchdog. Subsequent inits
        // short-circuit above, so this only fires once.
        this.clearInitWatchdog(handle);
        this.conversations.updateAgentRuntime(conversationId, agentId, {
          status: 'active',
          cliSessionId: ev.sessionId,
        });
        this.publish(conversationId, 'agent_status', {
          agent_id: agentId,
          status: 'active',
          cli_session_id: ev.sessionId,
        });
        this.ctx.logger.info(
          { conversationId, agentId, cliSessionId: ev.sessionId },
          'agent: session_init received, status → active',
        );
        this.markInitPendingInboxDelivered(handle);
        // §3.1 C: spawn-time inbox drain. Anything queued while the
        // agent was asleep gets injected now as one stdin user message.
        this.drainInbox(handle).catch(err =>
          this.ctx.logger.error(
            { conversationId, agentId, err },
            'inbox drain failed',
          ),
        );
        break;
      case 'tool_call':
        handle.busy.outstandingToolUses += 1;
        this.recordToolCall(handle, ev.name);
        this.ctx.logger.info(
          {
            conversationId,
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
        this.recordToolOutput(handle);
        break;
      case 'turn_end':
        handle.busy.outstandingToolUses = 0;
        handle.pendingTurnEnd = true;
        this.ctx.logger.info(
          { conversationId, agentId, pendingDeliveries: handle.pendingDeliveries.length },
          'agent: turn_end',
        );
        this.tryResolveTurnEndAtBoundary(handle);
        void this.flushPending(handle);
        break;
      case 'compaction_started':
        handle.busy.compacting = true;
        this.recordCompactionStarted(handle);
        this.ctx.logger.info({ conversationId, agentId }, 'agent: compaction_started');
        this.startCompactionWatchdog(handle);
        break;
      case 'compaction_finished':
        handle.busy.compacting = false;
        this.ctx.logger.info({ conversationId, agentId }, 'agent: compaction_finished');
        this.clearCompactionWatchdog(handle);
        this.recordCompactionFinished(handle);
        this.tryResolveTurnEndAtBoundary(handle);
        void this.flushPending(handle);
        break;
      case 'error':
        this.ctx.logger.warn(
          { conversationId, agentId, event: ev },
          'agent: parsed error event from CLI',
        );
        if (ev.fatal && ev.code === 'thread_not_found') {
          this.handleFatalRuntimeError(handle, ev.code, ev.message);
        }
        break;
      case 'thinking':
        this.recordActivitySnippet(handle, 'thinking', ev.text);
        break;
      case 'text':
        this.recordActivitySnippet(handle, 'text', ev.text);
        break;
      case 'unknown':
        break;
    }
    // Fan out everything (including state-affecting events) to UI. Keep the
    // raw event useful for diagnostics, but do not let large tool inputs sit in
    // the WS replay buffer / Events window.
    this.publish(conversationId, 'agent_event', {
      agent_id: agentId,
      event: sanitizeParsedEventForBroadcast(ev),
    });
  }

  private handleFatalRuntimeError(
    handle: AgentHandle,
    reason: string,
    error: string,
  ): void {
    if (handle.fatalError) return;
    const { conversationId, agentId } = handle;
    const key = handleKey(conversationId, agentId);

    handle.fatalError = { reason, error };
    this.clearInitWatchdog(handle);
    this.conversations.updateAgentRuntime(conversationId, agentId, {
      status: 'crashed',
      pid: null,
      cliSessionId: null,
    });
    this.publish(conversationId, 'agent_status', {
      agent_id: agentId,
      status: 'crashed',
      reason,
      error,
    });
    this.resolveRunByKey(key, 'crashed');

    if (!handle.crashNotificationRecorded) {
      handle.crashNotificationRecorded = true;
      this.recordCrashNotification(conversationId, agentId, {
        initTimedOut: false,
        exitCode: null,
        reason,
        error,
      });
    }

    handle.child.kill('SIGTERM');
    setTimeout(() => {
      if (this.handles.has(key)) handle.child.kill('SIGKILL');
    }, 5_000).unref();
  }

  private publish(conversationId: string, kind: string, payload: unknown): void {
    this.ctx.events.publish(conversationId, { kind, payload });
  }

  private startRun(
    handle: AgentHandle,
    status: Extract<AgentRunStatus, 'starting' | 'thinking'>,
    detail?: string,
  ): AgentRunState {
    const key = handleKey(handle.conversationId, handle.agentId);
    const previous = this.runStates.get(key);
    if (previous) {
      this.publishTerminalRunState(previous, 'replaced');
      this.clearActivitySnippetBuffer(key, previous.runId);
    }
    handle.pendingTurnEnd = false;

    const now = Date.now();
    const state: AgentRunState = {
      runId: randomUUID(),
      agentId: handle.agentId,
      conversationId: handle.conversationId,
      status,
      startedAt: now,
      updatedAt: now,
      lastActivityAt: now,
      ...(detail ? { detail } : {}),
    };
    this.runStates.set(key, state);
    this.publishAgentActivity(state);
    this.ensureActivityHeartbeat();
    return state;
  }

  private markRunThinking(handle: AgentHandle): void {
    const key = handleKey(handle.conversationId, handle.agentId);
    const current = this.runStates.get(key);
    if (current) {
      this.updateRun(handle, {
        status: 'thinking',
        detail: undefined,
        lastActivityAt: Date.now(),
      });
      return;
    }
    this.startRun(handle, 'thinking');
  }

  private ensureRunForActivityEvent(handle: AgentHandle): AgentRunState {
    const key = handleKey(handle.conversationId, handle.agentId);
    return this.runStates.get(key) ?? this.startRun(handle, 'thinking');
  }

  private touchRunActivity(handle: AgentHandle): void {
    this.updateRun(handle, { lastActivityAt: Date.now() });
  }

  private updateRun(
    handle: AgentHandle,
    patch: Partial<
      Pick<
        AgentRunState,
        | 'status'
        | 'detail'
        | 'lastActivityAt'
        | 'activitySnippet'
        | 'toolCallCounts'
        | 'compacting'
        | 'compactingSince'
        | 'compactionStale'
      >
    >,
  ): AgentRunState | null {
    const key = handleKey(handle.conversationId, handle.agentId);
    const current = this.runStates.get(key);
    if (!current) return null;
    const next: AgentRunState = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    };
    this.runStates.set(key, next);
    this.publishAgentActivity(next);
    return next;
  }

  private recordToolCall(handle: AgentHandle, toolName: string): void {
    const key = handleKey(handle.conversationId, handle.agentId);
    const current =
      this.runStates.get(key) ?? this.ensureRunForActivityEvent(handle);
    const toolCallCounts =
      toolName === sendMessageToolName(handle.driver)
        ? current?.toolCallCounts
        : incrementToolCount(current?.toolCallCounts, toolName);
    this.updateRun(handle, {
      status: 'tool_running',
      detail: toolName,
      ...(toolCallCounts ? { toolCallCounts } : {}),
    });
  }

  private recordToolOutput(handle: AgentHandle): void {
    if (handle.busy.outstandingToolUses !== 0) return;
    this.ensureRunForActivityEvent(handle);
    this.updateRun(handle, { status: 'thinking', detail: undefined });
    this.tryResolveTurnEndAtBoundary(handle);
  }

  private recordCompactionStarted(handle: AgentHandle): void {
    this.ensureRunForActivityEvent(handle);
    this.updateRun(handle, {
      compacting: true,
      compactingSince: Date.now(),
      compactionStale: false,
      lastActivityAt: Date.now(),
    });
  }

  private recordCompactionFinished(handle: AgentHandle): void {
    this.updateRun(handle, {
      compacting: false,
      compactingSince: undefined,
      compactionStale: false,
      lastActivityAt: Date.now(),
    });
  }

  private recordCompactionStale(handle: AgentHandle): void {
    this.updateRun(handle, {
      compactionStale: true,
      lastActivityAt: Date.now(),
    });
  }

  private recordActivitySnippet(
    handle: AgentHandle,
    kind: ActivitySnippetKind,
    text: string,
  ): void {
    const state = this.ensureRunForActivityEvent(handle);
    const key = handleKey(handle.conversationId, handle.agentId);
    const activitySnippet = this.appendActivitySnippetBuffer(
      key,
      state.runId,
      kind,
      text,
    );
    this.updateRun(
      handle,
      activitySnippet ? { activitySnippet } : { status: 'thinking' },
    );
  }

  private appendActivitySnippetBuffer(
    key: string,
    runId: string,
    kind: ActivitySnippetKind,
    text: string,
  ): string | undefined {
    const current = this.activitySnippetBuffers.get(key);
    const nextText =
      current?.runId === runId && current.kind === kind
        ? `${current.text}${text}`
        : text;
    const boundedText =
      nextText.length <= ACTIVITY_SNIPPET_BUFFER_MAX_CHARS
        ? nextText
        : nextText.slice(-ACTIVITY_SNIPPET_BUFFER_MAX_CHARS);
    this.activitySnippetBuffers.set(key, { runId, kind, text: boundedText });
    return trimActivitySnippet(boundedText);
  }

  private clearActivitySnippetBuffer(key: string, runId?: string): void {
    const current = this.activitySnippetBuffers.get(key);
    if (!current) return;
    if (runId && current.runId !== runId) return;
    this.activitySnippetBuffers.delete(key);
  }

  private publishTerminalRunState(
    state: AgentRunState,
    reason: AgentRunTerminalReason,
  ): AgentRunState {
    const now = Date.now();
    const terminal: AgentRunState = {
      ...state,
      status: terminalStatus(reason),
      updatedAt: now,
      lastActivityAt: now,
      terminalReason: reason,
    };
    this.publishAgentActivity(terminal);
    return terminal;
  }

  private tryResolveTurnEndAtBoundary(handle: AgentHandle): boolean {
    if (!handle.pendingTurnEnd) return false;
    if (handle.pendingDeliveries.length > 0 || !isSafeBoundary(handle)) {
      return false;
    }
    handle.pendingTurnEnd = false;
    this.resolveRunByKey(
      handleKey(handle.conversationId, handle.agentId),
      'turn_ended',
    );
    return true;
  }

  private resolveRunByKey(
    key: string,
    reason: AgentRunTerminalReason,
    runId?: string,
  ): void {
    const current = this.runStates.get(key);
    if (!current) return;
    if (runId && current.runId !== runId) return;
    this.publishTerminalRunState(current, reason);
    this.runStates.delete(key);
    this.clearActivitySnippetBuffer(key, current.runId);
    const handle = this.handles.get(key);
    if (handle) handle.pendingTurnEnd = false;
    this.stopActivityHeartbeatIfIdle();
  }

  private publishAgentActivity(state: AgentRunState): void {
    this.publish(state.conversationId, 'agent_activity', state);
    if (this.activityLogStream) {
      // Write a compact JSONL entry with the fields most useful for debugging.
      // Fire-and-forget — stream errors are handled by the 'error' listener
      // on the stream; we never let a log failure propagate to the caller.
      const entry = JSON.stringify({
        ts: new Date().toISOString(),
        conversationId: state.conversationId,
        agentId: state.agentId,
        runId: state.runId,
        status: state.status,
        lastActivityAt: state.lastActivityAt,
        ...(state.toolCallCounts && Object.keys(state.toolCallCounts).length
          ? { toolCallCounts: state.toolCallCounts }
          : {}),
        ...(state.activitySnippet ? { activitySnippet: state.activitySnippet } : {}),
        ...(state.compacting ? { compacting: state.compacting } : {}),
        ...(state.compactingSince ? { compactingSince: state.compactingSince } : {}),
        ...(state.compactionStale ? { compactionStale: state.compactionStale } : {}),
        ...(state.terminalReason ? { terminalReason: state.terminalReason } : {}),
      });
      this.activityLogStream.write(entry + '\n');
    }
  }

  private ensureActivityHeartbeat(): void {
    if (this.activityHeartbeat) return;
    this.activityHeartbeat = setInterval(() => {
      const now = Date.now();
      for (const [key, state] of this.runStates) {
        // A run state without a live handle should be terminal already.
        // Resolve it defensively so reconnect snapshots cannot revive a
        // spinner after the process disappeared through an unexpected path.
        if (!this.handles.has(key)) {
          this.resolveRunByKey(key, 'crashed');
          continue;
        }
        const next: AgentRunState = { ...state, updatedAt: now };
        this.runStates.set(key, next);
        this.publishAgentActivity(next);
      }
      this.stopActivityHeartbeatIfIdle();
    }, this.activityHeartbeatMs);
    this.activityHeartbeat.unref?.();
  }

  private stopActivityHeartbeatIfIdle(): void {
    if (this.runStates.size > 0 || !this.activityHeartbeat) return;
    clearInterval(this.activityHeartbeat);
    this.activityHeartbeat = null;
  }

  private async buildPromptContext(
    conversation: ConversationDto,
    workspace: WorkspaceDto,
    agent: AgentDto,
  ): Promise<DriverPromptContext> {
    const members = this.membership.listMembers(conversation.id);

    let parentSessionTitle: string | null = null;
    let parentChannelConversationId: string | null = null;
    if (conversation.parent_conversation_id) {
      const parent = this.conversations.get(conversation.parent_conversation_id);
      parentSessionTitle = parent?.title ?? null;
      parentChannelConversationId = parent?.id ?? conversation.parent_conversation_id;
    }

    const profile = activeAgentProfileDir(conversation, workspace, agent.id);

    // Role contract: L1-only. The agent's identity is shared across
    // every workspace and lives at `~/.silverhand/agents/<id>/system_prompt.md`.
    // This redirect is the heart of the L1/L2 split — we no longer copy
    // system_prompt.md into the L2 directory, so reading from `profile`
    // here would be wrong for non-DM workspaces.
    const l1Dir = agentL1ProfileDir(this.ctx.silverhandDir, agent.id);
    const roleSystemPrompt = await readFile(
      join(l1Dir, 'system_prompt.md'),
      'utf-8',
    ).catch(() => '');

    // Auto-injected current-workspace MEMORY.md. Capped + truncation-marked
    // so the platform prompt has an upper-bound on the rendered block.
    const currentMemory = await readFileWithCap(
      join(profile.absoluteDir, 'MEMORY.md'),
      MEMORY_INJECT_CAP_BYTES,
    );

    // Workspace-wide consensus, scoped to this workspace's `.silverhand/`.
    // For agent_home (DM workspace), there is exactly one member and no
    // notion of "consensus", so we omit the section entirely. Otherwise,
    // we read CONSENSUS.md with the same discriminated semantics as
    // MEMORY.md — missing renders a create hint, unreadable renders an
    // explicit error.
    const currentConsensus =
      workspace.workspace_kind === 'agent_home'
        ? null
        : await readFileWithCap(
            join(workspace.workspace_path, '.silverhand', 'CONSENSUS.md'),
            CONSENSUS_INJECT_CAP_BYTES,
          );

    // Cross-workspace memory index. Same-host trust model: every workspace
    // returned by `listForAgent` is a workspace this agent already has
    // membership in, and host-equality between agent and workspace is
    // enforced at `addAgentToWorkspace` time as a membership precondition,
    // not filtered here at runtime.
    const workspaceMemoryIndex = this.buildWorkspaceMemoryIndex(agent.id, workspace.id);

    const isThread = conversation.kind === 'thread';

    const sessionContext: SessionContextInput = {
      conversationId: conversation.id,
      channelName: conversation.kind === 'dm_channel' ? conversation.title : workspace.name,
      channelKind: conversation.kind === 'dm_channel' ? 'dm' : 'regular',
      sessionTitle: conversation.title,
      members,
      selfAgentId: agent.id,
      isChildSession: isThread,
      parentSessionTitle,
      parentChannelConversationId,
      isAgentSpawnedChild: conversation.spawned_by_agent_id !== null,
    };

    return {
      agentId: agent.id,
      agentName: agent.name,
      activeProfileDir: profile.promptDir,
      roleSystemPrompt,
      currentMemory,
      currentConsensus,
      workspaceMemoryIndex,
      sessionContext,
    };
  }

  /**
   * Index every workspace this agent is a member of, with the agent's
   * MEMORY.md path inside it. The current workspace's entry is suffixed
   * with " (current)" so the prompt renderer can call out the auto-loaded
   * one without duplicating its name.
   *
   * For agent_home workspaces, the workspace path coincides with the L1
   * agent directory and the agent's MEMORY.md sits at the workspace root.
   * For regular workspaces it lives at
   * `<workspace>/.silverhand/agents/<agentId>/MEMORY.md`.
   */
  private buildWorkspaceMemoryIndex(
    agentId: string,
    currentWorkspaceId: string,
  ): WorkspaceMemoryIndexEntry[] {
    const ws = this.workspaces.listForAgent(agentId);
    return ws.map(w => {
      const dir = agentMemoryDirFor(w, agentId);
      const isCurrent = w.id === currentWorkspaceId;
      const baseLabel = w.workspace_kind === 'agent_home' ? `${w.name} (DM)` : w.name;
      return {
        label: isCurrent ? `${baseLabel} (current)` : baseLabel,
        memoryPath: join(dir, 'MEMORY.md'),
      };
    });
  }

  /**
   * Deliver a message that already exists in the `messages` table to one
   * specific (conversation, agent). The caller wrote the row + decided this
   * agent should see it. We pick the path:
   *
   *   - agent not running       → enqueue to `conversation_inboxes` (drained on
   *                               next spawn, §3.1 C 档)
   *   - direct mode             → write immediately (§3.1 A 档)
   *   - gated mode at boundary  → write immediately
   *   - gated mode mid-turn     → push to handle.pendingDeliveries; flush
   *                               at next safe boundary
   *
   * Caller contract: this method is not safe to call concurrently for the
   * same (conversationId, agentId, messageId). Sync-ordered redelivery is
   * deduped via DB + handle-local checks; interleaved awaits may still race.
   */
  async deliverMessage(conversationId: string, agentId: string, messageId: string): Promise<void> {
    const msg = this.messages.getById(messageId);
    if (!msg) {
      this.ctx.logger.warn(
        { conversationId, agentId, messageId },
        'deliver: messageId not found in messages table',
      );
      return;
    }

    const delivery = this.inboxes.ensureDelivery(conversationId, agentId, messageId);
    if (delivery.deliveredAt !== null) {
      this.ctx.logger.info(
        { conversationId, agentId, messageId, inboxId: delivery.inboxId },
        'deliver: message already delivered to agent; skipping',
      );
      return;
    }

    const handle = this.handles.get(handleKey(conversationId, agentId));
    if (!handle) {
      this.ctx.logger.info(
        { conversationId, agentId, messageId, inboxId: delivery.inboxId },
        'deliver: agent not running, enqueued to inbox',
      );
      // Look up the agent to decide if we need to wake it up: oneShot
      // drivers (cursor) only consume the inbox at spawn time, so they
      // need an explicit kick. start() is idempotent.
      const agent = this.agents.get(agentId);
      if (agent) {
        const driver = getDriver(agent.runtime);
        if (driver.oneShot) {
          this.start(conversationId, agentId).catch(err =>
            this.ctx.logger.error(
              { conversationId, agentId, err },
              'oneShot: auto-start on deliverMessage failed',
            ),
          );
        }
      }
      return;
    }
    if (handle.initPendingInboxIds.includes(delivery.inboxId)) {
      this.ctx.logger.info(
        { conversationId, agentId, messageId, inboxId: delivery.inboxId },
        'deliver: message already written to agent stdin; waiting for init acknowledgement',
      );
      return;
    }
    const text = formatLiveMessage(
      msg,
      id => this.agents.get(id)?.name,
      id => this.users.get(id)?.name,
      this.resolveDefaultUserHandle(),
      this.agents.get(agentId)?.name,
      sendMessageToolName(handle.driver),
    );

    // Drivers that don't accept stdin notifications: enqueue. The
    // oneShot exit handler (or the next manual start) will respawn and
    // drain. Note: handle existence implies the agent IS running, so
    // we don't double-start here — the exit handler covers the
    // race-with-just-finishing case.
    if (handle.driver.busyDeliveryMode === 'none') {
      this.ctx.logger.info(
        { conversationId, agentId, messageId, inboxId: delivery.inboxId },
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
        this.ctx.logger.info(
          { conversationId, agentId, messageId, inboxId: delivery.inboxId },
          'deliver: driver not yet ready (e.g. codex pre-thread); enqueued to inbox',
        );
        return;
      }
      this.ctx.logger.info(
        {
          conversationId,
          agentId,
          messageId,
          mode: handle.driver.busyDeliveryMode,
          bytes: text.length,
        },
        'deliver: writing to agent stdin',
      );
      this.ensureInitWatchdogArmed(handle);
      await this.writeLine(handle, line);
      if (!handle.initObserved && handle.driver.kickoffMode === 'requires_first_message') {
        if (!handle.initPendingInboxIds.includes(delivery.inboxId)) {
          handle.initPendingInboxIds.push(delivery.inboxId);
        }
      } else {
        this.inboxes.markDelivered([delivery.inboxId]);
      }
      if (handle.driver.busyDeliveryMode === 'direct') {
        this.markRunThinking(handle);
      } else {
        this.startRun(handle, 'thinking');
      }
    } else {
      if (!handle.pendingDeliveries.some(item => item.messageId === messageId)) {
        handle.pendingDeliveries.push({
          inboxId: delivery.inboxId,
          messageId,
          text,
        });
      }
      this.ctx.logger.info(
        {
          conversationId,
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
    const texts = batch.map(item => item.text);
    const combined =
      texts.length === 1
        ? texts[0]!
        : combineGatedBatch(texts, sendMessageToolName(handle.driver));
    this.ctx.logger.info(
      {
        conversationId: handle.conversationId,
        agentId: handle.agentId,
        batchSize: batch.length,
        bytes: combined.length,
      },
      'deliver: flushing pending batch at safe boundary',
    );
    await this.writeUserMessage(handle, combined);
    this.inboxes.markDelivered(batch.map(item => item.inboxId));
  }

  private async writeUserMessage(
    handle: AgentHandle,
    content: string,
    trackRun = true,
  ): Promise<void> {
    const line = handle.driver.encodeStdinMessage(content, handle.cliSessionId);
    if (line === null) {
      // Driver doesn't accept stdin notifications. Caller should have
      // routed via the inbox path; getting here is a bug.
      this.ctx.logger.warn(
        { conversationId: handle.conversationId, agentId: handle.agentId },
        'writeUserMessage: driver returned null encoding; dropped',
      );
      return;
    }
    this.ensureInitWatchdogArmed(handle);
    await this.writeLine(handle, line);
    if (trackRun) this.startRun(handle, 'thinking');
  }

  private startCompactionWatchdog(handle: AgentHandle): void {
    this.clearCompactionWatchdog(handle);
    handle.compactionWatchdog = setTimeout(() => {
      handle.compactionWatchdog = null;
      this.recordCompactionStale(handle);
      // Per slock §3.5: stale, but don't kill — just surface it.
      this.publish(handle.conversationId, 'compaction_stale', {
        agent_id: handle.agentId,
        elapsed_ms: COMPACTION_STALE_MS,
      });
      this.ctx.logger.warn(
        { conversationId: handle.conversationId, agentId: handle.agentId },
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

  private startInitWatchdog(handle: AgentHandle): void {
    this.clearInitWatchdog(handle);
    handle.initWatchdogArmed = true;
    handle.initStartedAt = Date.now();
    this.armInitLivenessSilenceWatchdog(handle);
    const timeoutMs = this.initTimeoutFor(
      handle.driver,
      'initPreProtocolCapMs',
      DEFAULT_INIT_PRE_PROTOCOL_CAP_MS,
    );
    handle.initPreProtocolCapWatchdog = setTimeout(() => {
      handle.initPreProtocolCapWatchdog = null;
      this.failInitWatchdog(handle, 'pre_protocol_cap', timeoutMs);
    }, timeoutMs);
  }

  private clearInitWatchdog(handle: AgentHandle): void {
    if (handle.initLivenessSilenceWatchdog) {
      clearTimeout(handle.initLivenessSilenceWatchdog);
      handle.initLivenessSilenceWatchdog = null;
    }
    if (handle.initPreProtocolCapWatchdog) {
      clearTimeout(handle.initPreProtocolCapWatchdog);
      handle.initPreProtocolCapWatchdog = null;
    }
    if (handle.initPostProtocolWatchdog) {
      clearTimeout(handle.initPostProtocolWatchdog);
      handle.initPostProtocolWatchdog = null;
    }
  }

  private armInitLivenessSilenceWatchdog(handle: AgentHandle): void {
    if (handle.initLivenessSilenceWatchdog) {
      clearTimeout(handle.initLivenessSilenceWatchdog);
      handle.initLivenessSilenceWatchdog = null;
    }
    const timeoutMs = this.initTimeoutFor(
      handle.driver,
      'initLivenessSilenceMs',
      DEFAULT_INIT_LIVENESS_SILENCE_MS,
    );
    handle.initLivenessSilenceWatchdog = setTimeout(() => {
      handle.initLivenessSilenceWatchdog = null;
      this.failInitWatchdog(handle, 'silence', timeoutMs);
    }, timeoutMs);
  }

  private refreshInitLiveness(handle: AgentHandle): void {
    if (!handle.initWatchdogArmed) return;
    if (handle.initObserved || handle.initProtocolObserved || handle.initTimedOut) return;
    this.armInitLivenessSilenceWatchdog(handle);
  }

  private observeInitProgress(handle: AgentHandle, line: string): void {
    if (!handle.initWatchdogArmed) return;
    if (handle.initObserved || handle.initTimedOut) return;
    const progress = handle.driver.classifyInitProgress(line);
    if (!progress) return;

    this.markInitProtocolReady(handle);
    if (progress === 'session_ready') this.clearInitWatchdog(handle);
  }

  private markInitProtocolReady(handle: AgentHandle): void {
    if (handle.initProtocolObserved) return;
    handle.initProtocolObserved = true;
    if (handle.initLivenessSilenceWatchdog) {
      clearTimeout(handle.initLivenessSilenceWatchdog);
      handle.initLivenessSilenceWatchdog = null;
    }
    if (handle.initPreProtocolCapWatchdog) {
      clearTimeout(handle.initPreProtocolCapWatchdog);
      handle.initPreProtocolCapWatchdog = null;
    }

    const timeoutMs = this.initTimeoutFor(
      handle.driver,
      'initPostProtocolMs',
      DEFAULT_INIT_POST_PROTOCOL_MS,
    );
    handle.initPostProtocolWatchdog = setTimeout(() => {
      handle.initPostProtocolWatchdog = null;
      this.failInitWatchdog(handle, 'post_protocol', timeoutMs);
    }, timeoutMs);
  }

  private failInitWatchdog(
    handle: AgentHandle,
    reason: InitTimeoutReason,
    timeoutMs: number,
  ): void {
    const key = handleKey(handle.conversationId, handle.agentId);
    if (!this.handles.has(key) || handle.initObserved || handle.initTimedOut) return;

    this.clearInitWatchdog(handle);
    handle.initTimedOut = true;
    handle.initTimeoutReason = reason;
    handle.initRetryPlanned = this.recordInitTimeoutAndShouldRetry(handle);

    const elapsedMs = Date.now() - handle.initStartedAt;
    this.ctx.logger.warn(
      {
        conversationId: handle.conversationId,
        agentId: handle.agentId,
        reason,
        elapsedMs,
        timeoutMs,
        retrying: handle.initRetryPlanned,
      },
      'agent: init watchdog fired; killing child',
    );
    this.publish(handle.conversationId, 'agent_init_timeout', {
      agent_id: handle.agentId,
      reason,
      elapsed_ms: elapsedMs,
      timeout_ms: timeoutMs,
      retrying: handle.initRetryPlanned,
      retry_attempt: handle.initAttempt,
      max_retries: this.initMaxRetries,
      ...(this.isInitCoolingDown(handle.conversationId, handle.agentId)
        ? { cooldown_until: this.initRetryStates.get(key)?.cooldownUntil }
        : {}),
    });
    if (handle.initRetryPlanned) {
      this.publish(handle.conversationId, 'agent_status', {
        agent_id: handle.agentId,
        status: 'starting',
        reason: 'init_timeout_retrying',
        retry_attempt: handle.initAttempt + 1,
        max_retries: this.initMaxRetries,
        timeout_reason: reason,
      });
    }
    handle.child.kill('SIGTERM');
    setTimeout(() => {
      if (this.handles.has(key)) handle.child.kill('SIGKILL');
    }, 5_000).unref();
  }

  private ensureInitWatchdogArmed(handle: AgentHandle): void {
    if (handle.initWatchdogArmed || handle.initObserved || handle.initTimedOut) return;
    // This is the deferred-init transition for runtimes whose first session
    // init is causally downstream of a real stdin user message. Arm before the
    // write so a runtime that accepts the message but never reaches init is
    // still covered by the same liveness/protocol/session timers as spawn-time
    // kickoff inboxes.
    this.startInitWatchdog(handle);
  }

  private markInitPendingInboxDelivered(handle: AgentHandle): void {
    if (handle.initPendingInboxIds.length === 0) return;
    this.inboxes.markDelivered(handle.initPendingInboxIds.splice(0));
  }

  private initTimeoutFor(
    driver: Driver,
    field: InitTimeoutField,
    fallback: number,
  ): number {
    return this.initWatchdogMs ?? this[field] ?? driver[field] ?? fallback;
  }

  private recordInitTimeoutAndShouldRetry(handle: AgentHandle): boolean {
    const key = handleKey(handle.conversationId, handle.agentId);
    const state = this.initRetryStates.get(key) ?? { failures: 0, cooldownUntil: 0 };
    // Failure count is intentionally sticky until a successful init clears it:
    // cooldown expiry permits one more probe, but a fresh failure immediately
    // re-enters cooldown instead of resetting the incident window.
    state.failures += 1;
    if (state.failures >= this.initFailureCooldownThreshold) {
      state.cooldownUntil = Date.now() + this.initFailureCooldownMs;
    }
    this.initRetryStates.set(key, state);
    return (
      state.cooldownUntil <= Date.now() &&
      handle.initAttempt < this.initMaxRetries &&
      !handle.fatalError &&
      !handle.intentionallyStopped
    );
  }

  private clearInitRetryState(conversationId: string, agentId: string): void {
    this.initRetryStates.delete(handleKey(conversationId, agentId));
  }

  private isInitCoolingDown(conversationId: string, agentId: string): boolean {
    const state = this.initRetryStates.get(handleKey(conversationId, agentId));
    if (!state || state.cooldownUntil <= Date.now()) return false;
    return true;
  }

  private publishInitCooldown(conversationId: string, agentId: string): void {
    const key = handleKey(conversationId, agentId);
    const state = this.initRetryStates.get(key);
    const cooldownUntil = state?.cooldownUntil ?? Date.now();
    this.conversations.updateAgentRuntime(conversationId, agentId, {
      status: 'crashed',
      pid: null,
    });
    this.publish(conversationId, 'agent_status', {
      agent_id: agentId,
      status: 'crashed',
      reason: 'init_cooldown',
      cooldown_until: cooldownUntil,
    });
    this.ctx.logger.warn(
      { conversationId, agentId, cooldownUntil },
      'conversation: init cooldown active; start suppressed',
    );
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
   * URL is set AND this agent's runtime is in the allowlist, expand
   * the user-entered URL into the per-channel env vars (HTTP CONNECT
   * for `http[s]_proxy`, SOCKS for `all_proxy` — see `expandProxyEnv`
   * for the full table) and inject them into the spawned env.
   * Otherwise return env unchanged.
   *
   * Per-runtime opt-in (rather than blanket "apply to everyone") because
   * different runtimes hit different endpoints — codex needs the proxy
   * to reach chatgpt.com through corporate firewalls; claude/anthropic
   * may not. The user picks which runtimes need it in Settings.
   */
  /**
   * NOTE (commit-4 daemon refactor): the actual proxy-env logic now
   * lives in `packages/backend/src/runtime/proxy-env.ts` as a pure
   * helper so `RuntimeBridge` can apply the same allowlist semantics
   * when populating `runtime_start.options.env`. This method is a
   * thin wrapper that reads the current `SettingsRepo` snapshot and
   * delegates — kept here only because the CM call site predates
   * the bridge and we don't want to touch the spawn path until the
   * commit-5 atomic flip.
   */
  // `applyProxySetting` + `withSilverhandCliEnv` deleted. Spawn env
  // composition is now in `runtime/spawn-env.ts` via
  // `buildAgentSpawnEnv` — same callers (only `start()`), same
  // behavior; the helper is shared with the daemon-path bridge so
  // env can't drift across the gated flip.

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
    const items = this.inboxes.listPending(handle.conversationId, handle.agentId);
    if (items.length === 0) return;
    const text = formatInboxBatch(
      items,
      id => this.agents.get(id)?.name,
      id => this.users.get(id)?.name,
      this.resolveDefaultUserHandle(),
      this.agents.get(handle.agentId)?.name,
      sendMessageToolName(handle.driver),
    );
    const line = handle.driver.encodeStdinMessage(text, handle.cliSessionId);
    if (line === null) {
      // Driver isn't ready to accept stdin yet — typical for codex
      // between `bindIO` (initialize sent) and `thread/started`. Bail
      // *without* marking inbox delivered; the session_init handler's
      // retry will pick the items up once the driver flips to ready.
      this.ctx.logger.info(
        {
          conversationId: handle.conversationId,
          agentId: handle.agentId,
          itemCount: items.length,
        },
        'inbox: driver not ready (e.g. codex pre-thread); deferred',
      );
      return;
    }
    this.ctx.logger.info(
      {
        conversationId: handle.conversationId,
        agentId: handle.agentId,
        itemCount: items.length,
        bytes: text.length,
      },
      'inbox: draining queued items into agent stdin',
    );
    this.ensureInitWatchdogArmed(handle);
    await this.writeLine(handle, line);
    const inboxIds = items.map(i => i.inboxId);
    if (!handle.initObserved && handle.driver.kickoffMode === 'requires_first_message') {
      handle.initPendingInboxIds.push(...inboxIds);
    } else {
      this.inboxes.markDelivered(inboxIds);
    }
    this.markRunThinking(handle);
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

function handleKey(conversationId: string, agentId: string): string {
  return `${conversationId}:${agentId}`;
}

// `sendMessageToolName` / `MessageLite` / `formatStdinMessageHeader` /
// `formatStdinTimestamp` / `formatInboxBatch` / `formatLiveMessage` /
// `formatAttachmentSuffix` / `combineGatedBatch` /
// `formatDeliveryInstruction` lifted to
// `packages/backend/src/runtime/stdin-format.ts` so the daemon-path
// `DaemonAgentRuntimeHost` emits byte-identical stdin payloads. CM
// imports them from there now (see top-of-file imports).


function isSafeBoundary(h: AgentHandle): boolean {
  return h.busy.outstandingToolUses === 0 && !h.busy.compacting;
}

function incrementToolCount(
  counts: Record<string, number> | undefined,
  toolName: string,
): Record<string, number> {
  return {
    ...(counts ?? {}),
    [toolName]: (counts?.[toolName] ?? 0) + 1,
  };
}

function terminalStatus(reason: AgentRunTerminalReason): AgentRunStatus {
  return ['replied', 'turn_ended', 'replaced'].includes(reason)
    ? 'idle'
    : 'failed';
}

// `sanitizeParsedEventForBroadcast` / `sanitizeRawAgentEventValue` /
// `truncateRawAgentEventString` lifted to
// `packages/backend/src/runtime/event-sanitize.ts` so the daemon-path
// publisher (`RuntimeEventHandler`) reuses the exact same sanitizer.
// CM imports `sanitizeParsedEventForBroadcast` from there.

function trimActivitySnippet(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length <= ACTIVITY_SNIPPET_MAX_CHARS
    ? normalized
    : normalized.slice(-ACTIVITY_SNIPPET_MAX_CHARS);
}
