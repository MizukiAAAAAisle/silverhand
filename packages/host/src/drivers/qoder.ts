import { readFileSync } from 'node:fs';
import {
  type Driver,
  type DriverSpawnContext,
  type ParsedEvent,
} from './index.js';
import {
  classifyStreamJsonInitProgress,
  encodeStreamJsonUserMessage,
  parseStreamJsonLine,
} from './stream-json.js';
import { versionAtLeast } from './version-gate.js';

/**
 * First `qodercli` release whose stdin `user` frame honours
 * `priority:"next"` — a non-destructive mid-turn steer that the runtime
 * drains at the next tool boundary of the SAME turn, and echoes through
 * `command_lifecycle` frames keyed by our payload uuid. Verified
 * empirically on 1.1.17 (#task:1907); shiki set 1.1.17 as the floor.
 *
 * Below this floor `priority` is unknown to the CLI, so we neither send
 * the field nor claim the steer profile: those builds only accept input
 * between turns (`next-turn-batch`).
 */
const STEER_MIN_VERSION = '1.1.17';

/**
 * Qoder tools that clash with Silverhand's own contracts and must be
 * denied so the agent can't run a parallel, invisible control plane:
 *  - plan mode (Silverhand has no plan/exit-plan affordance);
 *  - cron / scheduling (Silverhand owns schedules via the CLI);
 *  - goals (Silverhand owns work tracking via tasks).
 * Mirrors the Claude driver's disallow rationale, extended for Qoder's
 * native goal tools (`{Create,Get,Update}Goal`), which Claude lacks.
 * Tool names verified from qoder's `system/init.tools` list (v1.0.37).
 */
const DISALLOWED_TOOLS = [
  'EnterPlanMode',
  'ExitPlanMode',
  'CronCreate',
  'CronList',
  'CronDelete',
  'CreateGoal',
  'GetGoal',
  'UpdateGoal',
].join(',');

function queueStatusEvent(line: string): ParsedEvent | null {
  if (!line.includes('"model_queue_status"')) return null;

  let frame: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    frame = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (frame.type !== 'system' || frame.subtype !== 'model_queue_status') {
    return null;
  }

  if (frame.status === 'ready') {
    return {
      kind: 'api_response',
      status: 'ready',
      message: 'Qoder model is available; resuming request',
    };
  }
  if (frame.status !== 'queued') return null;

  const details: string[] = [];
  if (
    typeof frame.queue_count === 'number'
    && Number.isInteger(frame.queue_count)
    && frame.queue_count >= 0
  ) {
    details.push(`queue size ${frame.queue_count}`);
  }
  if (
    typeof frame.wait_time_ms === 'number'
    && Number.isFinite(frame.wait_time_ms)
    && frame.wait_time_ms >= 0
  ) {
    const seconds = Math.round(frame.wait_time_ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    details.push(
      `estimated wait ${minutes > 0 ? `${minutes}m ` : ''}${remainingSeconds}s`,
    );
  }

  const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  return {
    kind: 'api_response',
    status: 'waiting',
    message: `Qoder model request queued${suffix}`,
  };
}

/**
 * Qoder CLI driver (`qodercli`).
 *
 * Qoder speaks the same bidirectional `stream-json` protocol as Claude
 * Code (empirically verified against `qodercli 1.0.37`): it withholds
 * `system/init` until the first real stdin user turn, is long-lived
 * (not one-shot), queues follow-up turns, and resumes context across
 * processes via `--resume <session_id>`. So it slots into the exact
 * same host-supervision boundary as Claude — `requires_first_message`
 * kickoff + boundary-gated release — with **no supervisor-level runtime
 * branch**, and reuses the shared `stream-json` parser.
 *
 * Release profile is the one capability that moved with the CLI version
 * (#task:1909): `>= 1.1.17` honours `priority:"next"` and echoes
 * `command_lifecycle`, so those builds get Claude's
 * `tool-boundary-steer`; older builds stay on `next-turn-batch`. The
 * version comes from the detection the spawn path already performs and
 * is bound once per process generation via `bindRuntimeVersion` — the
 * driver never probes and never re-resolves.
 *
 * Deliberate divergences from the Claude driver:
 *  - No `--verbose` / `--allow-dangerously-skip-permissions`: Qoder's
 *    arg parser doesn't recognize them and prints usage + exits.
 *  - `--permission-mode bypass_permissions` (snake_case) per Qoder's
 *    documented choices (Claude uses `bypassPermissions`).
 *  - Standing prompt goes via `--append-system-prompt <text>`: Qoder
 *    has no `--append-system-prompt-file`, so we read the materialized
 *    `systemPromptPath` and pass its contents inline (same approach the
 *    codex/cursor drivers already take for runtimes without a file
 *    flag). Verified: the ~54KB platform prompt passes via argv.
 *  - `encodeInterruptControl` returns null: Qoder's control-request
 *    protocol is unverified, so we let the supervisor fall through to
 *    SIGTERM/SIGKILL rather than send a frame Qoder might not honor.
 *
 * Operational notes:
 *  - Qoder intentionally inherits the developer machine's normal qoder
 *    config/hooks/skills by default (visible as `hook_started` /
 *    `hook_response` frames + auto-triggered skills). shiki explicitly
 *    chose this over a hermetic config root so existing user habits carry
 *    into Silverhand. A future hermetic mode would be a product decision,
 *    not a driver-default cleanup.
 *  - Profile MCP injection lives in the daemon spawn loader, not this
 *    driver. Qoder uses the same Claude-shaped `--mcp-config <file>`
 *    projection there.
 *  - Resume-failure surfaces on stderr (not a stdout `result` frame),
 *    so it can't be classified here as `session_not_found`. Behaviour
 *    then matches Claude's invalid-resume path anyway: no `session_init`
 *    → init watchdog → retry respawn.
 */
export class QoderDriver implements Driver {
  readonly kind = 'qoder' as const;
  readonly binary = 'qodercli';
  readonly kickoffMode = 'requires_first_message' as const;
  readonly oneShot = false;
  readonly supportsNativeStandingPrompt = true;
  readonly initLivenessSilenceMs = 30 * 1000;
  readonly initPreProtocolCapMs = 5 * 60 * 1000;
  readonly initPostProtocolMs = 60 * 1000;

  /** Resolved once by `bindRuntimeVersion`; false until then so a driver
   *  instance nobody bound behaves like an old CLI (fail closed). */
  private steerCapable = false;

  /**
   * Version-derived, pinned to this instance = to the child process
   * generation (`getDriver` mints one driver per spawn). Reading it is
   * safe at any boundary decision; re-resolving per turn would let a
   * mid-session CLI upgrade change how an already-running child is
   * driven, which is exactly the bug the pin prevents.
   */
  get releaseProfile(): 'tool-boundary-steer' | 'next-turn-batch' {
    return this.steerCapable ? 'tool-boundary-steer' : 'next-turn-batch';
  }

  bindRuntimeVersion(version: string | null): void {
    this.steerCapable = versionAtLeast(version, STEER_MIN_VERSION);
  }

  buildArgs(ctx: DriverSpawnContext): string[] {
    const standingPrompt = readFileSync(ctx.systemPromptPath, 'utf-8');
    const args = [
      '--dangerously-skip-permissions',
      '--permission-mode',
      'bypass_permissions',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--disallowed-tools',
      DISALLOWED_TOOLS,
      '--append-system-prompt',
      standingPrompt,
    ];
    if (ctx.model) {
      args.push('--model', ctx.model);
    }
    if (ctx.reasoningEffort) {
      args.push('--reasoning-effort', ctx.reasoningEffort);
    }
    if (ctx.cliSessionId) {
      args.push('--resume', ctx.cliSessionId);
    }
    return args;
  }

  applyEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...baseEnv };
  }

  encodeStdinMessage(
    content: string,
    cliSessionId: string | null,
    opts?: { payloadUuid?: string },
  ): string {
    if (!this.steerCapable) {
      // Pre-1.1.17: `priority` is not in the CLI's frame schema and the
      // runtime emits no per-payload `command_lifecycle`, so stamping
      // either field would be noise at best. Keep the frame minimal.
      return encodeStreamJsonUserMessage(content, cliSessionId);
    }
    // 1.1.17+: state the tool-boundary-steer intent explicitly, and carry
    // the supervisor's payload uuid so the runtime's `command_lifecycle`
    // frames correlate back to this batch — `started` is what promotes the
    // batch from pending-admission to model-seen (`input_lifecycle`).
    return encodeStreamJsonUserMessage(content, cliSessionId, opts?.payloadUuid, {
      priority: 'next',
    });
  }

  encodeInterruptControl(): string | null {
    return null;
  }

  parseLine(line: string): ParsedEvent[] {
    const queueStatus = queueStatusEvent(line);
    if (queueStatus) return [queueStatus];
    return parseStreamJsonLine(line, { runtimeLabel: 'Qoder' });
  }

  classifyInitProgress(line: string): 'protocol_ready' | 'session_ready' | null {
    return classifyStreamJsonInitProgress(line);
  }
}
