/**
 * Supervisor — production execution-plane owner for silverhand-daemon.
 *
 * It owns one runtime child process per `(conversation, agent)`:
 * spawn args/env, stdout/stderr pumping, parsed-event fanout,
 * stdin delivery, lifecycle locks, init retry/cooldown, compaction
 * watchdogs, and run-state projection. Dispatcher/server code sees
 * only the `SupervisorContract`; this concrete class is wired by
 * `entry.ts` in production and instantiated directly by focused
 * execution-plane tests.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setTimeout as setTimer } from 'node:timers';
import { randomUUID } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import {
  AUTH_TOKEN_HEADER,
  buildSystemPromptFor,
  type AgentActivitySnippetKind,
  type AgentRunState,
  decodeObservedSeq,
  internalPaths,
  type ParsedEvent,
  ParsedEventSchema,
  type RuntimeKind,
  SILVERHAND_AGENT_ID_ENV,
  SILVERHAND_AUTH_TOKEN_ENV,
  SILVERHAND_CONVERSATION_ID_ENV,
  SILVERHAND_SERVER_URL_ENV,
} from '@silverhand/shared';

import { getDriver as getDefaultDriver, type Driver } from '../../drivers/index.js';
import {
  detectRuntimes,
  platformBinaryCandidates,
} from '../../runtimes.js';
import {
  describeSpawnError,
  redactSpawnArgs,
  summarizeSpawnEnv,
  summarizeSpawnPath,
  summarizeSilverhandEnvPresence,
} from '../spawn-diagnostics.js';
import {
  encodeFrame,
  MAX_FRAME_BYTES,
  type AgentMessageSendParams,
  type AgentMessageSendResult,
  type AgentStaleResolveParams,
  type AgentStaleResolveResult,
  type AgentStreamObservedParams,
  type AgentStreamObservedResult,
  type EventFrame,
  type RuntimeClearSessionParams,
  type RuntimeClearSessionResult,
  type RuntimeCloseActivityLogParams,
  type RuntimeCloseActivityLogResult,
  type RuntimeOutputPauseParams,
  type RuntimeDeliverParams,
  type RuntimeDeliverResult,
  type RuntimeOutputPauseResult,
  type RuntimeOutputResumeParams,
  type RuntimeOutputResumeResult,
  type RuntimeStartParams,
  type RuntimeStartResult,
  type RuntimeStateDto,
  type RuntimeStatusParams,
  type RuntimeStatusResult,
  type RuntimeStopAllParams,
  type RuntimeStopAllResult,
  type RuntimeStopParams,
  type RuntimeStopResult,
  type RuntimeDelivery,
} from '../../protocol.js';
import type { DaemonLogger } from '../logger.js';
import { buildPromptContextFromRuntimeStartOptions } from '../prompt-context.js';
import type {
  ResolvedWorkspaceRef,
  RuntimeStartResolveDeps,
} from '../runtime-start-resolve.js';
import {
  resolveRuntimeStartPaths,
  RuntimeStartResolveError,
} from '../runtime-start-resolve.js';
import {
  unlinkRuntimePidfile,
  writeRuntimePidfile,
} from '../runtime-pidfiles.js';
import { buildDaemonSpawnEnv } from '../spawn-env.js';
import { readDaemonProxyConfig } from '../proxy-config.js';
import {
  prepareSpawnFiles,
  type SilverhandCliLauncher,
} from '../spawn-prep.js';
import { buildProfileMcpSpawnArgs } from '../mcp-spawn.js';
import { chooseSilverhandCliLauncher } from '../silverhand-cli-launcher.js';
import type {
  DeliveryOwnerContext,
  SupervisorContract,
} from '../supervisor-contract.js';
import type {
  ActivitySnippetKind,
  DeferredEntry,
  DefaultReplyTarget,
  InitTimeoutReason,
  PendingStaleEvent,
  RuntimeHandle,
  RuntimePhase,
  StartupDeliveryState,
} from './handle.js';
import { INPUT_PAYLOAD_UUID_CAP } from './handle.js';
import { combineGatedBatch, SEND_MESSAGE_TOOL } from './gated-combine.js';

// ── Configurable timing knobs ──────────────────────────────────────
//
// These match CM's defaults (`packages/backend/src/conversation-
// manager.ts` `stopSigtermMs` / `stopSigkillMs`). Pulling them out
// as constructor options keeps tests fast (typically override to
// 50ms + 50ms) without re-validating the same cascade behavior at
// production timings.

/** Default time we wait after SIGTERM before escalating to SIGKILL. */
export const DEFAULT_SIGTERM_TO_SIGKILL_MS = 5_000;
/** Default upper bound on the SIGKILL wait before we mark the handle
 *  exited regardless of the OS's response. Real `kill -9` lands
 *  within ms; this is a safety budget for stuck zombies. */
export const DEFAULT_SIGKILL_TIMEOUT_MS = 10_000;

// ── Bounded deferred-batch snapshot (doc I4/§3.3, #1558 final-gate P1-2) ──
//
// A drain-all flush must not compose an unbounded stdin payload: cap the
// prefix by entry count and total UTF-8 text bytes; the remainder stays
// queued IN ORDER for the next boundary. Initial values — mechanism
// first, tuning from real distributions later (doc §9).
export const DEFERRED_BATCH_MAX_ENTRIES = 20;
export const DEFERRED_BATCH_MAX_TEXT_BYTES = 256 * 1024;

// ── 3c-b init watchdog + retry/cooldown + compaction knobs ─────────
//
// These mirror CM's defaults (`packages/backend/src/conversation-
// manager.ts` lines 57-66) byte-for-byte. The override precedence
// inside `initTimeoutFor` is locked by Cindy (`-pdNvRYOWip5e9yA`):
//
//   opts.initWatchdogMs (global override across all 3 tiers)
//     > opts.init<Tier>Ms                         (per-tier override)
//       > driver.<tier>                           (driver opinion)
//         > DEFAULT_INIT_<TIER>_MS                (this constant)
//
// `opts.initWatchdogMs` exists for the "I want fast tests" knob CM
// already exposes (one number, applies to all three timers); when it's
// set the per-tier values are deliberately ignored.

export const DEFAULT_INIT_LIVENESS_SILENCE_MS = 30 * 1000;
export const DEFAULT_INIT_PRE_PROTOCOL_CAP_MS = 5 * 60 * 1000;
export const DEFAULT_INIT_POST_PROTOCOL_MS = 30 * 1000;
export const DEFAULT_INIT_TIMEOUT_MAX_RETRIES = 1;
export const DEFAULT_INIT_FAILURE_COOLDOWN_THRESHOLD = 3;
export const DEFAULT_INIT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
/** Watchdog window from `compaction_started` to `compaction_finished`.
 *  Past this the daemon emits `runtime_compaction_stale` and stacks
 *  `compactionStale: true` onto the run state — but does NOT kill
 *  the child or change phase. Matches CM's `COMPACTION_STALE_MS`. */
export const DEFAULT_COMPACTION_STALE_MS = 5 * 60 * 1000;
const ACTIVITY_SNIPPET_MAX_CHARS = 200;
const ACTIVITY_SNIPPET_BUFFER_MAX_CHARS = ACTIVITY_SNIPPET_MAX_CHARS * 4;
const SEND_MESSAGE_TOOL_NAME = 'silverhand message send';

type InitTimeoutTier =
  | 'initLivenessSilenceMs'
  | 'initPreProtocolCapMs'
  | 'initPostProtocolMs';

/** Per-(conv,agent) init-failure counter + cooldown clock. Sticky
 *  across attempts within the same incident window — cleared on a
 *  successful init or on the cooldown clock fully elapsing without
 *  the entry being touched. */
interface InitRetryState {
  failures: number;
  cooldownUntil: number;
}

export interface SupervisorOptions {
  /** Sink for outgoing events; wired by `runDaemon` to the per-socket
   *  broadcaster (with output backpressure applied per §2.2.2). */
  emit: (event: EventFrame) => void;
  /** Daemon-side structured logger (§3.4). Used for spawn / signal /
   *  exit lifecycle lines. */
  logger: DaemonLogger;
  /**
   * D4.e-6 — host path resolution deps for `runtime_start`. The wire
   * options are SEMANTIC-only (no `path`/`home_dir`); the supervisor
   * resolves every absolute host path via these deps just before building
   * the prompt context + spawn cwd — `regular` workspaces via the registry
   * (`resolveRegularWorkspacePath`), `agent_home` via `computeAgentDir` — and
   * fails closed (typed `RuntimeStartResolveError`) when a regular workspace
   * is unbound. Required (not optional) so a missing wire is a typed
   * decision, never a silent path-resolution gap — same philosophy as
   * `supervisorFactory` being required-but-nullable.
   */
  runtimeStartResolveDeps: RuntimeStartResolveDeps;
  /** Absolute path to the daemon control socket. Spawned agents use
   *  this to route freshness-sensitive side effects through the daemon
   *  rather than computing freshness in the short-lived CLI. */
  daemonSocketPath?: string | null;
  /** Optional injection for tests:
   *   - `driverFor` lets tests substitute a fake `Driver` so they can
   *     drive `Supervisor` against a controlled binary;
   *   - `resolveBinary` lets tests pin the binary path without
   *     touching PATH;
   *   - `spawnFn` lets tests fully stub `child_process.spawn`.
   *
   *  Production wiring leaves them undefined → default
   *  `getDriver(kind)` + `detectRuntimes` + node's spawn.
   */
  driverFor?: (kind: RuntimeKind) => Driver;
  resolveBinary?: (kind: RuntimeKind, fallback: string) => Promise<string | null>;
  spawnFn?: (
    binary: string,
    args: ReadonlyArray<string>,
    options: SpawnOptions,
  ) => ChildProcess;
  /** Time supplier override; lets tests pin `started_at` / event
   *  timestamps. */
  now?: () => number;
  sigtermToSigkillMs?: number;
  sigkillTimeoutMs?: number;
  /** #task:1563 test seam: override the next-turn reservation stall warn
   *  threshold (default {@link NEXT_TURN_RESERVATION_STALL_WARN_MS}). */
  reservationStallWarnMs?: number;
  /** Daemon-owned runtime pidfile context. Production `runDaemon`
   *  supplies both fields; unit tests can leave `runtimePidRootDir`
   *  null/undefined to disable filesystem pidfiles. */
  daemonInstanceId?: string;
  runtimePidRootDir?: string | null;
  proxyConfigPath?: string | null | (() => string | null);
  /**
   * Host-local launcher for the `silverhand` CLI shim exposed to runtimes.
   * Standalone backend cannot know packaged/host-local paths, so the
   * supervisor replaces only the backend's fallback `{command:'silverhand'}`
   * launcher with this local value. Embedded backends still pass an explicit
   * launcher and are left unchanged.
   */
  localSilverhandCliLauncher?: SilverhandCliLauncher | null;
  /**
   * Daemon-local current control-plane origin. In standalone remote-only
   * mode this comes from the active outbound attachment (Desktop profile /
   * daemon config), not from backend runtime_start. Embedded mode leaves it
   * null and uses the backend-provided finalized local URL.
   */
  controlPlaneServerUrl?: (() => string | null) | null;
  // ── 3c-b init watchdog + retry/cooldown + compaction knobs ──────
  //
  // Override precedence is fixed (Cindy `-pdNvRYOWip5e9yA`):
  //   opts.initWatchdogMs > opts.init<Tier>Ms > driver.<tier> > DEFAULT_*
  // See `initTimeoutFor` for the implementation. Constructor knobs
  // are optional so production wiring can omit them and inherit the
  // CM-aligned defaults verbatim.
  /** Global override for all 3 init timers (silence, pre-protocol
   *  cap, post-protocol). When set, per-tier overrides are ignored
   *  per the precedence table above. Maps 1:1 onto CM's
   *  `ConversationManager.initWatchdogMs`. */
  initWatchdogMs?: number | null;
  initLivenessSilenceMs?: number;
  initPreProtocolCapMs?: number;
  initPostProtocolMs?: number;
  initMaxRetries?: number;
  initFailureCooldownThreshold?: number;
  initFailureCooldownMs?: number;
  compactionStaleMs?: number;
  /**
   * Test/debug escape hatch only. Production leaves this false so raw
   * child stdout/stderr never crosses daemon→backend. Structured
   * parsed/state events are the supported runtime projection surface.
   */
  emitRawRuntimeOutput?: boolean;
}

/** Composite key for `Map<key, RuntimeHandle>` — null byte separator
 *  matches `FakeSupervisor` so log diffs across the two
 *  implementations stay clean. */
function key(conversationId: string, agentId: string): string {
  return `${conversationId}\x00${agentId}`;
}

/** Safe-boundary predicate for the daemon mid-turn queue (#task:1417
 *  Stage 3, §11.3). Byte-for-byte the coordinator's retired `isSafeBoundary`:
 *  no outstanding tool uses and not compacting. The daemon already tracks
 *  `handle.busy` in `updateRunStateFromParsed`, so this reads local truth. */
/** Commit A of #task:1558 (docs/runtime-input-design.md §3.2.1): the
 *  supervisor dispatches on the driver's declared release profile, never
 *  on runtime kind. Behavior-preserving mapping for now — the boundary-
 *  gated set reproduces the legacy boundary-gated
 *  semantics; Commit B gives `next-turn-batch` its own turn_end release,
 *  and Commit C deletes the legacy predicate entirely. */
function profileUsesBoundaryGate(handle: RuntimeHandle): boolean {
  switch (handle.driver.releaseProfile) {
    case 'tool-boundary-steer':
    case 'next-turn-batch':
    case 'prompt-boundary':
      return true;
    case 'native-steer':
    case 'one-shot':
      return false;
    default:
      // Fail closed (doc §3.2.1): a malformed or not-yet-wired profile
      // must never fall through to an implicit write. Throwing keeps
      // custody at the backend (the deliver command fails, rows stay
      // un-acked).
      throw new Error(
        `unknown releaseProfile ${String(
          (handle.driver as { releaseProfile?: unknown }).releaseProfile,
        )} — refusing live input (fail closed)`,
      );
  }
}

/** Per-profile release boundary (#task:1558 Commits B/B').
 *  - `next-turn-batch` (qoder, #1556: one stdin payload = one queued
 *    future turn): releases only when no turn is active AND no write
 *    reservation is pending — transport-safe tool boundaries are NOT
 *    its release boundary.
 *  - `tool-boundary-steer` (B' A/B-validated, notes claude-ab-results):
 *    immediate write — the runtime itself admits at its next tool
 *    boundary (we send an explicit `priority:"next"`). The single
 *    `!compacting` term is a MIGRATION-PERIOD CONSERVATIVE HOLD for the
 *    one scenario the experiments did not cover — it is not an
 *    evidence-backed guard and must not be re-shared across profiles;
 *    delete or harden it once compaction-time write evidence exists.
 *  - `prompt-boundary` (ACP, Commit C): the protocol's own prompt
 *    readiness (`driverReadyToEncode`) is the release boundary.
 *  - The unified transport-safe predicate (`handleAtSafeBoundary`) was
 *    deleted in Commit C — no profile consumes it. */
/** Per-stream max seq covered by a startup batch — the same derivation
 *  `admitDeliveryBatch` uses (structured deliveries, else the scalar
 *  main-stream high-water). Recorded on the payload uuid so a runtime
 *  `started(uuid)` echo can promote observed for exactly this coverage
 *  (#task:1558 B'). */
function coveredSeqPairsForBatch(batch: StartupDeliveryState): Array<[string, number]> {
  const byStream = new Map<string, number>();
  if (batch.deliveries && batch.deliveries.length > 0) {
    for (const delivery of batch.deliveries) {
      const streamKey = streamKeyForMessage(delivery.thread_root_id);
      const seq = safeSeq(delivery.seq);
      if (seq === null) continue;
      const prev = byStream.get(streamKey);
      if (prev === undefined || seq > prev) byStream.set(streamKey, seq);
    }
  } else if (safeSeq(batch.deliveredUpToSeq) !== null) {
    byStream.set(MAIN_STREAM_KEY, batch.deliveredUpToSeq as number);
  }
  return [...byStream.entries()];
}

function strategyBoundaryOpen(handle: RuntimeHandle): boolean {
  switch (handle.driver.releaseProfile) {
    case 'next-turn-batch':
      return handle.nextTurnReserved !== true && handle.inputTurnActive !== true;
    case 'tool-boundary-steer':
      // Migration-period conservative hold (docs §3.2): compaction is
      // the one scenario the B' experiments did not cover.
      return handle.busy.compacting !== true;
    case 'prompt-boundary':
      // ACP's protocol-owned readiness: one active session/prompt at a
      // time, surfaced by the driver itself.
      return driverReadyToEncode(handle.driver);
    case 'native-steer':
    case 'one-shot':
      // Always open here — the write-in-flight slot and the oneShot
      // spawn path own their serialization.
      return true;
    default:
      // Fail closed (doc §3.2.1) — see profileUsesBoundaryGate.
      throw new Error(
        `unknown releaseProfile ${String(
          (handle.driver as { releaseProfile?: unknown }).releaseProfile,
        )} — refusing live input (fail closed)`,
      );
  }
}

/** Idempotency key for a deferred batch: the delivery-id SET (order-
 *  independent). Mirrors the coordinator's `dedupKey` so a re-submit of the
 *  same batch cannot double-queue (§11.4). */
function deferredDedupKey(ids: readonly number[]): string {
  return [...ids].sort((a, b) => a - b).join(',');
}

/** Conservative per-entry byte budget for the combined payload's wrapping
 *  overhead: `combineGatedBatch`'s '\n\n---\n\n' separators plus the
 *  header/footer instruction lines and JSON string escaping headroom.
 *  Generous by design — the cap protects boundedness, not precision. */
const DEFERRED_BATCH_PER_ENTRY_OVERHEAD_BYTES = 512;

/** #task:1563 (doc §3.4): a `next-turn-batch` reservation armed at write
 *  time is cleared only by a parsed terminal `turn_end`; if that terminal
 *  is lost the boundary stays closed and every delivery defers forever.
 *  The hold IS the fail-closed contract — this threshold only decides when
 *  to surface the stall diagnostically, never when to force a write.
 *  120s is far past any real qoder turn-start latency. */
const NEXT_TURN_RESERVATION_STALL_WARN_MS = 120 * 1000;

/** Bounded snapshot of the deferred queue (doc I4/§3.3): take the longest
 *  prefix within the entry/byte caps (always at least one entry so a
 *  single oversized entry still drains), leave the remainder queued in
 *  order for the next boundary. Byte accounting includes a conservative
 *  per-entry wrapping budget so the FINAL combined payload — not just
 *  the raw texts — stays bounded. */
function spliceBoundedDeferredPrefix(queue: DeferredEntry[]): DeferredEntry[] {
  let take = 0;
  let bytes = 0;
  for (const entry of queue) {
    const entryBytes =
      Buffer.byteLength(entry.text, 'utf8') +
      DEFERRED_BATCH_PER_ENTRY_OVERHEAD_BYTES;
    if (
      take > 0 &&
      (take >= DEFERRED_BATCH_MAX_ENTRIES ||
        bytes + entryBytes > DEFERRED_BATCH_MAX_TEXT_BYTES)
    ) {
      break;
    }
    take += 1;
    bytes += entryBytes;
  }
  return queue.splice(0, Math.max(1, take));
}

/** Fold a drained deferred batch into a single `StartupDeliveryState` for the
 *  shared consume path (#task:1417 Stage 3, §11.4). `gated` multi-entry
 *  batches combine their texts into one turn (`combineGatedBatch`); a single
 *  entry (always the case for `direct` FIFO, or a lone gated entry) keeps its
 *  text verbatim. delivery_ids concatenate so the one `consumed` covers the
 *  whole batch; per-delivery stream metadata flattens only when EVERY entry
 *  carries it (else fall back to the scalar `deliveredUpToSeq` high-water). */
function combineDeferredBatch(
  batch: readonly DeferredEntry[],
  gated: boolean,
): StartupDeliveryState {
  const deliveryIds = batch.flatMap(e => [...e.deliveryIds]);
  const texts = batch.map(e => e.text);
  // `batch` is non-empty by contract (flushDeferred only calls this after
  // checking the queue has entries), so `texts[0]` is always present; the
  // `?? ''` satisfies the compiler's index-widening without masking a real
  // empty text.
  const text =
    gated && texts.length > 1
      ? combineGatedBatch(texts, SEND_MESSAGE_TOOL)
      : (texts[0] ?? '');
  const allHaveDeliveries = batch.every(e => e.deliveries !== undefined);
  const deliveries = allHaveDeliveries
    ? batch.flatMap(e => [...(e.deliveries ?? [])])
    : undefined;
  const seqs = batch
    .map(e => e.deliveredUpToSeq)
    .filter((s): s is number => s !== undefined);
  const deliveredUpToSeq = seqs.length > 0 ? Math.max(...seqs) : undefined;
  return {
    deliveryIds,
    ...(deliveredUpToSeq !== undefined ? { deliveredUpToSeq } : {}),
    ...(deliveries ? { deliveries } : {}),
    text,
  };
}

function safeSeq(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? value
    : null;
}

/** Stream key for the channel's main line. */
const MAIN_STREAM_KEY = 'main';

/** Upper bound on the per-handle reply-target memory. A reply target
 *  beyond this LRU window is treated as "unknown" (Case A loose) — the
 *  send omits seen+stream_key rather than guessing the wrong stream. */
const REPLY_TARGET_STREAM_CACHE_CAP = 4096;

type EffectiveMessageTarget =
  | { kind: 'channel' }
  | {
      kind: 'thread';
      messageId: string;
      source?: 'current_default' | 'pending_default';
    }
  | { kind: 'ambiguous'; streamKeys: readonly string[] }
  | { kind: 'legacy'; target: AgentMessageSendParams['target'] };

const CHANNEL_DEFAULT_REPLY_TARGET: DefaultReplyTarget = { kind: 'channel' };

/**
 * Gates the legacy per-turn default-reply-target inference. While `false`, a
 * bare `message send` (no `--target`/`--reply-to`) always resolves to the
 * channel main line and the inference below is retained but never consulted;
 * `--reply-to` resolution and per-stream freshness are independent of this
 * flag. Physically remove the gated legacy inference once dogfood comparison
 * confirms the main-line default.
 */
const DEFAULT_REPLY_TARGET_INFERENCE_ENABLED = false;

/**
 * Internal spawn input for {@link Supervisor.startUnlocked}. Stage 2c made the
 * wire `runtime_start` command pure lifecycle ({@link RuntimeStartParams} — no
 * delivery), so the ONLY source of a spawn-time startup batch is
 * `runtime_deliver`'s SPAWN arm, which passes one here. A plain
 * `RuntimeStartParams` (from `start()` / retry respawn) is assignable — its
 * `startup_delivery` is simply absent. This shape is daemon-internal and never
 * crosses the wire.
 */
type StartUnlockedParams = RuntimeStartParams & {
  startup_delivery?: {
    delivery_ids: number[];
    delivered_up_to_seq?: number;
    deliveries?: RuntimeDelivery[];
    text: string;
  };
};

function uniqueSortedStreamKeys(streamKeys: readonly string[]): string[] {
  return [...new Set(streamKeys)].sort();
}

function streamKeyToThreadRootId(streamKey: string): string | null {
  return streamKey.startsWith('thread:') ? streamKey.slice('thread:'.length) : null;
}

function defaultReplyTargetStreamKeys(target: DefaultReplyTarget): string[] {
  switch (target.kind) {
    case 'thread':
      return [target.streamKey];
    case 'ambiguous':
      return [...target.streamKeys];
    case 'channel':
      return [];
  }
}

function ambiguousDefaultTargetErrorBody(
  streamKeys: readonly string[],
): string {
  const candidateTargets = [
    ...uniqueSortedStreamKeys(streamKeys).flatMap(streamKey => {
      const root = streamKeyToThreadRootId(streamKey);
      return root ? [`thread:${root}`] : [];
    }),
    'channel',
  ];
  return JSON.stringify({
    error: {
      code: 'validation_error',
      message:
        'bare message send has an ambiguous default target; rerun with an explicit --target',
      details: {
        subkind: 'ambiguous_default_target',
        candidate_targets: candidateTargets,
        hint:
          'Use --target thread:<id> for one listed thread, or --target channel for the main line.',
      },
    },
  });
}

/** The stream a message LIVES in — what its arrival/our own send
 *  advances as the observed boundary. `thread_root_id === null` ⇒ main
 *  line; otherwise the reply cluster rooted at that message. */
function streamKeyForMessage(threadRootId: string | null | undefined): string {
  return threadRootId ? `thread:${threadRootId}` : MAIN_STREAM_KEY;
}

/** The stream a reply TO `messageId` is destined for: the cluster it
 *  anchors (reply to a main-line message) or already belongs to (reply
 *  to an existing reply, joining the same root — no nesting). */
function replyTargetStreamKey(
  messageId: string,
  threadRootId: string | null | undefined,
): string {
  return `thread:${threadRootId ?? messageId}`;
}

function parsedStartsTurn(parsed: ParsedEvent): boolean {
  return (
    parsed.kind === 'thinking'
    || parsed.kind === 'text'
    || parsed.kind === 'tool_call'
    || (parsed.kind === 'error' && parsed.fatal !== true)
  );
}

function parseObjectJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractStaleConflict(bodyText: string): PendingStaleEvent | null {
  const parsed = parseObjectJson(bodyText);
  const error = parsed?.['error'];
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const details = (error as Record<string, unknown>)['details'];
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return null;
  }
  const d = details as Record<string, unknown>;
  if (d['subkind'] !== 'message_stale') return null;
  const id = d['stale_event_id'];
  const currentSeq = d['current_seq'];
  if (
    typeof id !== 'string'
    || id.length === 0
    || typeof currentSeq !== 'number'
    || !Number.isSafeInteger(currentSeq)
    || currentSeq <= 0
  ) {
    return null;
  }
  return { id, currentSeq };
}

async function safeReadResponseText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export class Supervisor implements SupervisorContract {
  private readonly handles = new Map<string, RuntimeHandle>();
  private readonly emit: (event: EventFrame) => void;
  private readonly logger: DaemonLogger;
  private readonly runtimeStartResolveDeps: RuntimeStartResolveDeps;
  private readonly driverFor: (kind: RuntimeKind) => Driver;
  private readonly resolveBinary: (
    kind: RuntimeKind,
    fallback: string,
  ) => Promise<string | null>;
  private readonly spawnFn: NonNullable<SupervisorOptions['spawnFn']>;
  private readonly now: () => number;
  private readonly sigtermToSigkillMs: number;
  private readonly sigkillTimeoutMs: number;
  private readonly reservationStallWarnMs: number;
  private readonly daemonInstanceId: string | null;
  private readonly runtimePidRootDir: string | null;
  private readonly proxyConfigPath: () => string | null;
  private readonly localSilverhandCliLauncher: SilverhandCliLauncher | null;
  private readonly controlPlaneServerUrl: () => string | null;
  private readonly daemonSocketPath: string | null;

  // ── 3c-b state ─────────────────────────────────────────────────
  /** Sticky per-(conv, agent) init failure counter + cooldown clock.
   *  Survives across watchdog-triggered respawns within the same
   *  incident window. Cleared by a successful `session_init`. */
  private readonly initRetryStates = new Map<string, InitRetryState>();
  /** Per-(conv, agent) lifecycle serialization (Cindy plan v2 issue
   *  #6 + tightening `ixAq6GPTn4fVSpCF`). Each entry is the tail
   *  promise for the *most recent* lifecycle operation on that key;
   *  new ops queue behind it. delivery intentionally DOES NOT
   *  participate — it gates via `handle.startupDelivery` / `phase`
   *  instead. */
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly initWatchdogMs: number | null;
  private readonly initLivenessSilenceMs?: number;
  private readonly initPreProtocolCapMs?: number;
  private readonly initPostProtocolMs?: number;
  private readonly initMaxRetries: number;
  private readonly initFailureCooldownThreshold: number;
  private readonly initFailureCooldownMs: number;
  private readonly compactionStaleMs: number;
  private readonly emitRawRuntimeOutput: boolean;
  /** Wall-clock at daemon/supervisor construction — logged with every spawn
   *  so a runtime failure can be tied to the daemon process instance that
   *  produced it (see #task:1420 spawn diagnostics). */
  private readonly daemonStartedAt: number;

  constructor(opts: SupervisorOptions) {
    this.emit = opts.emit;
    this.logger = opts.logger;
    this.runtimeStartResolveDeps = opts.runtimeStartResolveDeps;
    this.driverFor = opts.driverFor ?? getDefaultDriver;
    this.resolveBinary = opts.resolveBinary ?? defaultResolveBinary;
    this.spawnFn = opts.spawnFn ?? nodeSpawn;
    this.now = opts.now ?? Date.now;
    this.sigtermToSigkillMs =
      opts.sigtermToSigkillMs ?? DEFAULT_SIGTERM_TO_SIGKILL_MS;
    this.sigkillTimeoutMs = opts.sigkillTimeoutMs ?? DEFAULT_SIGKILL_TIMEOUT_MS;
    this.reservationStallWarnMs =
      opts.reservationStallWarnMs ?? NEXT_TURN_RESERVATION_STALL_WARN_MS;
    this.daemonInstanceId = opts.daemonInstanceId ?? null;
    this.runtimePidRootDir = opts.runtimePidRootDir ?? null;
    const proxyConfigPath = opts.proxyConfigPath ?? null;
    this.proxyConfigPath =
      typeof proxyConfigPath === 'function'
        ? proxyConfigPath
        : () => proxyConfigPath;
    this.localSilverhandCliLauncher = opts.localSilverhandCliLauncher ?? null;
    this.controlPlaneServerUrl = opts.controlPlaneServerUrl ?? (() => null);
    this.daemonSocketPath = opts.daemonSocketPath ?? null;
    this.initWatchdogMs = opts.initWatchdogMs ?? null;
    this.initLivenessSilenceMs = opts.initLivenessSilenceMs;
    this.initPreProtocolCapMs = opts.initPreProtocolCapMs;
    this.initPostProtocolMs = opts.initPostProtocolMs;
    this.initMaxRetries = opts.initMaxRetries ?? DEFAULT_INIT_TIMEOUT_MAX_RETRIES;
    this.initFailureCooldownThreshold =
      opts.initFailureCooldownThreshold ?? DEFAULT_INIT_FAILURE_COOLDOWN_THRESHOLD;
    this.initFailureCooldownMs =
      opts.initFailureCooldownMs ?? DEFAULT_INIT_FAILURE_COOLDOWN_MS;
    this.compactionStaleMs = opts.compactionStaleMs ?? DEFAULT_COMPACTION_STALE_MS;
    this.emitRawRuntimeOutput = opts.emitRawRuntimeOutput ?? false;
    this.daemonStartedAt = this.now();
  }

  /** Pure per-stream observed advance: bump the stream to max(prev, seq)
   *  and log when it actually moves. No turn side-effect — shared by the
   *  send path (which additionally marks the turn) and the pull-observe
   *  intent (which must NOT start a turn). */
  /** #task:1557 Phase 1: mint a stable uuid for one encoded stdin
   *  payload and remember which delivery ids it carried. Claude echoes
   *  the uuid back on `command_lifecycle` frames; other runtimes never
   *  reference it. Bounded FIFO — observation only. */
  private mintInputPayloadUuid(
    handle: RuntimeHandle,
    deliveryIds: readonly number[],
    coveredSeqByStream: ReadonlyArray<readonly [string, number]> = [],
  ): string {
    const uuid = randomUUID();
    handle.inputPayloadUuids.set(uuid, {
      deliveryIds: [...deliveryIds],
      coveredSeqByStream: coveredSeqByStream.map(([k, v]) => [k, v] as [string, number]),
      mintedAt: Date.now(),
    });
    while (handle.inputPayloadUuids.size > INPUT_PAYLOAD_UUID_CAP) {
      const oldest = handle.inputPayloadUuids.keys().next().value;
      if (oldest === undefined) break;
      handle.inputPayloadUuids.delete(oldest);
    }
    return uuid;
  }

  private recordObservedStream(
    handle: RuntimeHandle,
    streamKey: string,
    seq: number | undefined,
    source: string,
  ): void {
    const nextSeq = safeSeq(seq);
    if (nextSeq === null) return;
    // Mint at a real observation boundary (delivery admit / stale response /
    // send commit): a raw backend seq becomes this stream's ObservedSeq cursor
    // via a validated decode — never a bare cast.
    const observed = decodeObservedSeq(nextSeq);
    const prev = handle.observedSeqByStream.get(streamKey);
    // Monotonic advance WITHOUT flattening absence: `prev === undefined`
    // ("never observed") is a distinct state from `prev = 0`, so we branch on
    // it explicitly rather than `?? 0`. A first observation of a stream is a
    // real advance worth logging.
    if (prev !== undefined && prev >= observed) return;
    handle.observedSeqByStream.set(streamKey, observed);
    this.logger.warn(
      {
        kind: 'process',
        action: 'freshness_observed_seq_advanced',
        conversationId: handle.conversationId,
        agent_id: handle.agentId,
        source,
        stream_key: streamKey,
        previous_seq: prev ?? null,
        observed_seq: observed,
      },
      'runtime freshness observed seq advanced',
    );
    this.drainBypassMerges(handle, streamKey);
  }

  /** Countgame P1 (bypass hole): merge the agent's own forced seqs into
   *  the watermark once real admission evidence covers their prerequisite
   *  head. Iterative (a merged own seq can satisfy the next entry's
   *  prerequisite — chained bypasses). Own seqs need no admission
   *  evidence: the sender authored them. */
  private drainBypassMerges(handle: RuntimeHandle, streamKey: string): void {
    const entries = handle.pendingBypassMergeByStream.get(streamKey);
    if (!entries || entries.length === 0) return;
    let current = handle.observedSeqByStream.get(streamKey);
    if (current === undefined) return;
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i]!;
        if (entry.prereq <= (current as number)) {
          entries.splice(i, 1);
          if (entry.ownSeq > (current as number)) {
            current = decodeObservedSeq(entry.ownSeq);
            handle.observedSeqByStream.set(streamKey, current);
            this.logger.warn(
              {
                kind: 'process',
                action: 'freshness_observed_seq_advanced',
                conversationId: handle.conversationId,
                agent_id: handle.agentId,
                source: 'bypass_own_seq_merged',
                stream_key: streamKey,
                observed_seq: entry.ownSeq,
                merge_prereq: entry.prereq,
              },
              'runtime freshness observed seq advanced',
            );
          }
          changed = true;
          break;
        }
      }
    }
    if (entries.length === 0) {
      handle.pendingBypassMergeByStream.delete(streamKey);
    }
  }

  private advanceObservedStream(
    handle: RuntimeHandle,
    streamKey: string,
    seq: number | undefined,
    source: string,
  ): void {
    this.recordObservedStream(handle, streamKey, seq, source);
    // A send/arrival is turn activity; only mark the turn when we had a
    // real seq to record (preserve the prior early-return semantics).
    if (safeSeq(seq) !== null) handle.inputTurnActive = true;
  }

  private queueAdmissionStream(
    handle: RuntimeHandle,
    streamKey: string,
    seq: number | undefined,
    source: string,
  ): void {
    const nextSeq = safeSeq(seq);
    if (nextSeq === null) return;
    const pending = decodeObservedSeq(nextSeq);
    const prev = handle.pendingAdmissionSeqByStream.get(streamKey);
    // Same present/absent discipline as `recordObservedStream`.
    if (prev !== undefined && prev >= pending) return;
    handle.pendingAdmissionSeqByStream.set(streamKey, pending);
    this.logger.warn(
      {
        kind: 'process',
        action: 'freshness_pending_admission_queued',
        conversationId: handle.conversationId,
        agent_id: handle.agentId,
        source,
        stream_key: streamKey,
        previous_pending_seq: prev ?? null,
        pending_admission_seq: pending,
      },
      'runtime freshness pending admission queued',
    );
  }

  private admitPendingSeqForNewTurn(handle: RuntimeHandle, source: string): void {
    if (handle.pendingAdmissionSeqByStream.size > 0) {
      const pending = [...handle.pendingAdmissionSeqByStream.entries()];
      handle.pendingAdmissionSeqByStream.clear();
      for (const [streamKey, seq] of pending) {
        this.advanceObservedStream(handle, streamKey, seq, source);
      }
    }
    // Legacy comparator upkeep: dormant while the inference gate is off, since
    // pendingDefaultReplyTarget is only ever populated under the gate.
    if (handle.pendingDefaultReplyTarget !== undefined) {
      handle.defaultReplyTarget = handle.pendingDefaultReplyTarget;
      handle.pendingDefaultReplyTarget = undefined;
    }
  }

  /** Record where a future `--reply-to <messageId>` should land, keeping
   *  the per-handle memory bounded (insertion-order LRU). */
  private rememberReplyTargetStream(
    handle: RuntimeHandle,
    messageId: string,
    streamKey: string,
  ): void {
    const map = handle.replyTargetStreamByMessageId;
    map.delete(messageId);
    map.set(messageId, streamKey);
    while (map.size > REPLY_TARGET_STREAM_CACHE_CAP) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /** Gated legacy comparator ONLY (see DEFAULT_REPLY_TARGET_INFERENCE_ENABLED).
   *  Infers a per-turn bare-send default from a wake batch: no thread turn →
   *  main, one thread → that thread, multiple threads → ambiguous. The active
   *  path never calls this — bare sends resolve to main; the paired helpers
   *  ({@link mergePendingDefaultReplyTarget}, `ambiguousDefaultTargetErrorBody`)
   *  are likewise gate-only. Remove the cluster with the gated inference. */
  private inferDefaultReplyTarget(
    deliveries: readonly RuntimeDelivery[] | undefined,
  ): DefaultReplyTarget | undefined {
    if (!deliveries || deliveries.length === 0) return undefined;
    const latestByThreadStream = new Map<string, RuntimeDelivery>();
    let sawTurnDelivery = false;
    for (const delivery of deliveries) {
      if (delivery.delivery_kind !== 'turn') continue;
      sawTurnDelivery = true;
      if (!delivery.thread_root_id) continue;
      const deliveryStream = streamKeyForMessage(delivery.thread_root_id);
      const current = latestByThreadStream.get(deliveryStream);
      if (!current || delivery.seq >= current.seq) {
        latestByThreadStream.set(deliveryStream, delivery);
      }
    }
    if (!sawTurnDelivery) return undefined;
    if (latestByThreadStream.size === 0) return CHANNEL_DEFAULT_REPLY_TARGET;
    if (latestByThreadStream.size > 1) {
      return {
        kind: 'ambiguous',
        streamKeys: [...latestByThreadStream.keys()].sort(),
      };
    }
    const first = latestByThreadStream.entries().next().value;
    if (!first) return undefined;
    const [streamKey, latest] = first;
    return { kind: 'thread', messageId: latest.message_id, streamKey };
  }

  private mergePendingDefaultReplyTarget(
    handle: RuntimeHandle,
    inferred: DefaultReplyTarget | undefined,
  ): void {
    if (inferred === undefined) return;
    const pending = handle.pendingDefaultReplyTarget;
    if (pending === undefined) {
      handle.pendingDefaultReplyTarget = inferred;
      return;
    }
    if (pending.kind === 'ambiguous' || inferred.kind === 'ambiguous') {
      const streamKeys = [
        ...defaultReplyTargetStreamKeys(pending),
        ...defaultReplyTargetStreamKeys(inferred),
      ];
      handle.pendingDefaultReplyTarget =
        streamKeys.length === 0
          ? { kind: 'ambiguous', streamKeys: [] }
          : { kind: 'ambiguous', streamKeys: uniqueSortedStreamKeys(streamKeys) };
      return;
    }
    if (pending.kind === 'channel') {
      handle.pendingDefaultReplyTarget = inferred;
      return;
    }
    if (inferred.kind === 'channel') {
      handle.pendingDefaultReplyTarget = pending;
      return;
    }
    handle.pendingDefaultReplyTarget =
      pending.streamKey === inferred.streamKey
        ? inferred
        : {
            kind: 'ambiguous',
            streamKeys: uniqueSortedStreamKeys([pending.streamKey, inferred.streamKey]),
          };
  }

  private effectiveMessageTarget(
    handle: RuntimeHandle,
    params: AgentMessageSendParams,
  ): EffectiveMessageTarget {
    if (params.reply_to_message_id !== undefined) {
      return { kind: 'thread', messageId: params.reply_to_message_id };
    }
    const target = params.target;
    if (target && typeof target === 'object' && 'kind' in target) {
      return target.kind === 'thread'
        ? { kind: 'thread', messageId: target.message_id }
        : { kind: 'channel' };
    }
    if (target !== undefined) return { kind: 'legacy', target };
    // Bare send (no --target/--reply-to) resolves to the channel main line.
    // The legacy per-turn inference below is consulted only when gated on.
    if (!DEFAULT_REPLY_TARGET_INFERENCE_ENABLED) {
      return { kind: 'channel' };
    }
    if (handle.pendingDefaultReplyTarget) {
      if (handle.pendingDefaultReplyTarget.kind === 'ambiguous') {
        return {
          kind: 'ambiguous',
          streamKeys: handle.pendingDefaultReplyTarget.streamKeys,
        };
      }
      if (handle.pendingDefaultReplyTarget.kind === 'channel') {
        return { kind: 'channel' };
      }
      return {
        kind: 'thread',
        messageId: handle.pendingDefaultReplyTarget.messageId,
        source: 'pending_default',
      };
    }
    if (handle.defaultReplyTarget.kind === 'ambiguous') {
      return { kind: 'ambiguous', streamKeys: handle.defaultReplyTarget.streamKeys };
    }
    if (handle.defaultReplyTarget.kind === 'thread') {
      return {
        kind: 'thread',
        messageId: handle.defaultReplyTarget.messageId,
        source: 'current_default',
      };
    }
    return { kind: 'channel' };
  }

  /**
   * Admit a delivered batch into the per-stream observed boundary
   * (reply-cluster §6.4). With structured `deliveries[]` each row
   * advances (or queues) the stream it lives in and teaches the handle
   * where a reply to that message would go. Without metadata (legacy
   * backend) we fall back to the scalar high-water on the main stream.
   * `admitNow=false` queues instead of advancing, for a mid-turn batch
   * that becomes precedent only at the next turn boundary.
   */
  private admitDeliveryBatch(
    handle: RuntimeHandle,
    deliveries: readonly RuntimeDelivery[] | undefined,
    deliveredUpToSeq: number | undefined,
    admitNow: boolean,
    source: string,
  ): void {
    // Legacy default-reply-target inference: maintained only while gated on.
    // Freshness admission and the reply-target cache below are unconditional.
    if (DEFAULT_REPLY_TARGET_INFERENCE_ENABLED) {
      const inferredDefault = this.inferDefaultReplyTarget(deliveries);
      if (admitNow) {
        handle.defaultReplyTarget = inferredDefault ?? CHANNEL_DEFAULT_REPLY_TARGET;
        handle.pendingDefaultReplyTarget = undefined;
      } else {
        this.mergePendingDefaultReplyTarget(handle, inferredDefault);
      }
    }
    if (deliveries && deliveries.length > 0) {
      for (const delivery of deliveries) {
        this.rememberReplyTargetStream(
          handle,
          delivery.message_id,
          replyTargetStreamKey(delivery.message_id, delivery.thread_root_id),
        );
        const streamKey = streamKeyForMessage(delivery.thread_root_id);
        if (admitNow) {
          this.advanceObservedStream(handle, streamKey, delivery.seq, source);
        } else {
          this.queueAdmissionStream(handle, streamKey, delivery.seq, source);
        }
      }
      return;
    }
    if (admitNow) {
      this.advanceObservedStream(handle, MAIN_STREAM_KEY, deliveredUpToSeq, source);
    } else {
      this.queueAdmissionStream(handle, MAIN_STREAM_KEY, deliveredUpToSeq, source);
    }
  }

  /** Hard-reject a batch whose per-delivery metadata id-set does not
   *  match its `delivery_ids` (text and stream metadata must not drift —
   *  reply-cluster §6.4). A legacy batch without `deliveries[]` is
   *  allowed and validated as a no-op. Throws on mismatch (a backend
   *  contract bug): the delivery is left un-acked so the failure is loud. */
  private assertDeliveryMetadataConsistent(
    conversationId: string,
    agentId: string,
    deliveryIds: readonly number[],
    deliveries: readonly RuntimeDelivery[] | undefined,
    context: string,
  ): void {
    if (!deliveries) return;
    const idSet = new Set(deliveryIds);
    const metaSet = new Set(deliveries.map(d => d.delivery_id));
    let mismatch = idSet.size !== metaSet.size;
    if (!mismatch) {
      for (const id of idSet) {
        if (!metaSet.has(id)) {
          mismatch = true;
          break;
        }
      }
    }
    if (mismatch) {
      this.logger.error(
        {
          kind: 'process',
          action: 'delivery_metadata_mismatch',
          conversationId,
          agent_id: agentId,
          context,
          delivery_ids: [...idSet],
          metadata_ids: [...metaSet],
        },
        'delivery metadata id-set does not match delivery_ids (backend bug)',
      );
      throw new Error(
        `delivery metadata mismatch in ${context}: `
          + `delivery_ids=[${[...idSet].join(',')}] `
          + `deliveries=[${[...metaSet].join(',')}]`,
      );
    }
  }

  private shouldAdmitDeliveryImmediately(handle: RuntimeHandle): boolean {
    return handle.inputTurnActive !== true;
  }

  private getHandleForAgentIntent(
    conversationId: string,
    agentId: string,
  ): RuntimeHandle {
    const handle = this.handles.get(key(conversationId, agentId));
    if (!handle || handle.phase === 'exited') {
      throw new Error(
        `agent side-effect requested for non-running runtime ${conversationId}/${agentId}`,
      );
    }
    return handle;
  }

  private async backendPost(
    handle: RuntimeHandle,
    path: string,
    body: unknown,
  ): Promise<Response> {
    const serverUrl = this.controlPlaneServerUrl();
    if (!serverUrl) {
      throw new Error(
        'agent side-effect requested before daemon has a control-plane server URL',
      );
    }
    return fetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers: {
        [AUTH_TOKEN_HEADER]: `Bearer ${handle.spawnParams.options.env_policy.silverhand.auth_token}`,
        'X-Agent-Hub-Caller': 'silverhand-daemon',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async agentMessageSend(
    params: AgentMessageSendParams,
  ): Promise<AgentMessageSendResult> {
    const handle = this.getHandleForAgentIntent(
      params.conversation_id,
      params.agent_id,
    );
    const pendingStale = handle.pendingStaleEvent;
    // Resolve which per-stream observed boundary this send is anchored to
    // (reply-cluster §6.4):
    //  - explicit target        → explicit stream (`channel` or
    //    `thread:<messageId>`; legacy target shapes remain adapter-only).
    //  - no explicit target     → the channel main line. A bare send never
    //    inherits a thread; the per-turn thread/ambiguous fallback below is
    //    reachable only while the legacy inference gate is on.
    //  - reply target we saw    → that cluster's stream (known).
    //  - reply target we did NOT see → unknown (Case A loose, Q1=A): omit
    //    seen+stream_key so the backend skips freshness for this first-touch
    //    send instead of falsely stale-ing it.
    const effectiveTarget = this.effectiveMessageTarget(handle, params);
    // Legacy-gate-only: the active bare-send path resolves to main and never
    // yields an ambiguous default.
    if (effectiveTarget.kind === 'ambiguous') {
      return {
        ok: false,
        status: 422,
        body_text: ambiguousDefaultTargetErrorBody(effectiveTarget.streamKeys),
      };
    }
    const threadTargetMessageId =
      effectiveTarget.kind === 'thread' ? effectiveTarget.messageId : undefined;
    const targetStreamKey = threadTargetMessageId
      ? handle.replyTargetStreamByMessageId.get(threadTargetMessageId)
      : MAIN_STREAM_KEY;
    const targetKnown = targetStreamKey !== undefined;
    const targetObserved =
      targetKnown && handle.observedSeqByStream.has(targetStreamKey);
    // Thread targets become "known" through a root/message mapping even when
    // the agent observed an empty cluster, so `seen=0` is load-bearing there.
    // Main has no such mapping step: absence means the agent has never seen
    // the main stream in this daemon session. Treat that as first-touch and
    // omit per-stream freshness instead of manufacturing `seen=0`, which
    // would stale against seq 1..N.
    const useFreshnessBoundary =
      targetKnown && (targetStreamKey !== MAIN_STREAM_KEY || targetObserved);
    // The present/absent DECISION is already made above (`.has` → targetObserved
    // → useFreshnessBoundary). The `?? 0` below is therefore NOT absence-
    // flattening — it is the role-defined seen=0 for a KNOWN-but-empty thread
    // cluster, reached only once useFreshnessBoundary holds. `seenUpToSeq` is a
    // plain wire CAS int (not an ObservedSeq brand): it crosses to the backend's
    // per-stream freshness check.
    const seenUpToSeq: number | undefined =
      useFreshnessBoundary
      && effectiveTarget.kind === 'thread'
      && effectiveTarget.source === 'pending_default'
        ? Math.max(
            handle.observedSeqByStream.get(targetStreamKey) ?? 0,
            handle.pendingAdmissionSeqByStream.get(targetStreamKey) ?? 0,
          )
        : useFreshnessBoundary
          ? (handle.observedSeqByStream.get(targetStreamKey) ?? 0)
          : undefined;
    if (threadTargetMessageId && !targetKnown) {
      this.logger.info(
        {
          kind: 'process',
          action: 'missing_reply_target_message',
          conversationId: handle.conversationId,
          agent_id: handle.agentId,
          target_message_id: threadTargetMessageId,
        },
        'reply target unknown to daemon — sending without per-stream freshness (Case A)',
      );
    }
    const targetBody =
      effectiveTarget.kind === 'thread'
        ? { kind: 'thread', message_id: effectiveTarget.messageId }
        : effectiveTarget.kind === 'channel'
          ? { kind: 'channel' }
          : effectiveTarget.target;
    const body: Record<string, unknown> = {
      content: params.content,
      ...(targetBody ? { target: targetBody } : {}),
      ...(params.attachment_ids ? { attachment_ids: params.attachment_ids } : {}),
      ...(params.freshness_bypass
        ? { freshness_bypass: true }
        : useFreshnessBoundary
          ? {
              seen_up_to_seq: seenUpToSeq,
              stream_key: targetStreamKey,
            }
          : {}),
      ...(pendingStale
        ? {
            stale_event_id: pendingStale.id,
            ...(params.freshness_bypass
              ? { stale_resolution_reason: 'force_send' }
              : params.stale_resolution_reason
                ? { stale_resolution_reason: params.stale_resolution_reason }
                : {}),
          }
        : {}),
    };
    const res = await this.backendPost(
      handle,
      internalPaths.agentSendConversationMessage(
        params.conversation_id,
        params.agent_id,
      ),
      body,
    );
    if (!res.ok) {
      const bodyText = await safeReadResponseText(res);
      const stale = res.status === 409 ? extractStaleConflict(bodyText) : null;
      if (stale) {
        // Signal-only contract: the 409 exposed NO bodies, so the observed
        // cursor does not move here. The unseen window arrives through the
        // normal delivery face (steer = this turn, next-turn-batch = next
        // boundary); admission evidence advances the cursor, and only then
        // does a retry pass the CAS.
        handle.pendingStaleEvent = stale;
      } else if (pendingStale) {
        handle.pendingStaleEvent = null;
      }
      return { ok: false, status: res.status, body_text: bodyText };
    }
    const json = (await res.json()) as Record<string, unknown>;
    const messageId = json['message_id'];
    const messageSeq = json['message_seq'];
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new Error('backend send-message response missing message_id');
    }
    // Learn the reply-target stream of both the message we replied to and
    // our own new message from the backend-resolved root, so a subsequent
    // `--reply-to` of either resolves to the right stream.
    const resolvedRoot =
      typeof json['thread_root_id'] === 'string' ? json['thread_root_id'] : null;
    if (threadTargetMessageId) {
      const stream = resolvedRoot
        ? `thread:${resolvedRoot}`
        : replyTargetStreamKey(threadTargetMessageId, null);
      this.rememberReplyTargetStream(handle, threadTargetMessageId, stream);
      this.rememberReplyTargetStream(handle, messageId, stream);
    }
    // Observed-advance asymmetry (Cindy ruling): a send into a KNOWN
    // stream proves — via the per-stream CAS the backend just ran — there
    // is no unseen gap, so advance that stream's observed to our own
    // message. An UNKNOWN-target send only records the mapping above;
    // advancing observed for a stream we have never read would defeat the
    // dumb-loop guard.
    //
    // A `freshness_bypass` (--anyway) success proves NOTHING (Cindy
    // countgame P1-B): no CAS ran, so jumping observed to our own seq
    // would silently swallow every unseen message in between (live trace:
    // 11→15/11→16 across an unadmitted 12–14) and permanently disarm the
    // guard. The forced message lands, but the cursor holds — the gap
    // stays armed until real admission evidence covers it.
    //
    // The own seq is NOT abandoned, though (Cindy follow-up P1): the
    // sender is excluded from its own fan-out, so nothing ever delivers
    // seq S back — holding forever would leave a permanent self-made
    // freshness hole (quiet stream: observed converges to the pre-bypass
    // head while head = S). The backend tells us the head at insert time
    // (`stream_head_before` = everything relevant we skipped); once
    // observed covers it, the own seq merges via `drainBypassMerges`.
    if (
      !params.freshness_bypass &&
      useFreshnessBoundary &&
      typeof messageSeq === 'number'
    ) {
      this.advanceObservedStream(
        handle,
        targetStreamKey,
        messageSeq,
        'message_send_commit',
      );
    } else if (
      params.freshness_bypass &&
      targetStreamKey !== undefined &&
      typeof messageSeq === 'number'
    ) {
      const headBefore = json['stream_head_before'];
      if (typeof headBefore === 'number' && Number.isSafeInteger(headBefore)) {
        const entries =
          handle.pendingBypassMergeByStream.get(targetStreamKey) ?? [];
        entries.push({ prereq: headBefore, ownSeq: messageSeq });
        // Bounded: chained bypasses beyond the cap drop the OLDEST entry —
        // degradation is the pre-fix behavior for that seq (recoverable
        // via any later message), never unbounded growth.
        while (entries.length > 32) entries.shift();
        handle.pendingBypassMergeByStream.set(targetStreamKey, entries);
        // No gap at all (or already caught up): merge immediately.
        this.drainBypassMerges(handle, targetStreamKey);
      }
    }
    handle.pendingStaleEvent = null;
    return {
      ok: true,
      message_id: messageId,
      ...(typeof messageSeq === 'number' ? { message_seq: messageSeq } : {}),
      thread_root_id: resolvedRoot,
    };
  }

  async agentStaleResolve(
    params: AgentStaleResolveParams,
  ): Promise<AgentStaleResolveResult> {
    const handle = this.getHandleForAgentIntent(
      params.conversation_id,
      params.agent_id,
    );
    const pendingStale = handle.pendingStaleEvent;
    const staleEventId = params.stale_event_id ?? pendingStale?.id;
    if (!staleEventId) {
      return { ok: true, resolved: false, reason: 'no_pending_stale_event' };
    }
    const res = await this.backendPost(
      handle,
      internalPaths.agentResolveStaleMessage(
        params.conversation_id,
        params.agent_id,
      ),
      {
        stale_event_id: staleEventId,
        resolution_reason: params.resolution_reason,
      },
    );
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        body_text: await safeReadResponseText(res),
      };
    }
    if (!params.stale_event_id || pendingStale?.id === params.stale_event_id) {
      handle.pendingStaleEvent = null;
    }
    return { ok: true, resolved: true };
  }

  /** Reply-cluster pull-observe (§6.4 B-light). The CLI fires this after a
   *  successful `message history --target thread:<root>` so the daemon —
   *  which never sees the HTTP pull — records that the agent observed the
   *  cluster: advance the `thread:<root>` observed boundary to the max
   *  REPLY seq (the caller already excluded the root's main-line seq) and
   *  map the surfaced ids (root + replies) to this stream so a later
   *  `--reply-to` of any of them resolves a known stream. Daemon-local
   *  only — no backend call, never marks a turn. */
  async agentStreamObserved(
    params: AgentStreamObservedParams,
  ): Promise<AgentStreamObservedResult> {
    const handle = this.getHandleForAgentIntent(
      params.conversation_id,
      params.agent_id,
    );
    const streamKey = streamKeyForMessage(params.thread_root_id);
    this.recordObservedStream(
      handle,
      streamKey,
      params.observed_seq,
      'pull_history_observed',
    );
    for (const messageId of params.reply_target_messages) {
      this.rememberReplyTargetStream(handle, messageId, streamKey);
    }
    return { ok: true };
  }

  // ── runtime_start ──────────────────────────────────────────────

  /**
   * Public start entry — funnels every (conv, agent) start through
   * the lifecycle lock, then the cooldown gate, then the actual
   * spawn path. Cindy plan v2:
   *   - Lock granularity: per-(conv, agent), not global. Different
   *     keys spawn in parallel; same key serializes start↔stop↔
   *     clearSession↔internal-retry-respawn.
   *   - Cooldown gate scope: ONLY for fresh user-initiated starts
   *     (`initAttempt === 0`) AND only when no live handle exists.
   *     Idempotent return for an already-running handle is the
   *     success arm even if cooldown would otherwise apply, and
   *     daemon-internal retry respawns (attempt > 0) bypass the gate
   *     entirely so an in-flight retry can complete.
   */
  async start(params: RuntimeStartParams): Promise<RuntimeStartResult> {
    return this.startWithLock(params, 0);
  }

  private startWithLock(
    params: RuntimeStartParams,
    initAttempt: number,
  ): Promise<RuntimeStartResult> {
    const k = key(params.conversation_id, params.agent_id);
    return this.withLifecycleLock(k, () => this.startUnlocked(params, initAttempt));
  }

  private async startUnlocked(
    params: StartUnlockedParams,
    initAttempt: number,
  ): Promise<RuntimeStartResult> {
    const k = key(params.conversation_id, params.agent_id);

    // Idempotent on (conv, agent) — second start while running
    // returns the existing pid + started_at, matching CM today.
    // A dead handle (phase === 'exited') is treated as gone; we
    // re-spawn. The repeat call's `startup_delivery` (if any) is
    // ignored: the original startup batch is the authoritative one
    // (start is not a delivery substitute). Callers wanting to push a
    // new batch after start must use `runtime_deliver`.
    //
    // v6 (#task:1417 Stage 2c): `runtime_start` is pure lifecycle — its
    // result is a bare `{started, pid, started_at}`, no `phase` /
    // `startup_delivery_accepted`. Delivery custody is transferred solely
    // by `runtime_deliver`'s sync disposition + async
    // `runtime_delivery_{consumed,failed}`; `startup_delivery` survives
    // only as the daemon-internal spawn-with-batch seam threaded here from
    // `deliver()`'s SPAWN arm.
    const existing = this.handles.get(k);
    if (existing && existing.phase !== 'exited') {
      return {
        started: true,
        pid: existing.pid,
        started_at: existing.startedAt,
      };
    }
    if (existing && existing.phase === 'exited') {
      this.handles.delete(k);
    }

    // 3c-b cooldown gate (Cindy plan v2 issue #3). Fires only when:
    //   - this is a fresh user-initiated start (initAttempt === 0), AND
    //   - no live handle remains (idempotent success returned above).
    // Internal retry respawns (initAttempt > 0) bypass — the watchdog
    // already decided retry eligibility at the moment of failure;
    // re-gating here would deadlock a half-spawned retry against its
    // own cooldown clock.
    if (initAttempt === 0 && this.isInitCoolingDown(k)) {
      const state = this.initRetryStates.get(k);
      const cooldownUntil = state?.cooldownUntil ?? this.now();
      this.logger.info(
        {
          kind: 'process',
          action: 'start_blocked_by_cooldown',
          conversationId: params.conversation_id,
          agent_id: params.agent_id,
          cooldown_until: cooldownUntil,
        },
        'start refused: init failure cooldown active',
      );
      return {
        started: false,
        reason: 'init_cooldown',
        cooldown_until: cooldownUntil,
      };
    }

    const startOptions = params.options;
    const runtimeKind = startOptions.driver.kind;

    // D4.e-6 — resolve every host path from the semantic wire options
    // (registry for `regular`, `computeAgentDir` for `agent_home`). Throws a
    // typed `RuntimeStartResolveError` (→ `workspace_not_provisioned` /
    // `registry_unavailable`) if a regular workspace is unbound; the
    // dispatcher projects it as the typed wire error. Done after the
    // idempotent + cooldown gates so an already-running handle never pays a
    // registry lookup, and before any spawn work so we never fork a child
    // against an unresolved cwd.
    const resolvedOptions = resolveRuntimeStartPaths(
      startOptions,
      this.runtimeStartResolveDeps,
    );
    await assertRuntimeStartWorkspacePath(resolvedOptions.workspace);

    const driver = this.driverFor(runtimeKind);
    const binary = await this.resolveBinary(runtimeKind, driver.binary);
    if (!binary) {
      throw new Error(
        `runtime_start: binary "${driver.binary}" for runtime "${runtimeKind}" not found on PATH`,
      );
    }

    const promptCtx =
      await buildPromptContextFromRuntimeStartOptions(resolvedOptions);
    const systemPromptText = buildSystemPromptFor(runtimeKind, promptCtx);
    const wireSilverhandCli = startOptions.env_policy.silverhand_cli;
    const serverSilverhandCli: SilverhandCliLauncher | null = wireSilverhandCli
      ? {
          command: wireSilverhandCli.command,
          args: wireSilverhandCli.args,
          ...(wireSilverhandCli.env_vars
            ? { env: wireSilverhandCli.env_vars }
            : {}),
        }
      : null;
    const controlPlaneServerUrl = this.controlPlaneServerUrl();
    if (!controlPlaneServerUrl) {
      throw new Error(
        'runtime_start: no silverhand server URL supplied by server and no daemon-local control-plane URL is attached',
      );
    }
    const spawnPrep = await prepareSpawnFiles({
      conversationId: params.conversation_id,
      agentId: params.agent_id,
      systemPromptText,
      silverhandCli: chooseSilverhandCliLauncher({
        serverLauncher: serverSilverhandCli,
        localLauncher: this.localSilverhandCliLauncher,
      }),
      silverhandEnv: {
        [SILVERHAND_CONVERSATION_ID_ENV]: params.conversation_id,
        [SILVERHAND_AGENT_ID_ENV]: params.agent_id,
        [SILVERHAND_SERVER_URL_ENV]: controlPlaneServerUrl,
        [SILVERHAND_AUTH_TOKEN_ENV]:
          startOptions.env_policy.silverhand.auth_token,
      },
      daemonSocketPath: this.daemonSocketPath ?? undefined,
    });

    const spawnCtx = {
      agentId: params.agent_id,
      agentName: startOptions.agent.name,
      workspacePath: resolvedOptions.workspace.path,
      cliSessionId: startOptions.driver.cli_session_id,
      model: startOptions.driver.model,
      reasoningEffort: startOptions.driver.reasoning_effort,
      fastMode: startOptions.driver.fast_mode,
      systemPromptPath: spawnPrep.systemPromptPath,
      initialPrompt: driver.oneShot ? params.startup_delivery?.text ?? '' : '',
    };

    const args = driver.buildArgs(spawnCtx);
    // Profile MCP (#task:1135): append the subject's additive MCP layer.
    // Keyed by runtime, drops the whole layer (loud) on a bad file but never
    // blocks spawn. Appended after buildArgs — both runtimes parse these flags
    // regardless of position. opencode (#task:1405) returns its layer via
    // `env` (OPENCODE_CONFIG_CONTENT) instead of argv.
    const mcpSpawn = await buildProfileMcpSpawnArgs({
      runtimeKind,
      agentHomeDir: resolvedOptions.agent.home_dir,
      spawnDir: spawnPrep.dir,
      systemPromptPath: spawnPrep.systemPromptPath,
      agentId: params.agent_id,
      logger: this.logger,
    });
    args.push(...(mcpSpawn.args ?? []));
    const daemonEnv = buildDaemonSpawnEnv({
      driver,
      options: startOptions,
      conversationId: params.conversation_id,
      agentId: params.agent_id,
      daemonSocketPath: this.daemonSocketPath ?? undefined,
      lastDeliveredSeqPath: spawnPrep.lastDeliveredSeqPath,
      binDir: spawnPrep.binDir,
      controlPlaneServerUrl,
      proxyConfig: readDaemonProxyConfig(this.proxyConfigPath(), this.logger),
    });
    const env: NodeJS.ProcessEnv = {
      ...daemonEnv,
      // The profile-MCP env layer (opencode's OPENCODE_CONFIG_CONTENT) is
      // authoritative for its own keys. The Silverhand identity/control-plane
      // env is re-applied below because those four keys are the child CLI's
      // integrity boundary and must not be shadowed by any additive layer.
      ...(mcpSpawn.env ?? {}),
      [SILVERHAND_CONVERSATION_ID_ENV]: daemonEnv[SILVERHAND_CONVERSATION_ID_ENV],
      [SILVERHAND_AGENT_ID_ENV]: daemonEnv[SILVERHAND_AGENT_ID_ENV],
      [SILVERHAND_SERVER_URL_ENV]: daemonEnv[SILVERHAND_SERVER_URL_ENV],
      [SILVERHAND_AUTH_TOKEN_ENV]: daemonEnv[SILVERHAND_AUTH_TOKEN_ENV],
    };
    const startedAt = this.now();

    // #task:1420 — pre-spawn diagnostics. Log-only: capture exactly what env
    // and which binary this daemon process is about to exec, so the next
    // runtime failure is legible without a repro. Secret-safe by construction
    // (see spawn-diagnostics.ts): no token/secret/cert body is emitted.
    this.logger.info(
      {
        kind: 'process',
        action: 'runtime_spawn_attempt',
        daemon_pid: process.pid,
        daemon_started_at: this.daemonStartedAt,
        conversationId: params.conversation_id,
        agent_id: params.agent_id,
        runtime: runtimeKind,
        binary,
        binary_source: platformBinaryCandidates(runtimeKind).includes(binary)
          ? 'platform_candidate'
          : 'path_or_detected',
        argv: redactSpawnArgs(args),
        cwd: spawnCtx.workspacePath,
        path_summary: summarizeSpawnPath(env.PATH),
        env_summary: summarizeSpawnEnv(env),
        silverhand_env_presence: {
          child: summarizeSilverhandEnvPresence(env),
          shim: spawnPrep.silverhandShimEnvPresence,
        },
      },
      'spawning runtime child',
    );

    const child = this.spawnFn(binary, args, {
      cwd: spawnCtx.workspacePath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // detached:false so SIGTERM on the daemon group reaches the
      // child without an explicit groupkill. CM uses the same.
    });

    // `spawn()` can return a ChildProcess with no pid and emit `error`
    // asynchronously. Register before checking pid so a single failed
    // runtime_start cannot become an unhandled EventEmitter error that
    // terminates the daemon.
    const earlyChildErrorListener = (err: Error): void => {
      const spawnError = describeSpawnError(err);
      this.logger.error(
        {
          kind: 'process',
          action: 'child_error_before_handle',
          daemon_pid: process.pid,
          daemon_started_at: this.daemonStartedAt,
          conversationId: params.conversation_id,
          agent_id: params.agent_id,
          runtime: runtimeKind,
          binary,
          binary_source: platformBinaryCandidates(runtimeKind).includes(binary)
            ? 'platform_candidate'
            : 'path_or_detected',
          workspace_path: spawnCtx.workspacePath,
          spawn_error: spawnError,
        },
        `runtime child failed to spawn before handle was registered: ${spawnError.readable}`,
      );
    };
    child.once('error', earlyChildErrorListener);

    const pid = child.pid;
    if (typeof pid !== 'number') {
      throw new Error(
        `runtime_start: child spawned without a pid for runtime "${runtimeKind}"`,
      );
    }
    try {
      this.writeRuntimePidfile({
        conversationId: params.conversation_id,
        agentId: params.agent_id,
        pid,
        startedAt,
        runtime: runtimeKind,
        cmd: binary,
      });
    } catch (err) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      throw new Error(
        `runtime_start: failed to write runtime pidfile for "${params.conversation_id}/${params.agent_id}": ${(err as Error).message}`,
      );
    }

    // Step-0 mutex (Cindy `_JjyK8UrpcmYA5Iu`): if backend supplied a
    // startup_delivery, the runtime starts in `startup_pending` and
    // the gate stays closed until the supervisor settles the batch.
    // Without startup_delivery the gate is already open.
    if (params.startup_delivery) {
      this.assertDeliveryMetadataConsistent(
        params.conversation_id,
        params.agent_id,
        params.startup_delivery.delivery_ids,
        params.startup_delivery.deliveries,
        'startup_delivery',
      );
    }
    const startupBatch = params.startup_delivery && !driver.oneShot
      ? {
          deliveryIds: [...params.startup_delivery.delivery_ids],
          deliveredUpToSeq: params.startup_delivery.delivered_up_to_seq,
          deliveries: params.startup_delivery.deliveries,
          text: params.startup_delivery.text,
        }
      : null;

    const handle: RuntimeHandle = {
      conversationId: params.conversation_id,
      agentId: params.agent_id,
      pid,
      startedAt,
      driver,
      child,
      lastDeliveredSeqPath: spawnPrep.lastDeliveredSeqPath,
      observedSeqByStream: new Map(),
      pendingAdmissionSeqByStream: new Map(),
      pendingBypassMergeByStream: new Map(),
      replyTargetStreamByMessageId: new Map(),
      defaultReplyTarget: CHANNEL_DEFAULT_REPLY_TARGET,
      pendingDefaultReplyTarget: undefined,
      inputTurnActive: driver.oneShot && !!params.startup_delivery,
      nextTurnReserved: false,
      nextTurnReservedAt: null,
      reservationStallWarned: false,
      reservationStallTimer: null,
      turnEndCount: 0,
      pendingStaleEvent: null,
      inputPayloadUuids: new Map(),
      phase: startupBatch ? 'startup_pending' : 'spawning',
      outputPaused: false,
      exitCode: null,
      intentionalExit: false,
      sigkillTimer: null,
      // 3b additions
      startupDelivery: startupBatch,
      startupAwaitingInit: false,
      startupConsumeInFlight: false,
      readyForDrainEmitted: false,
      initObserved: false,
      cliSessionId: spawnCtx.cliSessionId,
      stdoutLineBuffer: '',
      runState: null,
      activitySnippetBuffer: null,
      busy: { outstandingToolUses: 0, compacting: false },
      deferredQueue: [],
      flushingDeferred: false,
      // 3c-b additions
      // Strip `startup_delivery` from the cached params so an internal
      // retry respawn doesn't try to replay a payload the previous
      // attempt already consumed (or already failed). Backend re-pumps
      // pending inbox rows via `runtime_deliver` against the new handle.
      spawnParams: {
        conversation_id: params.conversation_id,
        agent_id: params.agent_id,
        options: params.options,
      },
      initWatchdogArmed: false,
      initStartedAt: startedAt,
      initProtocolObserved: false,
      initTimedOut: false,
      initTimeoutReason: null,
      initLivenessSilenceTimer: null,
      initPreProtocolCapTimer: null,
      initPostProtocolTimer: null,
      initAttempt,
      initRetryPlanned: false,
      compactionWatchdog: null,
    };
    this.handles.set(k, handle);

    this.logger.info(
      {
        kind: 'process',
        action: 'spawn',
        pid,
        conversationId: handle.conversationId,
        agent_id: handle.agentId,
        runtime: runtimeKind,
        startup_delivery: startupBatch ? startupBatch.deliveryIds : null,
      },
      'spawned agent runtime',
    );

    // Initial phase emit — same contract as FakeSupervisor.
    this.emitState(handle);

    this.attachChildListeners(handle);
    child.off('error', earlyChildErrorListener);

    if (driver.oneShot && params.startup_delivery) {
      // oneShot drivers consume the startup batch at spawn time (no gate).
      // Admit it into the per-stream observed map now so the agent's first
      // send picks the right per-stream seen boundary.
      this.admitDeliveryBatch(
        handle,
        params.startup_delivery.deliveries,
        params.startup_delivery.delivered_up_to_seq,
        true,
        'oneshot_startup_admitted',
      );
      void this.writeLastDeliveredSeq(
        handle,
        params.startup_delivery.delivered_up_to_seq,
      );
      this.emitStartupDeliveryConsumed(
        handle,
        params.startup_delivery.delivery_ids,
      );
    }

    // 3c-b: driver-side init handshake. Codex needs `bindIO` to send
    // its JSON-RPC `initialize` → `thread/start` immediately after
    // spawn — without it the child never reaches `thread/started` and
    // every spawn hits the post-protocol watchdog. Drivers without a
    // handshake (claude, cursor) leave `bindIO` undefined.
    //
    // The writeLine wrapper (a) routes through `writeStdinPayload`
    // which is the single point of stdin writes (preserves the
    // backpressure / drain semantics) and (b) asserts the driver did
    // NOT include a trailing `\n` — `writeStdinPayload` always appends
    // one, so a driver that already terminates would emit a
    // double-newline frame. Cindy `-pdNvRYOWip5e9yA` flagged this as
    // the bindIO failure mode worth catching at the seam, not at the
    // child. Cindy `HyC05fC-FEs94uoZ` follow-up: throw SYNCHRONOUSLY
    // (not a rejected Promise) — drivers like Codex call
    // `void this.io?.writeLine(...)` which would swallow a rejection
    // into an unhandled rejection. A sync throw blows up the bound
    // callsite immediately and surfaces during driver-author testing.
    if (handle.driver.bindIO) {
      handle.driver.bindIO({
        writeLine: (line: string) => {
          if (line.endsWith('\n')) {
            throw new Error(
              'driver.writeLine: line must not end with "\\n" (writeStdinPayload appends the newline)',
            );
          }
          return this.writeStdinPayload(handle, line);
        },
        spawnCtx,
      });
    }

    // 3c-b: 3-tier init watchdog. Two arming paths:
    //
    //   - `self_inits`: arm immediately at spawn. These runtimes own
    //     their startup protocol and should emit session-ready without
    //     any user stdin.
    //   - `requires_first_message`: defer until the FIRST successful
    //     stdin write (a `runtime_deliver` batch — at spawn or into a
    //     ready handle). Claude
    //     Code does not emit `system.init` merely because the process
    //     spawned; it emits only after accepting a real user turn. A
    //     spawn-time watchdog therefore kills legitimate idle Claude
    //     processes and retry respawns that are waiting for backend to
    //     replay the still-pending inbox row.
    if (handle.driver.kickoffMode !== 'requires_first_message') {
      this.startInitWatchdog(handle);
    }

    // Optimistic ready transition. The init watchdog is armed above
    // when required; we still mark the runtime `ready` after a single
    // tick so backend can observe a live process while protocol init
    // continues. The startup_delivery write below settles
    // asynchronously; until it settles, `maybeEmitReadyForDrain` is
    // gated by `handle.startupDelivery !== null` and will not emit.
    // (Cindy `_JjyK8UrpcmYA5Iu`: pending startup batch keeps
    // ready_for_drain bottled up; a concurrent `runtime_deliver` is
    // sync-refused `startup_pending` during the same window.)
    setImmediate(() => {
      if (handle.phase !== 'spawning' && handle.phase !== 'startup_pending') {
        return;
      }
      handle.phase = 'ready';
      this.emitState(handle);
      this.maybeEmitReadyForDrain(handle);
    });

    // Consume startup_delivery asynchronously — settle order (Cindy
    // `wuiwdLKrLFyGip_s` + Option A v2 `UMGu36zoTDVuKWXi`):
    //   1. wait until `driver.readyToEncode()` (stateless drivers like
    //      claude: immediate; stateful drivers like codex: after
    //      `thread/started`)
    //   2. encode raw text via `driver.encodeStdinMessage(text, cliSessionId)`
    //   3. write encoded line to stdin (or fail)
    //   4. emit `runtime_delivery_consumed` OR `_failed`
    //   5. clear `handle.startupDelivery = null`
    //   6. THEN re-evaluate ready_for_drain
    // We don't `await` here — start() must return promptly so backend
    // can move on; the settle continues on the next microtask.
    if (startupBatch) {
      void this.consumeStartupDelivery(handle);
    }

    return {
      started: true,
      pid,
      started_at: startedAt,
    };
  }

  private async consumeStartupDelivery(handle: RuntimeHandle): Promise<void> {
    // Option A v2 (Cindy `UMGu36zoTDVuKWXi`): startup batch carries
    // RAW TEXT on `handle.startupDelivery.text`. Daemon owns encode
    // because the driver instance with the right runtime state lives
    // here, not in backend. Two stateful pre-conditions, in order:
    //
    //   - exited/draining → fail with `child_exit` (same as before)
    //   - `!driver.readyToEncode()` → DEFER until init/handshake.
    //     For codex, `readyToEncode = threadId !== null`. The deferred
    //     consume kicks back in from `updateRunStateFromParsed` after
    //     `session_init` (claude) or `handleThreadReady` (codex) flips
    //     state. The gate stays closed across the defer so a concurrent
    //     `runtime_deliver` and `runtime_ready_for_drain` keep their
    //     blocking behavior.
    //   - encode returns null AFTER ready → fail with `driver_refused`
    //     (config/programming error; fail loud per Cindy
    //     `0G5uJBydO_4qt_2r`)
    //   - encode + write succeeds → settle as consumed (or, for the
    //     `requires_first_message + !initObserved` arm, mark
    //     `startupAwaitingInit` and let `session_init` settle —
    //     unchanged from 3b).
    //
    // After ANY settle, the gate clears via `clearStartupGate` (which
    // wipes both `startupDelivery` and `startupAwaitingInit`) and we
    // re-evaluate `ready_for_drain` exactly once.
    const batch = handle.startupDelivery;
    if (!batch) return; // gate already cleared by another path
    handle.startupConsumeInFlight = true;
    try {
      await this.consumeStartupDeliveryLatched(handle, batch);
    } finally {
      handle.startupConsumeInFlight = false;
    }
  }

  /** Body of {@link consumeStartupDelivery}; runs under the
   *  `startupConsumeInFlight` latch. */
  private async consumeStartupDeliveryLatched(
    handle: RuntimeHandle,
    batch: StartupDeliveryState,
  ): Promise<void> {
    const deliveryIds = batch.deliveryIds;

    if (handle.phase === 'exited' || handle.phase === 'draining') {
      this.emitStartupDeliveryFailed(handle, deliveryIds, 'child_exit');
      this.clearStartupGate(handle);
      this.maybeEmitReadyForDrain(handle);
      return;
    }

    const driverReady = driverReadyToEncode(handle.driver);
    if (!driverReady) {
      // Defer — driver not ready yet. session_init / handleThreadReady
      // will retry via `tryConsumeStartupDelivery(handle)`. NO emit, NO
      // gate clear; the batch stays pending. Log once per defer so the
      // operator can see the transition.
      this.logger.info(
        {
          kind: 'process',
          action: 'startup_delivery_defer_pre_ready',
          pid: handle.pid,
          conversationId: handle.conversationId,
          agent_id: handle.agentId,
          delivery_ids: [...deliveryIds],
        },
        'startup_delivery deferred: driver not ready to encode (e.g. codex pre-thread/started)',
      );
      return;
    }

    const payloadUuid = this.mintInputPayloadUuid(
      handle,
      deliveryIds,
      coveredSeqPairsForBatch(batch),
    );
    const encoded = handle.driver.encodeStdinMessage(batch.text, handle.cliSessionId, {
      payloadUuid,
    });
    if (encoded === null) {
      // Driver claims ready_to_encode but still refused. This is a
      // driver-author bug; fail loud per Cindy `0G5uJBydO_4qt_2r`.
      this.logger.warn(
        {
          kind: 'process',
          action: 'startup_delivery_driver_refused',
          pid: handle.pid,
          conversationId: handle.conversationId,
          agent_id: handle.agentId,
          delivery_ids: [...deliveryIds],
          text_bytes: batch.text.length,
        },
        'startup_delivery encode returned null after driver claimed ready (driver bug?)',
      );
      this.emitStartupDeliveryFailed(handle, deliveryIds, 'driver_refused');
      this.clearStartupGate(handle);
      this.maybeEmitReadyForDrain(handle);
      return;
    }

    try {
      // #task:1471 — mid-turn deliveries must NOT advance the model-seen
      // observed cursor. `consumeStartupDelivery` is the shared write path for
      // spawn/session-init AND mid-turn (`deliver` admitted arm + deferred
      // flush), so route the admit decision through the same
      // `shouldAdmitDeliveryImmediately(handle)` gate the pre-#1417 wake path
      // used: turn active → queue into `pendingAdmissionSeqByStream` (promoted
      // by `admitPendingSeqForNewTurn` on the next `parsedStartsTurn`); turn
      // not active → admit now. Hardcoding `true` here was the freshness
      // regression that let mid-turn writes silently bump `observedSeqByStream`
      // between the model's turn-start context capture and its send, so
      // `agentMessageSend` reported a `seen_up_to_seq` covering messages the
      // model never had in scope and CAS never staled the reply.
      //
      // Snapshot the decision BEFORE `await writeStdinPayload`. `dispatchParsedLine`
      // runs synchronously from the stdout data listener and is NOT scoped
      // under this handle's lifecycle lock, so `turn_end` processed during
      // the write's await window would flip `inputTurnActive=false` and — if
      // we read the decision post-await — cause a batch decided upon while
      // the prior turn was active to slip past the pending-admission gate
      // (Cindy: same-invariant race that the pre-#1417 `runtime_wake` path
      // avoided by snapshotting first).
      const admitNow = this.shouldAdmitDeliveryImmediately(handle);
      const turnEndsBeforeWrite = handle.turnEndCount;
      await this.writeStdinPayload(handle, encoded);
      if (
        handle.driver.releaseProfile === 'next-turn-batch' &&
        handle.turnEndCount === turnEndsBeforeWrite
      ) {
        // §3.4 step 2: reserve the next turn the instant the write
        // lands — do NOT wait for the runtime's first activity frame.
        // Guarded by the turn-end snapshot: if the terminal for this
        // very write crossed the await window (fast runtime), arming
        // now would overwrite a finished turn back into "reserved" and
        // hold the queue forever (#1558 final-gate P1-1).
        handle.nextTurnReserved = true;
        handle.nextTurnReservedAt = this.now();
        handle.reservationStallWarned = false;
        // Fresh reservation: drop any stall timer from the previous one
        // and re-schedule if a bounded-prefix remainder is still queued.
        this.clearReservationStallTimer(handle);
        this.scheduleReservationStallCheck(handle);
      }
      this.admitDeliveryBatch(
        handle,
        batch.deliveries,
        batch.deliveredUpToSeq,
        admitNow,
        admitNow
          ? 'startup_delivery_admitted'
          : 'startup_delivery_queued_mid_turn',
      );
      await this.writeLastDeliveredSeq(handle, batch.deliveredUpToSeq);
    } catch (err) {
      this.logger.warn(
        {
          kind: 'process',
          action: 'startup_delivery_write_failed',
          pid: handle.pid,
          conversationId: handle.conversationId,
          agent_id: handle.agentId,
          delivery_ids: [...deliveryIds],
          error_message: (err as Error).message,
        },
        'startup_delivery stdin write failed',
      );
      this.emitStartupDeliveryFailed(handle, deliveryIds, 'write_failed');
      this.clearStartupGate(handle);
      this.maybeEmitReadyForDrain(handle);
      return;
    }

    // `requires_first_message` drivers reach session init only after
    // this first real user turn lands on stdin. Arm the init watchdog
    // from the write boundary, not from process spawn. For self-init
    // drivers the watchdog was already armed at spawn, so this is a
    // no-op.
    this.ensureInitWatchdogArmed(handle);

    // Write succeeded. For `requires_first_message` drivers (claude) we
    // must defer the consumed emit until `session_init` confirms the
    // runtime actually accepted the turn — `startupAwaitingInit`
    // marks this sub-state. The gate (`startupDelivery !== null`)
    // stays closed, so delivery → `startup_pending` and
    // `runtime_ready_for_drain` remain blocked until session_init.
    // For self-init drivers (kickoffMode !== 'requires_first_message'),
    // or when initObserved is already true (e.g. resume path), settle now.
    if (
      handle.driver.kickoffMode === 'requires_first_message' &&
      !handle.initObserved
    ) {
      handle.startupAwaitingInit = true;
      this.logger.info(
        {
          kind: 'process',
          action: 'startup_delivery_awaiting_init',
          pid: handle.pid,
          conversationId: handle.conversationId,
          agent_id: handle.agentId,
          delivery_ids: [...deliveryIds],
        },
        'startup_delivery written; deferring consumed until session_init',
      );
      return;
    }
    this.emitStartupDeliveryConsumed(handle, deliveryIds);
    this.clearStartupGate(handle);
    this.maybeEmitReadyForDrain(handle);
  }

  /** Re-attempt a deferred startup_delivery after a driver-state
   *  transition (claude session_init OR codex handleThreadReady).
   *  Idempotent: no-op when no gate is pending or when driver is
   *  still not ready. Kept as a separate entry so the run-state
   *  handler can call it without re-deriving "did we just become
   *  ready". */
  private tryConsumeStartupDelivery(handle: RuntimeHandle): void {
    if (!handle.startupDelivery) return;
    if (handle.startupAwaitingInit) return; // write done, awaiting init
    // #task:1563: a consume is mid-write (dispatchParsedLine runs outside
    // the lifecycle lock, so session_init can land inside that await
    // window). Re-entering would write the SAME batch to stdin twice —
    // duplicate exposure + double consumed. The in-flight consume settles
    // on its own (initObserved is already true by now).
    if (handle.startupConsumeInFlight) return;
    if (!driverReadyToEncode(handle.driver)) return;
    void this.consumeStartupDelivery(handle);
  }

  /**
   * Clear the step-0 gate. ALWAYS clears both `startupDelivery`
   * AND `startupAwaitingInit` in the same critical section so the
   * `(startupDelivery=null, startupAwaitingInit=true)` interleaving
   * is impossible (Cindy `GMbjEkGUHrB1BBMe`). Callers must emit
   * the appropriate `_consumed` / `_failed` BEFORE calling this so
   * the wire order stays "settle event → clear gate → maybe ready".
   */
  private clearStartupGate(handle: RuntimeHandle): void {
    handle.startupDelivery = null;
    handle.startupAwaitingInit = false;
    // Post-write re-drive (#task:1417 Stage 3, §11.4): the single delivery
    // slot just freed, so a queued deferred batch may now be admissible.
    // Guarded + lock-serialized inside; a no-op while a flush is active
    // (that path re-drives from its own `finally`).
    this.maybeScheduleDeferredFlush(handle);
  }

  /**
   * Emit the "batch consumed" ack for `handle`'s current startup batch.
   * Every startup batch now arrives via `runtime_deliver` (Stage 2c retired
   * `runtime_start`'s batch + `runtime_wake`), so this always settles onto
   * the unified `runtime_delivery_consumed`. It is `delivery_ids`-keyed and
   * is backend's `markDelivered` trigger — the ONLY thing that flips
   * `delivered_at`.
   */
  private emitStartupDeliveryConsumed(
    handle: RuntimeHandle,
    deliveryIds: readonly number[],
  ): void {
    this.emit({
      event: 'runtime_delivery_consumed',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      delivery_ids: [...deliveryIds],
      ts: this.now(),
    });
  }

  /** Mirror of {@link emitStartupDeliveryConsumed} for the failure ack.
   *  Always the unified `runtime_delivery_failed`; backend rolls the batch
   *  back to pending (retriable reasons) or marks it failed
   *  (`driver_refused` programming error). */
  private emitStartupDeliveryFailed(
    handle: RuntimeHandle,
    deliveryIds: readonly number[],
    reason: 'child_exit' | 'write_failed' | 'driver_refused' | 'init_watchdog',
  ): void {
    this.emit({
      event: 'runtime_delivery_failed',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      delivery_ids: [...deliveryIds],
      reason,
      ts: this.now(),
    });
  }

  /**
   * Step-0 ready_for_drain gate. The single arbiter of when this
   * event fires; called from (a) start()'s setImmediate ready
   * transition, (b) every startup_delivery settle, and (c) the
   * session_init / handleThreadReady tryConsume path. Idempotent
   * via `handle.readyForDrainEmitted` so re-entry is harmless.
   *
   * Conditions (Cindy `wuiwdLKrLFyGip_s` + Option A v2
   * `UMGu36zoTDVuKWXi`):
   *   - phase === 'ready'                 (runtime is live)
   *   - startupDelivery === null          (no pending batch)
   *   - driver.readyToEncode()            (codex post-`thread/started`;
   *                                        stateless drivers always
   *                                        return true)
   *   - !readyForDrainEmitted             (one-shot per run)
   *   - !driver.oneShot                   (one-shot runtimes cannot live-drain)
   *
   * Explicitly NOT gated on `initObserved` — see Cindy plan v2.
   * `requires_first_message + empty-inbox` claude reaches `ready`
   * before `session_init`; we still want `runtime_ready_for_drain`
   * to fire so backend can drain its inbox (the first write is
   * what makes claude emit `session_init` in the first place).
   * For codex the equivalent gate IS `readyToEncode()` because
   * `encodeStdinMessage` returns null pre-`thread/started`.
   */
  private maybeEmitReadyForDrain(handle: RuntimeHandle): void {
    if (handle.readyForDrainEmitted) return;
    if (handle.phase !== 'ready') return;
    if (handle.driver.oneShot) return;
    if (handle.startupDelivery !== null) return;
    if (!driverReadyToEncode(handle.driver)) return;
    handle.readyForDrainEmitted = true;
    this.emit({
      event: 'runtime_ready_for_drain',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      ts: this.now(),
    });
  }

  // ── runtime_stop ───────────────────────────────────────────────

  async stop(params: RuntimeStopParams): Promise<RuntimeStopResult> {
    const k = key(params.conversation_id, params.agent_id);
    return this.withLifecycleLock(k, async () => {
      const handle = this.handles.get(k);
      if (!handle || handle.phase === 'exited') {
        return { mode: 'hard', stopped: false, exit_code: null };
      }
      return this.hardStopHandle(handle);
    });
  }

  /**
   * Internal helper shared by `stop()` and `stopAll`.
   * Initiates the SIGTERM → SIGKILL cascade and resolves only AFTER
   * the child has actually exited (or the SIGKILL timeout fired).
   * The returned `exit_code` is whatever the OS surfaced via the
   * `'exit'` event; the cascade timer is cleared in the exit
   * handler.
   */
  private hardStopHandle(handle: RuntimeHandle): Promise<RuntimeStopResult> {
    handle.intentionalExit = true;
    handle.phase = 'draining';
    // Cindy `HyC05fC-FEs94uoZ` B2: a user-initiated hard stop must
    // cancel any in-flight init watchdog (and compaction watchdog) AT
    // DRAINING ENTRY, mirroring CM (`conversation-manager.ts`
    // lines 1020-1023, `clearInitWatchdog(h)` right after
    // `intentionallyStopped = true`). Without this, the timer would
    // keep ticking inside the SIGTERM grace window; if it fired before
    // the child actually exited, `failInitWatchdog` would set
    // `initTimedOut = true` and the exit handler's reason-mapping
    // would pick `'timeout'` over `'stopped'`, polluting terminal
    // state, retry/cooldown bookkeeping, and the startup_delivery
    // failed reason (`init_watchdog` instead of `child_exit`). Same
    // rationale applies to the compaction watchdog — a stale-emit
    // mid-shutdown is just noise on the wire and wastes a
    // run-state diff.
    this.clearInitWatchdog(handle);
    this.clearCompactionWatchdog(handle);
    this.emitState(handle);

    const exitPromise = new Promise<RuntimeStopResult>(resolve => {
      const onExit = (code: number | null): void => {
        // The actual exit emit is handled by `attachChildListeners`;
        // we only resolve the stop() promise here.
        resolve({ mode: 'hard', stopped: true, exit_code: code });
      };
      // Listen on a dedicated channel — handle.child.once('exit') is
      // already bound by attachChildListeners (which emits the
      // runtime_exit event); we add a second listener whose only job
      // is to resolve this promise.
      handle.child.once('exit', onExit);

      // Safety net: if the child somehow never fires 'exit' inside
      // our SIGKILL window the dispatcher cannot hang waiting on us,
      // so we resolve — but Cindy `OQCA05pivtB8nSTC` B2: we must NOT
      // claim `stopped: true`. The child is still alive (or in an
      // unknown zombie state); pretending it was reaped would let the
      // caller mark cleanup done and free downstream resources while
      // the OS-level handle persists. The honest answer is
      // `stopped: false, exit_code: null` with the handle left in
      // `draining` — when/if the child eventually exits, the primary
      // `attachChildListeners.once('exit')` will still fire and emit
      // `runtime_exit`, and the second `onExit` listener resolving
      // again is a harmless no-op on an already-settled promise.
      const timeout = setTimer(() => {
        if (handle.phase !== 'exited') {
          this.logger.warn(
            {
              kind: 'process',
              action: 'sigkill_timeout',
              pid: handle.pid,
              conversationId: handle.conversationId,
              agent_id: handle.agentId,
              timeout_ms: this.sigkillTimeoutMs,
            },
            'child did not exit within sigkill timeout',
          );
          resolve({ mode: 'hard', stopped: false, exit_code: null });
        }
      }, this.sigkillTimeoutMs);
      timeout.unref();
    });

    // Send SIGTERM immediately; escalate to SIGKILL after the
    // configured grace period. This is the same cascade CM uses
    // (`stopSigtermMs` → `stopSigkillMs`).
    this.logger.info(
      {
        kind: 'process',
        action: 'sigterm',
        pid: handle.pid,
        conversationId: handle.conversationId,
        agent_id: handle.agentId,
      },
      'sending SIGTERM to runtime',
    );
    try {
      handle.child.kill('SIGTERM');
    } catch {
      // Process already gone — exit listener will resolve us.
    }
    handle.sigkillTimer = setTimer(() => {
      handle.sigkillTimer = null;
      if (handle.phase === 'exited') return;
      this.logger.warn(
        {
          kind: 'process',
          action: 'sigkill',
          pid: handle.pid,
          conversationId: handle.conversationId,
          agent_id: handle.agentId,
        },
        'escalating to SIGKILL after grace period',
      );
      try {
        handle.child.kill('SIGKILL');
      } catch {
        // Process already gone — exit listener will resolve us.
      }
    }, this.sigtermToSigkillMs);
    handle.sigkillTimer.unref();

    return exitPromise;
  }

  // ── runtime_deliver (Stage 3, #task:1417) ──────────────────────

  /**
   * Daemon-authoritative delivery — the single command that subsumes the
   * backend start-vs-wake fork. Backend claims the pending batch in-flight
   * then hands it here; the daemon, sole owner of runtime-lifecycle truth,
   * picks spawn / write / defer / refuse against the REAL handle rather than
   * the backend's desyncable `RunStateCache` (the #task:1416 bug class).
   * Canonical: docs/daemon-authoritative-delivery-v1.md §11.
   *
   * LOAD-BEARING (§11): the synchronous result transfers or refuses CUSTODY
   * only — it never acks the DB. `delivered_at` flips solely on the async
   * `runtime_delivery_consumed` this path ultimately emits (or rolls back on
   * `runtime_delivery_failed`). "Sent to daemon" ≠ ack. This holds for every
   * arm, including `deferred`.
   *
   * Four arms, all under the per-(conv,agent) lifecycle lock so a concurrent
   * stop / start / retry-respawn cannot race the handle read:
   *   - SPAWN — no live handle (absent or exited) → `startUnlocked` with the
   *     batch as its startup delivery. `spawning`, or `refused{cooldown}`
   *     when the init-failure cooldown gate is active.
   *   - REFUSE — draining (hard stop in flight) → `refused{draining}`; or a
   *     startup-phase / live-oneShot handle (still spawning/startup_pending,
   *     driver not ready to encode, or a oneShot that drains its inbox only
   *     at spawn) → `refused{startup_pending}`. These are DELIBERATELY not
   *     folded into the deferred queue (§11.2): each has a lossless DB-backed
   *     re-drive (`runtime_ready_for_drain`, or exit→respawn-with-batch), so
   *     volatile daemon custody would be strictly worse on crash-safety.
   *   - DEFER — a ready, encode-ready, non-oneShot handle that cannot take
   *     the write RIGHT NOW (§11.3): a `gated` driver caught mid-turn
   *     (boundary closed), or a prior write still in flight. Custody moves
   *     into the per-handle deferred queue keyed by the injected owner and is
   *     flushed at the next safe boundary / when the in-flight write clears.
   *     `deferred`.
   *   - ADMIT — a ready handle safe to write now → place the batch on the
   *     handle and drive it through the SAME `consumeStartupDelivery` machine
   *     the spawn path uses (init-proof deferral for `requires_first_message`
   *     drivers, encode, write, seq flush, consumed/failed emit). `admitted`
   *     the instant custody sits on the handle.
   */
  async deliver(
    params: RuntimeDeliverParams,
    ctx: DeliveryOwnerContext,
  ): Promise<RuntimeDeliverResult> {
    const k = key(params.conversation_id, params.agent_id);
    return this.withLifecycleLock(k, async () => {
      // Fail loud on a drifted batch before any custody decision — the
      // same consistency contract the spawn-time startup batch enforces.
      this.assertDeliveryMetadataConsistent(
        params.conversation_id,
        params.agent_id,
        params.delivery_ids,
        params.deliveries,
        'runtime_deliver',
      );

      const handle = this.handles.get(k);

      // ── SPAWN arm: no live handle ──────────────────────────────
      if (!handle || handle.phase === 'exited') {
        const result = await this.startUnlocked(
          {
            conversation_id: params.conversation_id,
            agent_id: params.agent_id,
            options: params.spawn_options,
            startup_delivery: {
              delivery_ids: [...params.delivery_ids],
              ...(params.delivered_up_to_seq !== undefined
                ? { delivered_up_to_seq: params.delivered_up_to_seq }
                : {}),
              ...(params.deliveries ? { deliveries: params.deliveries } : {}),
              text: params.text,
            },
          },
          0,
        );
        if (result.started) {
          return {
            disposition: 'spawning',
            pid: result.pid,
            started_at: result.started_at,
          };
        }
        // The only non-started `startUnlocked` result is the init-failure
        // cooldown gate. Custody stays with backend (retriable).
        return {
          disposition: 'refused',
          reason: 'cooldown',
          cooldown_until: result.cooldown_until,
        };
      }

      // ── REFUSE arms: draining / startup-phase / live oneShot ────
      if (handle.phase === 'draining') {
        return { disposition: 'refused', reason: 'draining' };
      }
      if (
        handle.driver.oneShot ||
        handle.phase === 'spawning' ||
        handle.phase === 'startup_pending' ||
        (!driverReadyToEncode(handle.driver) && !handle.initObserved)
      ) {
        // Startup-phase or live oneShot — DELIBERATELY NOT folded into the
        // daemon deferred queue (§11.2). Each already has a lossless
        // DB-backed re-drive: `runtime_ready_for_drain` once the handle is
        // ready + its startup batch consumed (spawning/startup_pending/
        // pre-init not-ready-to-encode), or exit→respawn-with-batch for a
        // live oneShot. Taking volatile daemon custody here would be
        // strictly worse on crash-safety for zero benefit, so we refuse
        // and let the backend keep the rows pending and resubmit.
        //
        // POST-init `!readyToEncode` is NOT this arm (#task:1565): for a
        // prompt-boundary runtime the encoder goes un-ready on EVERY
        // active prompt, and `ready_for_drain` is once-per-run — refusing
        // here would starve the rows until an unrelated live delivery.
        // Those land in the DEFER arm below (boundary closed), custody in
        // the daemon queue, flushed when the prompt response reopens.
        return { disposition: 'refused', reason: 'startup_pending' };
      }

      // Here: phase === 'ready', not oneShot. The driver is ready to
      // encode OR (post-init, gated profile) its boundary is closed —
      // the defer arm below takes the closed-boundary case before the
      // admit arm can reach the encoder.
      const gated = profileUsesBoundaryGate(handle);
      const writeInFlight = handle.startupDelivery !== null;
      const boundaryOpen = strategyBoundaryOpen(handle);

      // ── DEFER arm: ready, but cannot take the write RIGHT NOW (§11.3) ──
      // Two custody-into-daemon-queue cases, both keep the rows in-flight:
      //   - `gated` driver caught mid-turn (boundary closed) — flushed at
      //     the next `turn_end`;
      //   - a prior write still in flight (the single `startupDelivery`
      //     slot is busy) — the consecutive-delivery window, re-driven
      //     after that write's consumed clears the slot.
      // `deferred` is a custody transfer, NOT an ack — `delivered_at` still
      // moves only on the async `runtime_delivery_consumed` the eventual
      // flush emits.
      if (writeInFlight || (gated && !boundaryOpen)) {
        this.enqueueDeferred(handle, params, ctx.owner);
        this.scheduleReservationStallCheck(handle);
        return {
          disposition: 'deferred',
          pid: handle.pid,
          started_at: handle.startedAt,
        };
      }

      // ── ADMIT arm: ready handle, safe to write now ─────────────
      // Route the batch through the same consume machine the spawn path
      // uses (init-proof deferral, encode, write, admit, seq flush,
      // consumed/failed emit). Custody transfers the instant the batch
      // sits on the handle; the async ack settles `delivered_at`.
      handle.startupDelivery = {
        deliveryIds: [...params.delivery_ids],
        ...(params.delivered_up_to_seq !== undefined
          ? { deliveredUpToSeq: params.delivered_up_to_seq }
          : {}),
        ...(params.deliveries ? { deliveries: params.deliveries } : {}),
        text: params.text,
      };
      void this.consumeStartupDelivery(handle);
      return {
        disposition: 'admitted',
        pid: handle.pid,
        started_at: handle.startedAt,
      };
    });
  }

  /**
   * Owner-scoped deferred-queue cleanup (#task:1417 Stage 3, §11.4.1).
   * Called by an ingress when its connection drops (control-socket close,
   * local-outbound socket close, or outbound-WS close/reconnect/stop):
   * discard ONLY the deferred (unwritten) batches this owner enqueued,
   * across every handle, emitting NOTHING. The backend rolls the matching
   * in-flight rows back to `pending` on its own disconnect handler and
   * reconnect replay re-drives them, so a `consumed`/`failed` here would be
   * wrong (nothing was written) and a double-delivery risk. Never touches
   * another owner's entries; idempotent.
   */
  cleanupDeferredForOwner(owner: string): void {
    let discarded = 0;
    for (const handle of this.handles.values()) {
      if (handle.deferredQueue.length === 0) continue;
      const before = handle.deferredQueue.length;
      handle.deferredQueue = handle.deferredQueue.filter(
        entry => entry.owner !== owner,
      );
      discarded += before - handle.deferredQueue.length;
    }
    if (discarded > 0) {
      this.logger.info(
        { kind: 'process', action: 'deferred_owner_cleanup', owner, discarded },
        'discarded deferred deliveries for dropped connection owner',
      );
    }
  }

  /** Stall diagnostics for a `next-turn-batch` reservation (#task:1563,
   *  doc §3.4; Cindy P1-1: timeout-triggered, not inflow-triggered — a
   *  non-empty deferred queue with no further deliveries must still get
   *  its warn). Scheduled when an entry defers under a held reservation
   *  and on a re-arm that leaves a queue remainder. The timer only ever
   *  logs: it never writes and never releases the hold. One-shot per
   *  reservation via `reservationStallWarned`; latch and timer reset when
   *  the next write re-arms. */
  private scheduleReservationStallCheck(handle: RuntimeHandle): void {
    if (!handle.nextTurnReserved || handle.nextTurnReservedAt === null) return;
    if (handle.reservationStallWarned) return;
    if (handle.reservationStallTimer !== null) return;
    if (handle.deferredQueue.length === 0) return;
    const remaining =
      this.reservationStallWarnMs - (this.now() - handle.nextTurnReservedAt);
    if (remaining <= 0) {
      this.warnReservationStall(handle);
      return;
    }
    handle.reservationStallTimer = setTimeout(() => {
      handle.reservationStallTimer = null;
      // Re-check LIVE state: the handle may have been replaced, the
      // reservation released, or the queue drained since scheduling.
      const live = this.handles.get(key(handle.conversationId, handle.agentId));
      if (live !== handle) return;
      if (!handle.nextTurnReserved || handle.reservationStallWarned) return;
      if (handle.deferredQueue.length === 0) return;
      this.warnReservationStall(handle);
    }, remaining);
    handle.reservationStallTimer.unref();
  }

  private warnReservationStall(handle: RuntimeHandle): void {
    handle.reservationStallWarned = true;
    this.logger.warn(
      {
        kind: 'process',
        action: 'next_turn_reservation_stalled',
        conversation_id: handle.conversationId,
        agent_id: handle.agentId,
        reservation_age_ms:
          handle.nextTurnReservedAt === null
            ? null
            : this.now() - handle.nextTurnReservedAt,
        deferred_queue_depth: handle.deferredQueue.length,
      },
      'next-turn reservation held past stall threshold; deliveries deferring until terminal turn_end (fail closed, no write)',
    );
  }

  private clearReservationStallTimer(handle: RuntimeHandle): void {
    if (handle.reservationStallTimer !== null) {
      clearTimeout(handle.reservationStallTimer);
      handle.reservationStallTimer = null;
    }
  }

  /** Idempotent enqueue into the daemon mid-turn queue. Dedups by the
   *  delivery-id set so a re-submit of the same batch does not double-queue
   *  (§11.4), mirroring the backend coordinator's `dedupKey`. Owner-aware
   *  (Cindy P1): a same-id-set re-submit under a DIFFERENT owner is a
   *  reconnect/reclaim race — the backend rolled the row off the old
   *  connection and re-drove it under the new one, and that re-drive can
   *  reach the daemon BEFORE the old connection's cleanup. Rebind the queued
   *  entry to the CURRENT owner (which matches the DB's latest in-flight
   *  owner) so the old owner's cleanup can no longer discard custody the DB
   *  now attributes to the new connection; otherwise the entry is dropped
   *  and the row orphaned in-flight with no daemon custody. */
  private enqueueDeferred(
    handle: RuntimeHandle,
    params: RuntimeDeliverParams,
    owner: string,
  ): void {
    const dedupKey = deferredDedupKey(params.delivery_ids);
    const existingIdx = handle.deferredQueue.findIndex(
      entry => deferredDedupKey(entry.deliveryIds) === dedupKey,
    );
    if (existingIdx !== -1) {
      const existing = handle.deferredQueue[existingIdx]!;
      if (existing.owner !== owner) {
        // Rebind in place (preserving FIFO position for direct mode) with
        // the current owner and the latest payload. DeferredEntry is
        // readonly, so replace the element rather than mutate it.
        handle.deferredQueue[existingIdx] = {
          deliveryIds: [...params.delivery_ids],
          ...(params.delivered_up_to_seq !== undefined
            ? { deliveredUpToSeq: params.delivered_up_to_seq }
            : {}),
          ...(params.deliveries ? { deliveries: params.deliveries } : {}),
          text: params.text,
          owner,
        };
        this.logger.info(
          {
            kind: 'process',
            action: 'deferred_owner_rebind',
            conversation_id: handle.conversationId,
            agent_id: handle.agentId,
            from_owner: existing.owner,
            to_owner: owner,
          },
          'rebound deferred delivery to current owner (reconnect/reclaim race)',
        );
      }
      return;
    }
    handle.deferredQueue.push({
      deliveryIds: [...params.delivery_ids],
      ...(params.delivered_up_to_seq !== undefined
        ? { deliveredUpToSeq: params.delivered_up_to_seq }
        : {}),
      ...(params.deliveries ? { deliveries: params.deliveries } : {}),
      text: params.text,
      owner,
    });
  }

  /**
   * Flush the daemon mid-turn queue at a safe boundary (#task:1417 Stage 3,
   * §11.4). Scheduled (never awaited by its caller) from the two triggers:
   * a boundary reopen in `updateRunStateFromParsed`, and a post-write
   * re-drive when a prior write settles. Takes the lifecycle lock so it
   * cannot race a concurrent `deliver`/`stop`/exit, and re-checks every
   * precondition against the LIVE handle before touching it.
   *
   * Split by driver mode (Cindy P1-2):
   *   - `gated`: drain the WHOLE queue, combine into ONE write → one
   *     `consumed` covering every delivery_id (one-turn semantics).
   *   - `direct`: flush ONE entry FIFO, no combine; the post-write re-drive
   *     picks up the next once this write's `consumed` clears the slot.
   *
   * Custody stays the daemon's until `consumeStartupDelivery` emits the
   * async `runtime_delivery_consumed`; the flush never acks the DB.
   */
  private async flushDeferred(handle: RuntimeHandle): Promise<void> {
    const k = key(handle.conversationId, handle.agentId);
    await this.withLifecycleLock(k, async () => {
      const live = this.handles.get(k);
      // Handle may have been replaced (respawn) or torn down since the
      // flush was scheduled — only act on the exact same live handle.
      if (!live || live !== handle) return;
      if (live.flushingDeferred) return;
      if (live.deferredQueue.length === 0) return;
      if (live.phase !== 'ready' || !driverReadyToEncode(live.driver)) return;
      // A write is still in flight — the post-write re-drive will retry once
      // the slot clears. Never stomp a batch mid-consume.
      if (live.startupDelivery !== null) return;
      const gated = profileUsesBoundaryGate(live);
      // Still mid-turn for a gated driver — wait for the next boundary.
      if (gated && !strategyBoundaryOpen(live)) return;

      live.flushingDeferred = true;
      try {
        const batch = gated
          ? spliceBoundedDeferredPrefix(live.deferredQueue) // bounded prefix (I4)
          : live.deferredQueue.splice(0, 1); // FIFO one
        if (batch.length === 0) return;
        live.startupDelivery = combineDeferredBatch(batch, gated);
        await this.consumeStartupDelivery(live);
      } finally {
        live.flushingDeferred = false;
        // FIFO continuation for `direct`: the just-consumed entry cleared
        // the slot synchronously, so re-drive to pick up the next queued
        // entry. Guarded (no-op if the queue is empty or a write deferred
        // its ack via `requires_first_message`).
        this.maybeScheduleDeferredFlush(live);
      }
    });
  }

  /** Schedule a deferred-queue flush if there is anything to flush. Cheap
   *  fast-path guard so the hot parsed-event path doesn't spawn a lock
   *  acquisition on every event. The real preconditions are re-checked
   *  under the lock inside `flushDeferred`. */
  private maybeScheduleDeferredFlush(handle: RuntimeHandle): void {
    if (handle.deferredQueue.length === 0) return;
    if (handle.flushingDeferred) return;
    void this.flushDeferred(handle);
  }

  private async writeLastDeliveredSeq(
    handle: RuntimeHandle,
    deliveredUpToSeq: number | undefined,
  ): Promise<void> {
    if (
      deliveredUpToSeq === undefined
      || !Number.isSafeInteger(deliveredUpToSeq)
      || deliveredUpToSeq <= 0
    ) {
      return;
    }
    try {
      await writeFile(
        handle.lastDeliveredSeqPath,
        `${deliveredUpToSeq}\n`,
        'utf-8',
      );
    } catch (err) {
      this.logger.warn(
        {
          kind: 'process',
          action: 'last_delivered_seq_write_failed',
          pid: handle.pid,
          conversationId: handle.conversationId,
          agent_id: handle.agentId,
          delivered_up_to_seq: deliveredUpToSeq,
          path: handle.lastDeliveredSeqPath,
          error_message: (err as Error).message,
        },
        'failed to update runtime last-delivered seq file',
      );
    }
  }

  // ── runtime_status ─────────────────────────────────────────────

  status(params: RuntimeStatusParams): RuntimeStatusResult {
    const out: RuntimeStateDto[] = [];
    for (const handle of this.handles.values()) {
      if (
        params.conversation_id &&
        params.conversation_id !== handle.conversationId
      ) {
        continue;
      }
      if (params.agent_id && params.agent_id !== handle.agentId) continue;
      out.push({
        conversation_id: handle.conversationId,
        agent_id: handle.agentId,
        pid: handle.phase === 'exited' ? null : handle.pid,
        phase: handle.phase,
        run_state: handle.runState,
        started_at: handle.startedAt,
      });
    }
    return { runtimes: out };
  }

  // ── runtime_clear_session ──────────────────────────────────────

  async clearSession(
    params: RuntimeClearSessionParams,
  ): Promise<RuntimeClearSessionResult> {
    // 3a semantics (per Cindy `OQCA05pivtB8nSTC` clarification note):
    // `cleared: true` here means **the host-side runtime was hard-
    // stopped** — the runtime handle is gone, so any subsequent
    // `runtime_deliver` would have to re-spawn. It does NOT mean the
    // backend-owned resume-state / cli_session_id projection has
    // been wiped; that is downstream of this call. Backend treats
    // `cleared: true` as a signal to nullify its own resume bookkeeping
    // (`agents.cli_session_id`) after this resolves. 3b will add the
    // explicit resume-state path on the host side (driver-mediated
    // `claude --resume` invalidation) and tighten this contract.
    //
    // 3c-b: runs under the per-(conv, agent) lifecycle lock so a
    // concurrent start / hardStop trigger serializes behind it. The
    // wrapped block does ALL the handle bookkeeping (read + hard
    // stop) inside the critical section so a race with start cannot
    // observe `clearSession` mid-stop.
    const k = key(params.conversation_id, params.agent_id);
    return this.withLifecycleLock(k, async () => {
      const handle = this.handles.get(k);
      if (!handle || handle.phase === 'exited') return { cleared: false };
      await this.hardStopHandle(handle);
      return { cleared: true };
    });
  }

  // ── runtime_stop_all ───────────────────────────────────────────

  async stopAll(_params: RuntimeStopAllParams): Promise<RuntimeStopAllResult> {
    // 3c-b (Cindy tightening `ixAq6GPTn4fVSpCF`): fan out one
    // lifecycle-lock acquisition per (conv, agent) and wait on all
    // of them in parallel. Different keys spawn / stop independently,
    // so the natural shape is `Promise.all` over per-key entries —
    // a single global lock would queue every stop behind every other,
    // turning stopAll into a serial drain.
    //
    // Snapshot the keys BEFORE awaiting any lock so we don't iterate
    // a Map that's being mutated by concurrent `onChildExit` cleanups
    // or by another in-flight stop completing under one of our lock
    // sections.
    const livingKeys: string[] = [];
    for (const [k, handle] of this.handles) {
      if (handle.phase !== 'exited') livingKeys.push(k);
    }
    const count = livingKeys.length;
    await Promise.all(
      livingKeys.map(k =>
        this.withLifecycleLock(k, async () => {
          const handle = this.handles.get(k);
          if (!handle || handle.phase === 'exited') return;
          await this.hardStopHandle(handle);
        }),
      ),
    );
    return { stopped_count: count };
  }

  // ── runtime_close_activity_log ─────────────────────────────────

  closeActivityLog(
    _params: RuntimeCloseActivityLogParams,
  ): RuntimeCloseActivityLogResult {
    // The activity-log JSONL writer is backend-owned (per §3.4 /
    // §4.3); host has nothing to flush. Returning flushed=true keeps
    // backend's intent loop honest — if anything is in flight inside
    // OutputBackpressure, the server-level recovery summary mechanism
    // is the right place to drain it.
    return { flushed: true };
  }

  // ── runtime_output_pause / runtime_output_resume ───────────────

  pauseOutput(params: RuntimeOutputPauseParams): RuntimeOutputPauseResult {
    const k = key(params.conversation_id, params.agent_id);
    const handle = this.handles.get(k);
    if (!handle || handle.phase === 'exited') return { paused: false };
    if (handle.outputPaused) return { paused: true };
    handle.outputPaused = true;
    this.emit({
      event: 'runtime_output_paused',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
    });
    return { paused: true };
  }

  resumeOutput(params: RuntimeOutputResumeParams): RuntimeOutputResumeResult {
    const k = key(params.conversation_id, params.agent_id);
    const handle = this.handles.get(k);
    if (!handle || handle.phase === 'exited') return { resumed: false };
    if (!handle.outputPaused) return { resumed: true };
    handle.outputPaused = false;
    this.emit({
      event: 'runtime_output_resumed',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
    });
    return { resumed: true };
  }

  // ── private: child lifecycle wiring ────────────────────────────

  private attachChildListeners(handle: RuntimeHandle): void {
    const { child } = handle;

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        this.onChildBytes(handle, 'stdout', chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        this.onChildBytes(handle, 'stderr', chunk);
      });
    }

    child.once('exit', (code, signal) => {
      this.onChildExit(handle, code, signal);
    });

    child.on('error', err => {
      // `error` fires for ENOENT / EACCES on spawn (rare here since
      // resolveBinary already verified existence) and for stdin write
      // failures (tolerated on the `runtime_deliver` write path). Log
      // for triage; the exit event still drives state transitions.
      this.logger.warn(
        {
          kind: 'process',
          action: 'child_error',
          pid: handle.pid,
          conversationId: handle.conversationId,
          agent_id: handle.agentId,
          error_message: (err as Error).message,
        },
        'child process emitted error',
      );
    });
  }

  private onChildBytes(
    handle: RuntimeHandle,
    stream: 'stdout' | 'stderr',
    chunk: Buffer | string,
  ): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    if (text.length === 0) return;

    // 3c-b: any byte from the child (stdout OR stderr) refreshes the
    // pre-protocol silence watchdog. Matches CM (`conversation-manager.ts`
    // lines 785-787, 796-797). Refresh is a no-op once `initProtocolObserved`
    // or `initObserved` has flipped — the silence tier is only active
    // pre-first-protocol-frame.
    this.refreshInitLiveness(handle);

    // Do NOT forward raw child bytes on the daemon→backend wire by default.
    //
    // The raw stream is unbounded: a single tool invocation can print
    // megabytes of stdout/stderr, and forwarding that as
    // `runtime_output` duplicates data that backend does not consume
    // for correctness. UI state, delivery gates, delivery ack, and DB
    // projection are all driven by bounded structured events
    // (`runtime_parsed_event` / `runtime_state`) below. Keeping raw
    // tool output daemon-local prevents large `cat`/`grep`/shell
    // results from filling the outbound socket buffer while preserving
    // all control-plane semantics. `runtime_output_pause/resume` stay
    // as protocol compatibility no-ops for older callers.
    //
    // `emitRawRuntimeOutput` exists only for targeted supervisor
    // tests/debugging of this legacy wire arm. Production wiring never
    // sets it.
    if (this.emitRawRuntimeOutput && !handle.outputPaused) {
      this.emit({
        event: 'runtime_output',
        conversation_id: handle.conversationId,
        agent_id: handle.agentId,
        stream,
        chunk: text,
        ts: this.now(),
      });
    }

    // Parse fanout only feeds off stdout — stderr is treated as raw
    // diagnostic output (CM same). Even when output is paused, we
    // continue to feed parseLine because parsed events drive
    // host-internal AgentRunState and the delivery gate, which are
    // not droppable concerns. (`runtime_parsed_event` may still be
    // skipped at the broadcaster's discretion — but that's frame-level
    // backpressure, not pause semantics.)
    if (stream !== 'stdout') return;
    this.consumeStdoutForParse(handle, text);
  }

  /**
   * Line-buffer stdout and dispatch each complete line to
   * `driver.parseLine`. Mirrors CM's readline-based pump
   * (`conversation-manager.ts` ~line 789) but inlined here so the
   * supervisor owns the buffer.
   *
   * Lines that arrive partial across chunks are stitched via
   * `handle.stdoutLineBuffer`. A trailing partial fragment at child
   * exit IS flushed — `onChildExit` hands the leftover buffer to
   * `dispatchParsedLine` before flipping `phase='exited'`, matching
   * Node's `readline.createInterface` behavior of emitting a final
   * `line` when input ends without a newline (Cindy
   * `5nruk1IPaEHSab0T` B5). Without that flush the last complete-
   * but-unterminated JSON frame (typically the child's final
   * session_init / turn_end / error on quick exit) would silently
   * disappear from the parsed-event stream.
   */
  private consumeStdoutForParse(handle: RuntimeHandle, text: string): void {
    if (handle.phase === 'exited') return;
    const combined = handle.stdoutLineBuffer + text;
    const newlineIdx = combined.lastIndexOf('\n');
    if (newlineIdx === -1) {
      handle.stdoutLineBuffer = combined;
      return;
    }
    const completePart = combined.slice(0, newlineIdx);
    handle.stdoutLineBuffer = combined.slice(newlineIdx + 1);

    const lines = completePart.split('\n');
    for (const line of lines) {
      if (line.length === 0) continue;
      this.dispatchParsedLine(handle, line);
    }
  }

  private dispatchParsedLine(handle: RuntimeHandle, line: string): void {
    // 3c-b: observe init-progress BEFORE parseLine so a driver's
    // classifyInitProgress (pure line classifier) can advance the
    // watchdog state machine even if parseLine returns no events for
    // this specific frame (drivers occasionally emit protocol
    // bookkeeping that maps to no ParsedEvent). Order matches CM
    // (`conversation-manager.ts` lines 789-794): observe → parse →
    // fanout.
    this.observeInitProgress(handle, line);

    // Boundary-reopen detection must bracket the PARSE itself, not only
    // the per-event busy transitions (#task:1565): a prompt-boundary
    // driver (ACP) settles its active prompt INSIDE parseLine — the
    // driver-owned `readyToEncode` flips true before any event is
    // dispatched, so the per-event edge check in
    // `updateRunStateFromParsed` reads "was already open" and never
    // fires. Snapshot the boundary before parsing and drive the queue
    // if the parse (or its events) reopened it. `maybeScheduleDeferredFlush`
    // is guarded: no-op when the queue is empty or a flush is running.
    const boundaryOpenBeforeParse = strategyBoundaryOpen(handle);

    let events: ParsedEvent[];
    try {
      events = handle.driver.parseLine(line);
    } catch (err) {
      this.logger.warn(
        {
          kind: 'process',
          action: 'parse_line_threw',
          pid: handle.pid,
          conversationId: handle.conversationId,
          agent_id: handle.agentId,
          error_message: (err as Error).message,
        },
        'driver.parseLine threw on stdout line',
      );
      return;
    }
    for (const ev of events) {
      // Validate before emitting so the daemon never puts an
      // ill-typed parsed event on the wire. Drivers shouldn't
      // produce them, but a future driver update could regress
      // without this guard. Defense in depth — backend re-validates
      // on its side too (Cindy `OQCA05pivtB8nSTC`: zod schema is
      // bilateral).
      const validated = ParsedEventSchema.safeParse(ev);
      if (!validated.success) {
        this.logger.warn(
          {
            kind: 'process',
            action: 'parse_event_invalid',
            pid: handle.pid,
            conversationId: handle.conversationId,
            agent_id: handle.agentId,
            issue: validated.error.issues[0]?.message ?? 'unknown',
          },
          'driver.parseLine produced event that fails ParsedEventSchema',
        );
        continue;
      }
      // RUN-STATE FIRST. Per Cindy `C2BZGDbQWfnq-bKJ`:
      // frame-too-large is a broadcast concern only — host-internal
      // AgentRunState derivation must happen even if the wire frame
      // is too large to emit. Run-state updates emit `runtime_state`
      // separately (non-droppable, payload-bounded).
      this.updateRunStateFromParsed(handle, validated.data);
      this.emitParsedEvent(handle, validated.data);
    }
    // Parse-bracketed reopen edge (#task:1565): the ACP prompt response
    // flipped `readyToEncode` inside parseLine, invisible to the
    // per-event edge check above. Idempotent with that check — the
    // flush scheduler no-ops on an empty queue or an active flush.
    if (!boundaryOpenBeforeParse && strategyBoundaryOpen(handle)) {
      this.maybeScheduleDeferredFlush(handle);
    }
  }

  /**
   * Emit `runtime_parsed_event` for `parsed`. If the encoded frame
   * would exceed `MAX_FRAME_BYTES`, fall back to
   * `runtime_parsed_event_dropped` — a strict metadata-only frame
   * (Cindy `C2BZGDbQWfnq-bKJ`: NO payload, NO raw line, NO partial
   * fields). We pre-encode the candidate frame to measure its
   * actual wire size; the protocol layer's `encodeFrame` would
   * throw otherwise, which would drop the parsed event silently
   * (worse than honest reporting).
   */
  private emitParsedEvent(handle: RuntimeHandle, parsed: ParsedEvent): void {
    const candidate: EventFrame = {
      event: 'runtime_parsed_event',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      parsed,
      ts: this.now(),
    };
    let encoded: string | null = null;
    try {
      encoded = encodeFrame(candidate);
    } catch (err) {
      // `encodeFrame` throws on MAX_FRAME_BYTES violation. Fall
      // through to the dropped-frame path.
      this.logger.warn(
        {
          kind: 'process',
          action: 'parse_event_too_large',
          pid: handle.pid,
          conversationId: handle.conversationId,
          agent_id: handle.agentId,
          parsed_kind: parsed.kind,
          error_message: (err as Error).message,
        },
        'parsed event exceeds frame cap; emitting dropped marker',
      );
    }
    if (encoded !== null) {
      this.emit(candidate);
      return;
    }
    // Compute an honest byte count for the dropped marker. Use the
    // length the encoder would have produced (sans the payload-bearing
    // frame). We approximate via Buffer.byteLength of a probe encoding
    // — the dropped frame itself is tiny so it always fits.
    const probe = JSON.stringify({
      event: 'runtime_parsed_event',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      parsed,
      ts: this.now(),
    });
    const encodedBytes = Buffer.byteLength(probe, 'utf-8') + 1; // + '\n'
    this.emit({
      event: 'runtime_parsed_event_dropped',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      parsed_kind: parsed.kind,
      encoded_bytes: encodedBytes,
      reason: 'frame_too_large',
      ts: this.now(),
    });
  }

  /**
   * Mutate `handle.runState` based on `parsed`. The transition table
   * mirrors CM's `handleParsedEvent` switch + `recordTool*` /
   * `recordCompaction*` helpers (`conversation-manager.ts`
   * ~lines 1230, 1470-1516). Only the status-shaping subset lives
   * here in 3b; backend keeps owning the activity-snippet ring
   * buffer, tool-call counters, and SSE projection (those are UX,
   * not execution-plane).
   *
   * `session_init` is special: it flips `initObserved` (drives the
   * 3c delivery gate) and updates `cliSessionId`. No run-state change
   * here — run-state lifecycle starts when the agent actually does
   * something (text/thinking/tool_call/turn_end).
   */
  private updateRunStateFromParsed(
    handle: RuntimeHandle,
    parsed: ParsedEvent,
  ): void {
    if (parsed.kind === 'session_init') {
      if (!handle.initObserved) {
        handle.initObserved = true;
        handle.cliSessionId = parsed.sessionId;
        // 3c-b: stop every init watchdog timer now that init has
        // landed AND clear the (conv, agent) retry/cooldown bucket.
        // The cooldown counter is sticky across attempts within an
        // incident window; a successful init is the explicit reset.
        this.clearInitWatchdog(handle);
        this.clearInitRetryState(handle.conversationId, handle.agentId);
        this.logger.info(
          {
            kind: 'process',
            action: 'session_init',
            pid: handle.pid,
            conversationId: handle.conversationId,
            agent_id: handle.agentId,
            cli_session_id: parsed.sessionId,
          },
          'agent: session_init received',
        );
        // Cindy `YW2BGWryWjfymPkU` B2: settle the deferred consumed
        // emit if `consumeStartupDelivery` parked the batch awaiting
        // init (claude path: write already done; just emit consumed).
        // Settle order — emit consumed FIRST, then clear gate, then
        // re-evaluate ready_for_drain — same as the non-deferred path
        // inside `consumeStartupDelivery`. The `startupDelivery !==
        // null` precondition guarantees we only fire for batches that
        // are still pending (no double-emit on a re-consumed race).
        if (handle.startupAwaitingInit && handle.startupDelivery) {
          const ids = handle.startupDelivery.deliveryIds;
          this.emitStartupDeliveryConsumed(handle, ids);
          this.clearStartupGate(handle);
          this.maybeEmitReadyForDrain(handle);
        }
        // Option A v2 (Cindy `UMGu36zoTDVuKWXi`): codex path. If
        // `consumeStartupDelivery` deferred earlier because
        // `driver.readyToEncode()` was false (codex pre-`thread/started`),
        // the gate is still pending without `startupAwaitingInit`.
        // session_init means the driver is now ready (codex
        // `handleThreadReady` sets `threadId` BEFORE pushing the
        // `session_init` parsed event), so the deferred consume can
        // proceed. Mutually exclusive with the awaitingInit branch
        // above — that one already cleared the gate.
        this.tryConsumeStartupDelivery(handle);
        // Also re-evaluate the drain gate: codex's `ready_for_drain`
        // is bottled until `driver.readyToEncode()` flips true, and
        // (for runs without startup_delivery) we need to fire it now
        // that the driver is ready.
        this.maybeEmitReadyForDrain(handle);
      }
      return;
    }

    if (!handle.inputTurnActive && parsedStartsTurn(parsed)) {
      this.admitPendingSeqForNewTurn(handle, 'queued_delivery_admitted_on_activity');
    }

    // Boundary-reopen trigger for the daemon mid-turn queue (#task:1417
    // Stage 3, §11.4). Capture the safe-boundary state BEFORE the busy
    // transition; if this event reopens the boundary, flush any deferred
    // batch — symmetric to the retired coordinator's
    // `if (!wasSafe && nowSafe && pending.length) flush()`.
    const wasBoundaryOpen = strategyBoundaryOpen(handle);

    switch (parsed.kind) {
      case 'thinking':
        this.recordActivitySnippet(handle, 'thinking', parsed.text);
        break;
      case 'text':
        this.recordActivitySnippet(handle, 'text', parsed.text);
        break;
      case 'tool_call':
        handle.busy.outstandingToolUses += 1;
        const toolCallCounts =
          parsed.name === SEND_MESSAGE_TOOL_NAME
            ? handle.runState?.toolCallCounts
            : incrementToolCount(handle.runState?.toolCallCounts, parsed.name);
        this.transitionRunState(handle, {
          status: 'tool_running',
          detail: parsed.name,
          ...(toolCallCounts ? { toolCallCounts } : {}),
        });
        break;
      case 'tool_output':
        handle.busy.outstandingToolUses = Math.max(
          0,
          handle.busy.outstandingToolUses - 1,
        );
        if (handle.busy.outstandingToolUses === 0 && !handle.busy.compacting) {
          this.transitionRunState(handle, {
            status: 'thinking',
            detail: null,
          });
        }
        break;
      case 'compaction_started':
        handle.busy.compacting = true;
        // 3c-b: arm the compaction watchdog. Cleared on
        // compaction_finished, child exit, or hard stop. Watchdog
        // fire path stacks `compactionStale: true` on the run state
        // and emits `runtime_compaction_stale` — but does NOT change
        // phase or kill the child (Cindy plan v2 issue #4).
        this.startCompactionWatchdog(handle);
        this.transitionRunState(handle, {
          compacting: true,
          compactingSince: this.now(),
          // Clear any prior `compactionStale` flag so the next stale
          // window starts fresh and the wire-visible diff fires
          // again if the new compaction also stalls.
          compactionStale: false,
        });
        break;
      case 'compaction_finished':
        handle.busy.compacting = false;
        this.clearCompactionWatchdog(handle);
        this.transitionRunState(handle, {
          compacting: false,
          compactingSince: null,
          compactionStale: false,
          ...(handle.busy.outstandingToolUses === 0
            ? { status: 'thinking', detail: null }
            : {}),
        });
        break;
      case 'turn_end':
        handle.busy.outstandingToolUses = 0;
        handle.busy.compacting = false;
        handle.nextTurnReserved = false;
        handle.nextTurnReservedAt = null;
        handle.reservationStallWarned = false;
        this.clearReservationStallTimer(handle);
        handle.turnEndCount += 1;
        // Cindy `YW2BGWryWjfymPkU` B3: turn_end is a terminal
        // transition — go through `resolveRun` so the terminal
        // state lands, then `handle.runState` is cleared so the
        // next activity creates a fresh runId with no stale
        // terminalReason.
        this.resolveRun(handle, 'turn_ended');
        break;
      case 'input_lifecycle': {
        // #task:1557 Phase 1: pure observation. Correlate the runtime's
        // per-payload lifecycle back to the delivery ids we stamped at
        // encode time; log it, prune on completion, change nothing else.
        const mapped = handle.inputPayloadUuids.get(parsed.commandUuid);
        this.logger.info(
          {
            kind: 'process',
            action: 'input_lifecycle',
            pid: handle.pid,
            conversationId: handle.conversationId,
            agent_id: handle.agentId,
            command_uuid: parsed.commandUuid,
            state: parsed.state,
            delivery_ids: mapped ? [...mapped.deliveryIds] : null,
            correlated: mapped !== undefined,
          },
          'runtime input lifecycle observed',
        );
        // `input_lifecycle` is GENERATION-BOUNDARY evidence by contract
        // (#task:1561 round 2, action-snapshot invariant): drivers may
        // only emit it from a signal proving the payload became precedent
        // context for the NEXT model generation — never from a
        // write/transport/RPC ack (that misnaming caused countgame round
        // 2's false-fresh duplicates). Sources, pinned by driver tests:
        //   - claude: the runtime's own `command_lifecycle` frames
        //     (write lands at a proven tool boundary; B' #task:1558).
        //   - codex: the `item/started {type:'userMessage'}` echo of our
        //     `clientUserMessageId` — emitted when codex drains
        //     pending_input into model history, between the previous
        //     generation and the next sampling request.
        // Promote observed for exactly the covered streams/seqs
        // (monotonic; already-admitted coverage is a no-op).
        if (parsed.state === 'started' && mapped) {
          for (const [streamKey, seq] of mapped.coveredSeqByStream) {
            this.advanceObservedStream(
              handle,
              streamKey,
              seq,
              'input_lifecycle_started',
            );
          }
        }
        if (parsed.state === 'completed') {
          handle.inputPayloadUuids.delete(parsed.commandUuid);
        }
        break;
      }
      case 'error':
        if (parsed.fatal !== true) {
          this.transitionRunState(handle, {
            status: 'thinking',
            detail: null,
            activitySnippet: parsed.message,
            activitySnippetKind: null,
          });
        }
        break;
      case 'unknown':
        // No-op; backend may decide what to do with it.
        break;
    }

    // If the busy transition just reopened a safe boundary, drive the
    // daemon mid-turn queue (#task:1417 Stage 3, §11.4). Guarded/no-op when
    // the queue is empty or a flush is already running.
    if (!wasBoundaryOpen && strategyBoundaryOpen(handle)) {
      this.maybeScheduleDeferredFlush(handle);
    }
  }

  /**
   * Apply a transition to `handle.runState`. Lazily creates the
   * state on first transition (so `runId` is stable from the
   * moment the agent starts emitting events). Patch semantics:
   *
   *   - `undefined` field        → leave existing value untouched
   *   - explicit `null` field    → clear (drop optional field)
   *   - any other value          → set
   *
   * Emits `runtime_state` only when something visible to the wire
   * changes (status, detail, snippet, tool counts, compacting,
   * terminalReason).
   */
  private transitionRunState(
    handle: RuntimeHandle,
    patch: {
      status?: AgentRunState['status'];
      detail?: string | null;
      terminalReason?: AgentRunState['terminalReason'];
      compacting?: boolean;
      compactingSince?: number | null;
      /** 3c-b: stacked stale flag from the compaction watchdog. Must
       *  be set in the same patch that DOES NOT touch `compacting` so
       *  the run-state keeps `compacting: true` alongside
       *  `compactionStale: true` (Cindy plan v2 issue #4). */
      compactionStale?: boolean;
      activitySnippet?: string | null;
      activitySnippetKind?: AgentActivitySnippetKind | null;
      toolCallCounts?: Record<string, number> | null;
    },
  ): void {
    const ts = this.now();
    if (!handle.runState) {
      const status = patch.status ?? 'thinking';
      handle.runState = {
        runId: randomUUID(),
        agentId: handle.agentId,
        conversationId: handle.conversationId,
        status,
        startedAt: ts,
        updatedAt: ts,
        lastActivityAt: ts,
        ...(patch.detail && patch.detail !== null
          ? { detail: patch.detail }
          : {}),
        ...(patch.terminalReason ? { terminalReason: patch.terminalReason } : {}),
        ...(patch.activitySnippet ? { activitySnippet: patch.activitySnippet } : {}),
        ...(patch.activitySnippet && patch.activitySnippetKind
          ? { activitySnippetKind: patch.activitySnippetKind }
          : {}),
        ...(patch.toolCallCounts ? { toolCallCounts: patch.toolCallCounts } : {}),
        ...(patch.compacting !== undefined ? { compacting: patch.compacting } : {}),
        ...(patch.compactingSince !== undefined && patch.compactingSince !== null
          ? { compactingSince: patch.compactingSince }
          : {}),
        ...(patch.compactionStale === true ? { compactionStale: true } : {}),
      };
      this.emitState(handle);
      return;
    }
    const prev = handle.runState;
    const next: AgentRunState = {
      ...prev,
      updatedAt: ts,
      lastActivityAt: ts,
    };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.detail === null) {
      delete next.detail;
    } else if (patch.detail !== undefined) {
      next.detail = patch.detail;
    }
    if (patch.terminalReason !== undefined) {
      next.terminalReason = patch.terminalReason;
    }
    if (patch.activitySnippet === null) {
      delete next.activitySnippet;
      delete next.activitySnippetKind;
    } else if (patch.activitySnippet !== undefined) {
      next.activitySnippet = patch.activitySnippet;
      if (patch.activitySnippetKind) {
        next.activitySnippetKind = patch.activitySnippetKind;
      } else {
        delete next.activitySnippetKind;
      }
    } else if (patch.activitySnippetKind === null) {
      delete next.activitySnippetKind;
    }
    if (patch.toolCallCounts === null) {
      delete next.toolCallCounts;
    } else if (patch.toolCallCounts !== undefined) {
      next.toolCallCounts = patch.toolCallCounts;
    }
    if (patch.compacting !== undefined) next.compacting = patch.compacting;
    if (patch.compactingSince === null) {
      delete next.compactingSince;
    } else if (patch.compactingSince !== undefined) {
      next.compactingSince = patch.compactingSince;
    }
    if (patch.compactionStale === true) {
      next.compactionStale = true;
    } else if (patch.compactionStale === false) {
      delete next.compactionStale;
    }
    handle.runState = next;
    // Emit when wire-visible field changed.
    const shouldEmit =
      prev.status !== next.status ||
      prev.detail !== next.detail ||
      prev.terminalReason !== next.terminalReason ||
      prev.activitySnippet !== next.activitySnippet ||
      prev.activitySnippetKind !== next.activitySnippetKind ||
      JSON.stringify(prev.toolCallCounts ?? {}) !==
        JSON.stringify(next.toolCallCounts ?? {}) ||
      prev.compacting !== next.compacting ||
      prev.compactionStale !== next.compactionStale;
    if (shouldEmit) this.emitState(handle);
  }

  private recordActivitySnippet(
    handle: RuntimeHandle,
    kind: ActivitySnippetKind,
    text: string,
  ): void {
    if (!handle.runState) {
      this.transitionRunState(handle, { status: 'thinking', detail: null });
    }
    const runId = handle.runState?.runId;
    if (!runId) return;
    const activitySnippet = this.appendActivitySnippetBuffer(
      handle,
      runId,
      kind,
      text,
    );
    this.transitionRunState(
      handle,
      activitySnippet
        ? { activitySnippet, activitySnippetKind: kind }
        : { status: 'thinking' },
    );
  }

  private appendActivitySnippetBuffer(
    handle: RuntimeHandle,
    runId: string,
    kind: ActivitySnippetKind,
    text: string,
  ): string | undefined {
    const current = handle.activitySnippetBuffer;
    const nextText =
      current?.runId === runId && current.kind === kind
        ? `${current.text}${text}`
        : text;
    const boundedText =
      nextText.length <= ACTIVITY_SNIPPET_BUFFER_MAX_CHARS
        ? nextText
        : nextText.slice(-ACTIVITY_SNIPPET_BUFFER_MAX_CHARS);
    handle.activitySnippetBuffer = { runId, kind, text: boundedText };
    return trimActivitySnippet(boundedText);
  }

  private clearActivitySnippetBuffer(
    handle: RuntimeHandle,
    runId?: string,
  ): void {
    const current = handle.activitySnippetBuffer;
    if (!current) return;
    if (runId && current.runId !== runId) return;
    handle.activitySnippetBuffer = null;
  }

  /**
   * Terminal-resolve `handle.runState`. Three responsibilities,
   * matching CM's `resolveRunByKey` + `publishTerminalRunState`
   * (Cindy `YW2BGWryWjfymPkU` B3):
   *
   *   1. Map `reason` to the canonical terminal status. CM rule
   *      (`terminalStatus`): `replied | turn_ended | replaced` →
   *      `idle`; every other terminal reason
   *      (`stopped | crashed | timeout | conversation_closed`) →
   *      `failed`. Note `stopped` is FAILED, not idle — hard stop
   *      during tool_running surfaces as `{status:'failed',
   *      terminalReason:'stopped'}` so backend's RunStateCache and
   *      UI both project the correct "ended on a hard stop" arm.
   *   2. Emit ONE `runtime_state` carrying the terminal status +
   *      terminalReason. Uses the existing runState if present
   *      (preserves the runId so the consumer can correlate);
   *      synthesizes a phase-derived state otherwise so we always
   *      surface the terminal transition.
   *   3. Null out `handle.runState` + reset busy/compacting so the
   *      next observable activity (a fresh thinking/tool_call) gets
   *      a brand-new runId and no leaked terminalReason.
   */
  private resolveRun(
    handle: RuntimeHandle,
    reason: NonNullable<AgentRunState['terminalReason']>,
  ): void {
    const terminalStatus: AgentRunState['status'] =
      reason === 'replied' || reason === 'turn_ended' || reason === 'replaced'
        ? 'idle'
        : 'failed';
    const ts = this.now();
    const base: AgentRunState = handle.runState
      ? {
          ...handle.runState,
          status: terminalStatus,
          updatedAt: ts,
          lastActivityAt: ts,
          terminalReason: reason,
          // Clear transient activity fields on terminal emit so the
          // wire shape matches CM's terminal projection.
          compacting: false,
        }
      : {
          runId: `real-${handle.pid}-${handle.startedAt}`,
          agentId: handle.agentId,
          conversationId: handle.conversationId,
          status: terminalStatus,
          startedAt: handle.startedAt,
          updatedAt: ts,
          lastActivityAt: ts,
          terminalReason: reason,
        };
    this.emit({
      event: 'runtime_state',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      state: base,
      ts,
    });
    this.clearActivitySnippetBuffer(handle, base.runId);
    // Clear so the next activity starts a fresh run. busy is reset
    // here too — turn_end already does it, but exit/crash paths
    // benefit from the safety net.
    handle.runState = null;
    handle.busy.outstandingToolUses = 0;
    handle.busy.compacting = false;
    handle.inputTurnActive = false;
    handle.nextTurnReserved = false;
    handle.nextTurnReservedAt = null;
    handle.reservationStallWarned = false;
    this.clearReservationStallTimer(handle);
    handle.defaultReplyTarget = CHANNEL_DEFAULT_REPLY_TARGET;
    handle.pendingDefaultReplyTarget = undefined;
  }

  /**
   * Write `payload` to the child's stdin as a single NDJSON line.
   * The daemon's contract is "I write whatever bytes you give me +
   * a trailing newline" — `payload` is intentionally `unknown` so
   * either encoding shape is accepted:
   *
   *   - `string` → written verbatim + '\n'
   *   - object   → `JSON.stringify(payload) + '\n'`
   *
   * Both match CM's `writeLine` semantics — encoded line, single
   * trailing newline. Backpressure: if `stdin.write` returns false
   * we wait for `'drain'` before resolving (matches CM
   * `conversation-manager.ts` ~2322).
   */
  private writeStdinPayload(handle: RuntimeHandle, payload: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = handle.child.stdin;
      if (!stdin || stdin.destroyed) {
        reject(new Error('child stdin is not writable'));
        return;
      }
      const line =
        typeof payload === 'string' ? payload : JSON.stringify(payload);
      const ok = stdin.write(line + '\n', err =>
        err ? reject(err) : resolve(),
      );
      if (!ok) {
        stdin.once('drain', () => resolve());
      }
    });
  }

  private writeRuntimePidfile(params: {
    conversationId: string;
    agentId: string;
    pid: number;
    startedAt: number;
    runtime: RuntimeKind;
    cmd: string;
  }): void {
    if (!this.runtimePidRootDir || !this.daemonInstanceId) return;
    writeRuntimePidfile({
      rootDir: this.runtimePidRootDir,
      daemonInstanceId: this.daemonInstanceId,
      ...params,
    });
  }

  private unlinkRuntimePidfileForHandle(handle: RuntimeHandle): void {
    if (!this.runtimePidRootDir || !this.daemonInstanceId) return;
    try {
      unlinkRuntimePidfile({
        rootDir: this.runtimePidRootDir,
        daemonInstanceId: this.daemonInstanceId,
        conversationId: handle.conversationId,
        agentId: handle.agentId,
      });
    } catch (err) {
      this.logger.warn(
        {
          kind: 'process',
          action: 'runtime_pidfile_unlink_failed',
          pid: handle.pid,
          conversationId: handle.conversationId,
          agent_id: handle.agentId,
          err: (err as Error).message,
        },
        'failed to unlink runtime pidfile during child finalization',
      );
    }
  }

  private onChildExit(
    handle: RuntimeHandle,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (handle.phase === 'exited') return; // double-fire guard

    if (handle.sigkillTimer) {
      clearTimeout(handle.sigkillTimer);
      handle.sigkillTimer = null;
    }
    // 3c-b: stop any pending init / compaction timers attached to
    // this handle BEFORE the retry-respawn branch fires, otherwise a
    // stray `failInitWatchdog` callback could race the new handle and
    // observe the old one mid-cleanup.
    this.clearInitWatchdog(handle);
    this.clearCompactionWatchdog(handle);

    // Cindy `5nruk1IPaEHSab0T` B5: Node's `readline.createInterface`
    // (which CM uses) emits a final `line` for input that ended
    // without a trailing `\n` (verified locally:
    // `Readable.from(['abc'])` → `line: 'abc'`). The supervisor's
    // chunk-buffered pump was discarding that tail — meaning the
    // last complete-but-unterminated JSON frame (typically the
    // child's final session_init / turn_end / error line on quick
    // exit) would silently vanish from the parsed-event stream.
    // Flush it BEFORE setting `phase='exited'`, because
    // `consumeStdoutForParse` early-returns on `phase==='exited'`
    // — but `dispatchParsedLine` itself has no phase guard, so we
    // hand the tail to it directly. Cleared so the double-fire guard
    // above stays correct on the (impossible-by-contract) re-entry.
    if (handle.stdoutLineBuffer.length > 0) {
      const tail = handle.stdoutLineBuffer;
      handle.stdoutLineBuffer = '';
      this.dispatchParsedLine(handle, tail);
    }

    handle.phase = 'exited';
    handle.exitCode = code;
    this.unlinkRuntimePidfileForHandle(handle);

    const intentional = handle.intentionalExit;
    const ts = this.now();
    const k = key(handle.conversationId, handle.agentId);

    // #task:1460: fold a pre-init failure into the SAME sticky
    // init-failure counter the watchdog uses, so a runtime that dies
    // before `session_init` (before, or without, the watchdog arming)
    // can't drive an unbounded backend re-drive loop (incident #1459).
    // Membership contract:
    //   - never reached `session_init` (`!initObserved`), is not the
    //     watchdog's own kill (`!initTimedOut`, already counted in
    //     `failInitWatchdog`), and is not a user/daemon stop
    //     (`!intentionalExit`);
    //   - a long-lived (non-oneShot) runtime counts on ANY such exit,
    //     even a clean code 0 — it never replied, so it is an init
    //     failure (Cindy: lifecycle, not exit code);
    //   - a oneShot (cursor `--print`) runtime's compatible completion is
    //     a clean code-0 exit, which is NOT a failure; but an ABNORMAL
    //     oneShot exit before init (non-zero code, or a signal such as an
    //     EDR SIGKILL) IS a failure — `oneShot` explains "exits after a
    //     successful turn", not "gets killed mid-startup".
    // The daemon only ACCOUNTS the failure here (bumps the counter,
    // engages cooldown at threshold); backend owns the actual respawn via
    // its pending-inbox re-drive (immediate, no backoff → this is bounded
    // retry + cooldown, not exponential/short backoff).
    const preInitFailure =
      !handle.initObserved &&
      !handle.initTimedOut &&
      !handle.intentionalExit &&
      (!handle.driver.oneShot || code !== 0 || signal !== null);
    if (preInitFailure) {
      this.recordInitFailure(handle);
    }

    this.logger.info(
      {
        kind: 'process',
        action: 'exit',
        pid: handle.pid,
        conversationId: handle.conversationId,
        agent_id: handle.agentId,
        exit_code: code,
        signal: signal ?? null,
        intentional,
        init_timed_out: handle.initTimedOut,
        init_retry_planned: handle.initRetryPlanned,
      },
      'child exited',
    );

    // If a startup batch was still pending at exit, settle it as
    // `child_exit` so backend's startup_delivery handler isn't left
    // hanging. (Cindy: failed settle must still clear the gate so
    // run-state / delivery gating stays coherent.) `clearStartupGate`
    // wipes both `startupDelivery` and `startupAwaitingInit` in the
    // same critical section so no `(null, true)` interleaving
    // appears.
    if (handle.startupDelivery !== null) {
      this.emitStartupDeliveryFailed(
        handle,
        handle.startupDelivery.deliveryIds,
        handle.initTimedOut ? 'init_watchdog' : 'child_exit',
      );
      this.clearStartupGate(handle);
    }

    // Any batches the daemon was holding in its mid-turn queue (#task:1417
    // Stage 3, §11.4/§11.6) die with the runtime — settle each as
    // `child_exit` so the backend rolls the rows back to pending
    // (oneShot respawn-with-batch or `ready_for_drain` replay re-drives).
    // No orphan: the DB rows were never acked. Emitted per-entry so each
    // owner's rollback is independent.
    if (handle.deferredQueue.length > 0) {
      for (const entry of handle.deferredQueue) {
        this.emitStartupDeliveryFailed(handle, entry.deliveryIds, 'child_exit');
      }
      handle.deferredQueue = [];
    }
    this.clearReservationStallTimer(handle);

    // 3c-b retry branch (Cindy plan v2 issue #3 + override precedence
    // `-pdNvRYOWip5e9yA`): if the init watchdog killed the child AND
    // it decided retry was eligible, respawn under the lifecycle
    // lock with `initAttempt + 1`. Daemon-internal retry SKIPS the
    // start-time cooldown gate (`startWithLock` is the gated entry
    // — internalRespawnForRetry calls it WITHOUT bypassing because
    // `startUnlocked` does its own gate check that distinguishes
    // `initAttempt === 0` vs `> 0`).
    if (
      handle.initTimedOut &&
      handle.initRetryPlanned &&
      !handle.intentionalExit
    ) {
      const newAttempt = handle.initAttempt + 1;
      this.emit({
        event: 'runtime_init_retrying',
        conversation_id: handle.conversationId,
        agent_id: handle.agentId,
        retry_attempt: newAttempt,
        max_retries: this.initMaxRetries,
        delay_ms: 0,
        ts: this.now(),
      });
      // Emit terminal runtime_state for the failed attempt and the
      // accompanying runtime_exit, then drop the handle and respawn.
      this.handles.delete(k);
      this.resolveRun(handle, 'timeout');
      this.emit({
        event: 'runtime_exit',
        conversation_id: handle.conversationId,
        agent_id: handle.agentId,
        code,
        intentional: false,
        ts,
      });
      void this.internalRespawnForRetry(handle.spawnParams, newAttempt);
      return;
    }

    // 3c-b cooldown branch: init failed, no retry. If a fresh
    // cooldown window engaged in this incident, surface it on the
    // wire so backend can project `agent_status crashed
    // reason=init_cooldown` for the now-dead handle. `cooldownUntil > now`
    // is the only "really cooling down right now" check (Cindy plan
    // v2 issue #2 — cooldown ≠ retry-exhausted; the two are
    // independent state). #task:1460: a pre-init exit accounted above
    // takes the exact same branch — it engages cooldown identically, so
    // backend sets `initFailureFlag` (suppressing the next respawn) and
    // the start-time cooldown gate refuses fresh starts. The
    // `runtime_init_cooldown` emit MUST precede the terminal
    // `runtime_state` / `runtime_exit` below so backend has the flag set
    // before it processes the exit.
    if (handle.initTimedOut || preInitFailure) {
      const state = this.initRetryStates.get(k);
      if (state && state.cooldownUntil > this.now()) {
        this.emit({
          event: 'runtime_init_cooldown',
          conversation_id: handle.conversationId,
          agent_id: handle.agentId,
          cooldown_until: state.cooldownUntil,
          attempts_exhausted: state.failures,
          ts: this.now(),
        });
      }
    }

    // Cindy `YW2BGWryWjfymPkU` B3 + `5nruk1IPaEHSab0T` B4: terminal
    // cleanup goes through `resolveRun`, which (a) maps the reason to
    // the correct terminal status per CM, (b) emits the terminal
    // `runtime_state`, and (c) clears `handle.runState` so the next
    // run starts with a fresh `runId` and no stale terminalReason.
    //
    // Reason mapping (matches CM `conversation-manager.ts` lines
    // 856-907):
    //   init watchdog killed it → `timeout` (precedence over intentional)
    //   intentional stop request → `stopped`
    //   pre-init failure (#task:1460) → `crashed`, even on code === 0:
    //     a long-lived runtime that dies before `session_init` did NOT
    //     reply, so it must not project `replied → idle`; and it is NOT a
    //     `timeout` (the watchdog never fired). A oneShot's CLEAN code-0
    //     exit is excluded from `preInitFailure`, so it still maps to
    //     `replied` below; an ABNORMAL oneShot pre-init exit is a
    //     `preInitFailure` and correctly lands here as `crashed`.
    //   clean exit (code === 0)  → `replied`  (oneShot/cursor critical)
    //   non-zero / signal exit   → `crashed`
    // `replied → idle`, `timeout|stopped|crashed → failed` per CM's
    // terminalStatus table (Cindy `GMbjEkGUHrB1BBMe`).
    const reason: NonNullable<AgentRunState['terminalReason']> =
      handle.initTimedOut
        ? 'timeout'
        : intentional
          ? 'stopped'
          : preInitFailure
            ? 'crashed'
            : code === 0
              ? 'replied'
              : 'crashed';
    this.resolveRun(handle, reason);
    this.emit({
      event: 'runtime_exit',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      code,
      intentional,
      ts,
    });
  }

  // ── private: state emitter ─────────────────────────────────────

  /**
   * Emit a `runtime_state` reflecting `handle`'s current phase /
   * run-state. Two layers:
   *
   *   1. Phase-derived (starting/idle) — used when there's no
   *      handle.runState yet. Synthesizes a stable runId from
   *      pid+startedAt so consecutive phase emits correlate.
   *   2. Run-state-derived — when 3b's parsed-event lifecycle has
   *      produced a real AgentRunState we project it as-is.
   *
   * NOTE (Cindy `YW2BGWryWjfymPkU` B3): this method does NOT carry
   * `terminalReason`. Every terminal transition (turn_end, hard
   * stop, crash) MUST go through
   * `resolveRun` instead, which (a) maps reason → terminal status
   * per CM and (b) clears `handle.runState` so the next run starts
   * fresh. Passing terminalReason through here would let a
   * tool_running state get a `terminalReason` patched on without
   * the status flip, which is exactly the bug B3 is fixing.
   */
  private emitState(handle: RuntimeHandle): void {
    const ts = this.now();
    const base: AgentRunState = handle.runState
      ? {
          ...handle.runState,
          updatedAt: ts,
        }
      : {
          runId: `real-${handle.pid}-${handle.startedAt}`,
          agentId: handle.agentId,
          conversationId: handle.conversationId,
          status: phaseToStatus(handle.phase),
          startedAt: handle.startedAt,
          updatedAt: ts,
          lastActivityAt: ts,
        };
    this.emit({
      event: 'runtime_state',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      state: base,
      ts,
    });
  }

  // ── 3c-b: init watchdog + retry/cooldown + lifecycle lock ──────

  /**
   * Override-resolution for one init watchdog tier. Cindy
   * `-pdNvRYOWip5e9yA` locked precedence:
   *
   *   1. `opts.initWatchdogMs` (global override; one number applies
   *      to all three tiers — matches CM `ConversationManager.initWatchdogMs`)
   *   2. `opts.init<Tier>Ms`   (per-tier override on the supervisor)
   *   3. `driver.<tier>`       (driver opinion — claude/codex/cursor
   *      each declare their own defaults)
   *   4. `DEFAULT_INIT_<TIER>_MS`
   *
   * The global override exists specifically for tests that want one
   * tiny number for all three timers without overriding the per-tier
   * fields one by one.
   */
  private initTimeoutFor(driver: Driver, tier: InitTimeoutTier, fallback: number): number {
    if (this.initWatchdogMs !== null) return this.initWatchdogMs;
    const overrideMap: Record<InitTimeoutTier, number | undefined> = {
      initLivenessSilenceMs: this.initLivenessSilenceMs,
      initPreProtocolCapMs: this.initPreProtocolCapMs,
      initPostProtocolMs: this.initPostProtocolMs,
    };
    const override = overrideMap[tier];
    if (override !== undefined) return override;
    return driver[tier] ?? fallback;
  }

  /** Arm both the silence-tier and the pre-protocol-cap timer for
   *  this handle. Idempotent: clears any prior timers first so retries
   *  / delivery-driven deferred arming don't pile up. */
  private startInitWatchdog(handle: RuntimeHandle): void {
    this.clearInitWatchdog(handle);
    handle.initWatchdogArmed = true;
    handle.initStartedAt = this.now();
    this.armInitLivenessSilenceWatchdog(handle);
    const timeoutMs = this.initTimeoutFor(
      handle.driver,
      'initPreProtocolCapMs',
      DEFAULT_INIT_PRE_PROTOCOL_CAP_MS,
    );
    handle.initPreProtocolCapTimer = setTimer(() => {
      handle.initPreProtocolCapTimer = null;
      this.failInitWatchdog(handle, 'pre_protocol_cap', timeoutMs);
    }, timeoutMs);
    handle.initPreProtocolCapTimer.unref();
  }

  /** Clear every init-watchdog timer attached to this handle. Called
   *  from clearSession, hard stop, child exit, AND when init lands. */
  private clearInitWatchdog(handle: RuntimeHandle): void {
    if (handle.initLivenessSilenceTimer) {
      clearTimeout(handle.initLivenessSilenceTimer);
      handle.initLivenessSilenceTimer = null;
    }
    if (handle.initPreProtocolCapTimer) {
      clearTimeout(handle.initPreProtocolCapTimer);
      handle.initPreProtocolCapTimer = null;
    }
    if (handle.initPostProtocolTimer) {
      clearTimeout(handle.initPostProtocolTimer);
      handle.initPostProtocolTimer = null;
    }
  }

  /** (Re-)arm the silence-tier timer. Called on watchdog start AND on
   *  every refresh (raw byte arrival pre-protocol). */
  private armInitLivenessSilenceWatchdog(handle: RuntimeHandle): void {
    if (handle.initLivenessSilenceTimer) {
      clearTimeout(handle.initLivenessSilenceTimer);
      handle.initLivenessSilenceTimer = null;
    }
    const timeoutMs = this.initTimeoutFor(
      handle.driver,
      'initLivenessSilenceMs',
      DEFAULT_INIT_LIVENESS_SILENCE_MS,
    );
    handle.initLivenessSilenceTimer = setTimer(() => {
      handle.initLivenessSilenceTimer = null;
      this.failInitWatchdog(handle, 'silence', timeoutMs);
    }, timeoutMs);
    handle.initLivenessSilenceTimer.unref();
  }

  /** Reset the silence-tier debounce on every raw byte from the
   *  child. No-op once protocol or session ready has been observed —
   *  silence is only meaningful pre-first-frame. */
  private refreshInitLiveness(handle: RuntimeHandle): void {
    if (!handle.initWatchdogArmed) return;
    if (handle.initObserved || handle.initProtocolObserved || handle.initTimedOut) return;
    this.armInitLivenessSilenceWatchdog(handle);
  }

  /** Driver's pure line classifier advances the watchdog state
   *  machine. `protocol_ready` cancels silence + pre-protocol cap and
   *  arms the post-protocol timer; `session_ready` cancels every
   *  timer outright (the parsed `session_init` branch then flips
   *  `initObserved` + clears the retry bucket). */
  private observeInitProgress(handle: RuntimeHandle, line: string): void {
    if (!handle.initWatchdogArmed) return;
    if (handle.initObserved || handle.initTimedOut) return;
    const progress = handle.driver.classifyInitProgress(line);
    if (!progress) return;
    this.markInitProtocolReady(handle);
    if (progress === 'session_ready') this.clearInitWatchdog(handle);
  }

  private markInitProtocolReady(handle: RuntimeHandle): void {
    if (handle.initProtocolObserved) return;
    handle.initProtocolObserved = true;
    // Cancel the pre-protocol-only timers; arm the post-protocol
    // timer to bound the silence between first protocol frame and
    // session ready.
    if (handle.initLivenessSilenceTimer) {
      clearTimeout(handle.initLivenessSilenceTimer);
      handle.initLivenessSilenceTimer = null;
    }
    if (handle.initPreProtocolCapTimer) {
      clearTimeout(handle.initPreProtocolCapTimer);
      handle.initPreProtocolCapTimer = null;
    }
    const timeoutMs = this.initTimeoutFor(
      handle.driver,
      'initPostProtocolMs',
      DEFAULT_INIT_POST_PROTOCOL_MS,
    );
    handle.initPostProtocolTimer = setTimer(() => {
      handle.initPostProtocolTimer = null;
      this.failInitWatchdog(handle, 'post_protocol', timeoutMs);
    }, timeoutMs);
    handle.initPostProtocolTimer.unref();
  }

  /** Deferred-init arming for `requires_first_message` drivers. Called
   *  from `consumeStartupDelivery` after a successful first stdin write.
   *  No-op if watchdog
   *  already armed, init already observed, or init already timed out. */
  private ensureInitWatchdogArmed(handle: RuntimeHandle): void {
    if (handle.initWatchdogArmed || handle.initObserved || handle.initTimedOut) return;
    this.startInitWatchdog(handle);
  }

  /**
   * Watchdog fired. Emit `runtime_init_timeout`, decide retry vs
   * cooldown, then SIGTERM → SIGKILL the child. The exit handler
   * picks up the retry branch from `handle.initRetryPlanned`.
   *
   * Idempotent: bails if the handle is already gone, already init'd,
   * or already marked init-timed-out. This matters because three
   * timers race the same flag; only the first to fire counts.
   */
  private failInitWatchdog(
    handle: RuntimeHandle,
    reason: InitTimeoutReason,
    timeoutMs: number,
  ): void {
    const k = key(handle.conversationId, handle.agentId);
    if (!this.handles.has(k) || handle.initObserved || handle.initTimedOut) return;

    this.clearInitWatchdog(handle);
    handle.initTimedOut = true;
    handle.initTimeoutReason = reason;
    // Cindy `HyC05fC-FEs94uoZ` B3: flip to `draining` + emit state so
    // the delivery gate (`handle.phase === 'draining' → reason:'draining'`)
    // covers the SIGTERM→SIGKILL kill window. Without this, backend
    // could `runtime_deliver` between the timer firing and the child
    // actually exiting, and the daemon would write stdin + markDelivered
    // a message to a process that's already being killed. We do NOT
    // touch `intentionalExit` — the watchdog kill is daemon-initiated,
    // not a user stop, and the exit handler's reason mapping still
    // resolves to `'timeout'` (which takes precedence over both
    // `intentional` and `code === 0`). The retry-respawn branch in
    // `onChildExit` doesn't gate on phase, so this draining flip does
    // not block `internalRespawnForRetry`.
    handle.phase = 'draining';
    this.emitState(handle);
    // Account the failure (pure), then decide daemon-internal retry —
    // a watchdog-only concern: retry only when no cooldown is active,
    // attempts remain, and the exit wasn't user-intentional.
    const { cooldownUntilOnEvent } = this.recordInitFailure(handle);
    const retry =
      cooldownUntilOnEvent === null &&
      handle.initAttempt < this.initMaxRetries &&
      !handle.intentionalExit;
    handle.initRetryPlanned = retry;

    const elapsedMs = this.now() - handle.initStartedAt;
    this.logger.warn(
      {
        kind: 'process',
        action: 'init_watchdog_fired',
        pid: handle.pid,
        conversationId: handle.conversationId,
        agent_id: handle.agentId,
        timeout_reason: reason,
        elapsed_ms: elapsedMs,
        timeout_ms: timeoutMs,
        retry_attempt: handle.initAttempt,
        retrying: retry,
      },
      'init watchdog fired; killing child',
    );
    this.emit({
      event: 'runtime_init_timeout',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      timeout_reason: reason,
      elapsed_ms: elapsedMs,
      timeout_ms: timeoutMs,
      retrying: retry,
      retry_attempt: handle.initAttempt,
      max_retries: this.initMaxRetries,
      ...(cooldownUntilOnEvent !== null
        ? { cooldown_until: cooldownUntilOnEvent }
        : {}),
      ts: this.now(),
    });

    // SIGTERM → SIGKILL cascade. Use the supervisor's grace-period
    // knob so test runs stay snappy.
    try {
      handle.child.kill('SIGTERM');
    } catch {
      // Already gone — exit listener fires the cleanup either way.
    }
    setTimer(() => {
      if (!this.handles.has(k)) return;
      if (handle.phase === 'exited') return;
      try {
        handle.child.kill('SIGKILL');
      } catch {
        // Already gone — same.
      }
    }, this.sigtermToSigkillMs).unref();
  }

  /** Bump the sticky per-(conv, agent) init-failure counter and engage
   *  the cooldown clock when the threshold is crossed. PURE accounting —
   *  it deliberately does NOT decide daemon-internal retry; that is the
   *  watchdog's concern (`failInitWatchdog`), layered on top of this
   *  result, and it does not apply to a backend-driven pre-init respawn.
   *  Returns the new failure count plus, when a cooldown window is active
   *  right now, its deadline (Cindy plan v2 issue #2: cooldown vs
   *  retry-exhausted are independent state). */
  private recordInitFailure(handle: RuntimeHandle): {
    failures: number;
    cooldownUntilOnEvent: number | null;
  } {
    const k = key(handle.conversationId, handle.agentId);
    const now = this.now();
    const state = this.initRetryStates.get(k) ?? { failures: 0, cooldownUntil: 0 };
    state.failures += 1;
    if (state.failures >= this.initFailureCooldownThreshold) {
      state.cooldownUntil = now + this.initFailureCooldownMs;
    }
    this.initRetryStates.set(k, state);
    const cooldownActive = state.cooldownUntil > now;
    return {
      failures: state.failures,
      cooldownUntilOnEvent: cooldownActive ? state.cooldownUntil : null,
    };
  }

  /** Wipe the failure counter + cooldown clock. Called on successful
   *  `session_init` AND when start_unlocked observes a no-op
   *  idempotent return — neither of those cases should keep an old
   *  incident window alive. */
  private clearInitRetryState(conversationId: string, agentId: string): void {
    this.initRetryStates.delete(key(conversationId, agentId));
  }

  /** Is the (conv, agent) currently inside an active cooldown window? */
  private isInitCoolingDown(k: string): boolean {
    const state = this.initRetryStates.get(k);
    return !!state && state.cooldownUntil > this.now();
  }

  /**
   * Daemon-internal retry respawn. Called from the child-exit handler
   * when `initRetryPlanned` was true. Goes through `startWithLock` so
   * the per-(conv, agent) lifecycle lock serializes the respawn
   * against any concurrent user-initiated start / stop / clearSession.
   * Errors are logged but not propagated — the retry already emitted
   * `runtime_init_retrying`; a failed respawn surfaces as the next
   * watchdog firing or a different `runtime_exit`.
   */
  private async internalRespawnForRetry(
    originalParams: RuntimeStartParams,
    newAttempt: number,
  ): Promise<void> {
    try {
      await this.startWithLock(originalParams, newAttempt);
    } catch (err) {
      this.logger.error(
        {
          kind: 'process',
          action: 'init_retry_respawn_failed',
          conversationId: originalParams.conversation_id,
          agent_id: originalParams.agent_id,
          retry_attempt: newAttempt,
          error_message: (err as Error).message,
        },
        'init watchdog retry respawn failed',
      );
    }
  }

  /**
   * Per-(conv, agent) lifecycle serialization. Cindy plan v2 issue
   * #6 + tightening `ixAq6GPTn4fVSpCF`:
   *
   *   - Covers ONLY lifecycle mutations: start, hard stop, clearSession,
   *     internal retry respawn. delivery/output-pause go around.
   *   - Per-key, not global — different (conv, agent) ops parallelize.
   *   - Survives previous-op failure: a rejected predecessor must not
   *     wedge the queue. We swallow the previous tail's rejection at
   *     the await site.
   *
   * The map entry holds the *latest tail* so subsequent calls queue
   * behind every in-flight op for that key.
   */
  private async withLifecycleLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleTails.get(k);
    let resolveTail!: () => void;
    const tail = new Promise<void>(r => {
      resolveTail = r;
    });
    this.lifecycleTails.set(k, tail);
    try {
      if (prev) {
        // Tolerate previous-op failure — the queue keeps moving even
        // if an earlier start threw or a stop rejected.
        try {
          await prev;
        } catch {
          /* swallow — see comment */
        }
      }
      return await fn();
    } finally {
      resolveTail();
      // Only clear the map entry if we're still the tail. A faster
      // follow-up op may have already overwritten it with its own
      // tail; in that case the map should keep the newer reference.
      if (this.lifecycleTails.get(k) === tail) {
        this.lifecycleTails.delete(k);
      }
    }
  }

  // ── 3c-b: compaction watchdog ──────────────────────────────────

  /**
   * Arm the compaction watchdog. On fire: emit
   * `runtime_compaction_stale` AND stack `compactionStale: true` on
   * the run state (Cindy plan v2 issue #4 — observational only;
   * preserve `compacting: true`; do NOT kill the child or change
   * phase). Idempotent: clears any prior timer first.
   */
  private startCompactionWatchdog(handle: RuntimeHandle): void {
    this.clearCompactionWatchdog(handle);
    const startedAt = this.now();
    handle.compactionWatchdog = setTimer(() => {
      handle.compactionWatchdog = null;
      this.fireCompactionStale(handle, startedAt);
    }, this.compactionStaleMs);
    handle.compactionWatchdog.unref();
  }

  private clearCompactionWatchdog(handle: RuntimeHandle): void {
    if (handle.compactionWatchdog) {
      clearTimeout(handle.compactionWatchdog);
      handle.compactionWatchdog = null;
    }
  }

  private fireCompactionStale(handle: RuntimeHandle, startedAt: number): void {
    // Defense in depth: a finish that lands in the same tick as the
    // timer would clear the watchdog but we'd still be inside the
    // callback. Bail if compaction is no longer active.
    if (!handle.busy.compacting) return;
    if (handle.phase === 'exited' || handle.phase === 'draining') return;
    const elapsedMs = this.now() - startedAt;
    this.logger.warn(
      {
        kind: 'process',
        action: 'compaction_stale',
        pid: handle.pid,
        conversationId: handle.conversationId,
        agent_id: handle.agentId,
        elapsed_ms: elapsedMs,
      },
      'compaction has been running past the stale window with no finish event',
    );
    this.emit({
      event: 'runtime_compaction_stale',
      conversation_id: handle.conversationId,
      agent_id: handle.agentId,
      elapsed_ms: elapsedMs,
      ts: this.now(),
    });
    // Stack stale onto the run state; explicitly do NOT touch
    // `compacting` — the UI must still show "compacting (stale)",
    // not "no longer compacting".
    this.transitionRunState(handle, { compactionStale: true });
  }
}

/** Phase → AgentRunState.status mapping used when no parsed-event
 *  run-state has been recorded yet. Matches the 3a contract. */
function phaseToStatus(phase: RuntimePhase): AgentRunState['status'] {
  switch (phase) {
    case 'spawning':
    case 'startup_pending':
      return 'starting';
    case 'ready':
    case 'draining':
    case 'exited':
      return 'idle';
  }
}

/**
 * Read `driver.readyToEncode()` with a default-true fallback for
 * drivers that don't implement the optional method. Stateless drivers
 * (claude) typically omit it; stateful drivers (codex) MUST implement
 * so the daemon's `ready_for_drain` gate, the `runtime_deliver`
 * `driver_not_ready` refuse arm, and the startup_delivery defer-pre-encode
 * path (Option A v2 — Cindy `UMGu36zoTDVuKWXi`) all key off the right state.
 *
 * Lifted to a module-level helper rather than an instance method so
 * `consumeStartupDelivery` / `tryConsumeStartupDelivery` /
 * `maybeEmitReadyForDrain` / `deliver` can call it
 * without re-establishing `this` binding.
 */
function driverReadyToEncode(driver: Driver): boolean {
  return driver.readyToEncode?.() ?? true;
}

async function assertRuntimeStartWorkspacePath(
  workspace: ResolvedWorkspaceRef,
): Promise<void> {
  try {
    const st = await stat(workspace.path);
    if (st.isDirectory()) return;
    throw new RuntimeStartResolveError(
      'workspace_path_missing',
      `runtime_start: resolved ${workspace.kind} workspace "${workspace.name}" ` +
        `(${workspace.id}) path is not a directory: ${workspace.path}`,
    );
  } catch (err) {
    if (err instanceof RuntimeStartResolveError) throw err;
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : null;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new RuntimeStartResolveError(
        'workspace_path_missing',
        `runtime_start: resolved ${workspace.kind} workspace "${workspace.name}" ` +
          `(${workspace.id}) path does not exist: ${workspace.path}`,
      );
    }
    throw new Error(
      `runtime_start: failed to access resolved ${workspace.kind} workspace ` +
        `"${workspace.name}" (${workspace.id}) path ${workspace.path}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
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

function trimActivitySnippet(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length <= ACTIVITY_SNIPPET_MAX_CHARS
    ? normalized
    : normalized.slice(-ACTIVITY_SNIPPET_MAX_CHARS);
}

/**
 * Default binary resolver — wraps `detectRuntimes()` from
 * `packages/host/src/runtimes.ts`. The detector has a short cache, but a
 * miss is force-refreshed so installing a runtime after daemon boot does not
 * require a daemon restart before spawn can find it.
 */
async function detectedBinaries(force = false): Promise<Map<RuntimeKind, string>> {
  const infos = await detectRuntimes({ force });
  const m = new Map<RuntimeKind, string>();
  for (const info of infos) {
    if (info.installed && info.binary) m.set(info.kind, info.binary);
  }
  return m;
}

async function defaultResolveBinary(
  kind: RuntimeKind,
  _fallback: string,
): Promise<string | null> {
  const cached = await detectedBinaries(false);
  const found = cached.get(kind);
  if (found) return found;
  const fresh = await detectedBinaries(true);
  return fresh.get(kind) ?? null;
}

export type { RuntimeHandle, RuntimePhase };
