import { readFileSync } from 'node:fs';
import { type Driver, type DriverSpawnContext, type ParsedEvent } from './index.js';
import {
  classifyStreamJsonInitProgress,
  encodeStreamJsonUserMessage,
  parseStreamJsonLine,
} from './stream-json.js';
import { versionAtLeast } from './version-gate.js';

/**
 * Verified enable floor for `qodercli`'s `priority:"next"` steer — NOT a
 * claim about the first release that shipped it.
 *
 * What is actually proven: on 1.1.17, `priority:"next"` is a
 * non-destructive mid-turn steer that the runtime drains at the next tool
 * boundary of the SAME turn, and echoes through `command_lifecycle` frames
 * keyed by our payload uuid (#task:1907). Separately, 1.0.48 accepts the
 * field but its headless handler never forwards/honours it (#task:1556) —
 * that is the ONE build with negative evidence. Everything strictly between
 * those two, and every unparseable version, is simply untested; shiki chose
 * 1.1.17 as the conservative floor.
 *
 * So below the floor we treat the capability as UNPROVEN and fail closed:
 * neither the field nor the steer profile. If a lower release is ever
 * measured to honour it, the floor may drop — with that evidence attached.
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
    typeof frame.queue_count === 'number' &&
    Number.isInteger(frame.queue_count) &&
    frame.queue_count >= 0
  ) {
    details.push(`queue size ${frame.queue_count}`);
  }
  if (
    typeof frame.wait_time_ms === 'number' &&
    Number.isFinite(frame.wait_time_ms) &&
    frame.wait_time_ms >= 0
  ) {
    const seconds = Math.round(frame.wait_time_ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    details.push(`estimated wait ${minutes > 0 ? `${minutes}m ` : ''}${remainingSeconds}s`);
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
 * Release profile is the one capability that varies with the CLI version
 * (#task:1909): at/above the verified enable floor `1.1.17`,
 * `priority:"next"` is honoured and `command_lifecycle` comes back, so
 * those builds get Claude's `tool-boundary-steer`; anything below the
 * floor — or unparseable — is treated as unproven and stays on
 * `next-turn-batch` (see {@link STEER_MIN_VERSION} for what is actually
 * measured vs merely untested). The version comes from the detection the
 * spawn path already performs and is bound once per process generation via
 * `bindRuntimeVersion` — the driver never probes and never re-resolves.
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

  /**
   * #task:2210: settlement policy is version-bound on the same evidence
   * axis as {@link releaseProfile}. At/above the floor, `priority:"next"`
   * echoes through `command_lifecycle` keyed by our payload uuid, so
   * `input_lifecycle{state:'started'}` is a real per-payload proof
   * (`lifecycle-start`).
   *
   * Below the floor there is no per-payload lifecycle frame and no uuid is
   * stamped (see `encodeStdinMessage`). shiki explicitly accepts the weaker
   * `write-success` settlement there: the existing `next-turn-batch` release
   * already keeps the write inside a safe window, and #2210 preserves that
   * driver's current behavior byte-for-byte (no new deferral, no fixture
   * experiment). Pinned to the process generation via `bindRuntimeVersion`,
   * never re-resolved per turn.
   */
  get admissionPolicy(): 'lifecycle-start' | 'write-success' {
    return this.steerCapable ? 'lifecycle-start' : 'write-success';
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
      // Below the enable floor the capability is unproven (1.0.48 accepts
      // `priority` but its headless handler never honours it, #task:1556;
      // the rest is untested), and no per-payload `command_lifecycle` is
      // known to come back. Stamping either field would be noise at best
      // and a false capability claim at worst. Keep the frame minimal.
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
