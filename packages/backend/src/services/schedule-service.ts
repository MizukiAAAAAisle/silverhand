import { parseExpression } from 'cron-parser';
import {
  SCHEDULE_MAX_ACTIVE_PER_AGENT,
  SCHEDULE_MAX_DELAY_SECONDS,
  SCHEDULE_MIN_DELAY_SECONDS,
  SCHEDULE_MIN_INTERVAL_SECONDS,
  ScheduleCreateInputSchema,
  type ScheduleCreateInput,
  type ScheduleDto,
  type ScheduleListStatusFilter,
  type ScheduleSpec,
  type ScheduleStatus,
  systemSubtype,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type { ConversationManager } from '../conversation-manager.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { ScheduleRepo } from '../repos/schedule-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';

/** Reasons a `schedule` request is rejected. The MCP route in PR-2 maps
 *  these to the agent-facing JSON error payload; failure to deliver wakes
 *  is logged but does NOT surface here (the schedule transitions to
 *  `failed` instead).
 */
export type ScheduleErrorCode =
  | 'invalid_input'
  | 'invalid_cron_expression'
  | 'invalid_timezone'
  | 'fire_at_too_soon'
  | 'fire_at_too_far'
  | 'unbounded_repeat_requires_explicit_limit'
  | 'too_many_active_schedules'
  | 'agent_not_found'
  | 'agent_home_not_found'
  | 'schedule_not_found'
  | 'not_owner'
  | 'not_cancellable';

export class ScheduleError extends Error {
  constructor(
    public readonly code: ScheduleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

export interface ScheduleServiceOptions {
  schedules: ScheduleRepo;
  workspaces: WorkspaceRepo;
  messages: MessageRepo;
  agents: AgentRepo;
  conversationManager: ConversationManager;
  events: ScopeEventBus;
  logger: BackendLogger;
  /** Override `Date.now()` in tests so the scheduler clock is
   *  deterministic. Default = `Date.now`. */
  now?: () => number;
  /** Test seam: skip the timer install in unit tests where we drive
   *  ticks manually. Default = false. */
  disableAutoTick?: boolean;
}

const SWEEP_INTERVAL_MS = 60_000;
/** Cap for the short-window setTimeout — never schedule a timer further
 *  than this into the future. Long timers are unreliable on macOS
 *  (Electron app-nap, system sleep, drift); the 1-minute sweep is the
 *  durable backstop. */
const NEAR_TIMER_CAP_MS = 60_000;

/**
 * Scheduler for agent-owned schedules. Two clocks cooperate:
 *
 * 1. **Sweep tick** every `SWEEP_INTERVAL_MS` (default 1 min): scans
 *    for any `pending` row with `next_fire_at <= now`. This is the
 *    durable backstop — even when timers drift / app napped, missed
 *    schedules eventually fire.
 *
 * 2. **Near timer**: when the sweep finishes (or after a fire), arm a
 *    one-shot setTimeout for the next due row IF it's within
 *    `NEAR_TIMER_CAP_MS`. Gives sub-minute latency for imminent fires
 *    without trusting long-running timers.
 *
 * Concurrent ticks (sweep ↔ near timer ↔ dev double scheduler) all
 * race through `ScheduleRepo.tryClaim()`'s CAS — at most one wins
 * per row.
 */
export class ScheduleService {
  private readonly schedules: ScheduleRepo;
  private readonly workspaces: WorkspaceRepo;
  private readonly messages: MessageRepo;
  private readonly agents: AgentRepo;
  private readonly conversationManager: ConversationManager;
  private readonly events: ScopeEventBus;
  private readonly logger: BackendLogger;
  private readonly now: () => number;
  private readonly disableAutoTick: boolean;
  private sweepTimer: NodeJS.Timeout | null = null;
  private nearTimer: NodeJS.Timeout | null = null;
  private nearTimerFireAt: number | null = null;
  /** Reentrancy guard on `tick()` — fires might overlap if a tick
   *  takes >1 minute under load (very unlikely but defended). */
  private ticking = false;

  constructor(opts: ScheduleServiceOptions) {
    this.schedules = opts.schedules;
    this.workspaces = opts.workspaces;
    this.messages = opts.messages;
    this.agents = opts.agents;
    this.conversationManager = opts.conversationManager;
    this.events = opts.events;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.disableAutoTick = opts.disableAutoTick ?? false;
  }

  /**
   * Boot-time recovery + initial scheduling. Must be called AFTER
   * the DB / migrations are ready and BEFORE the process starts
   * accepting schedule requests.
   *
   * Recovery rule: any row left in `firing` from a prior process
   * lifetime is reset to `pending`. We do not know whether the
   * pre-crash fire actually delivered — the safer of the two
   * outcomes is "deliver again" (idempotency from the agent's
   * perspective is its own concern; duplicate wake is benign).
   */
  start(): void {
    const reset = this.schedules.resetStaleFiring();
    if (reset > 0) {
      this.logger.info(
        { count: reset },
        'schedule-service: reset stale firing rows on boot',
      );
    }
    if (this.disableAutoTick) return;
    // Run an immediate tick to catch up overdue rows from the
    // pre-startup window, then arm the periodic sweep + near timer.
    void this.tick().catch(err =>
      this.logger.error(
        { err },
        'schedule-service: initial tick failed',
      ),
    );
    this.sweepTimer = setInterval(() => {
      void this.tick().catch(err =>
        this.logger.error({ err }, 'schedule-service: sweep tick failed'),
      );
    }, SWEEP_INTERVAL_MS);
    // setInterval keeps the event loop alive in dev — fine for the
    // backend process. Tests opt out via `disableAutoTick`.
  }

  /** Tear down all timers. Idempotent. */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.nearTimer) {
      clearTimeout(this.nearTimer);
      this.nearTimer = null;
      this.nearTimerFireAt = null;
    }
  }

  // ── Public API (called by future MCP route) ───────────────────

  /**
   * Validate input, enforce quota/range, compute initial
   * `next_fire_at`, persist. Throws `ScheduleError` for any caller
   * fault; never throws for transient I/O.
   */
  create(input: ScheduleCreateInput, ownerAgentId: string): ScheduleDto {
    const parsed = ScheduleCreateInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ScheduleError(
        'invalid_input',
        `schedule input failed validation: ${parsed.error.message}`,
      );
    }
    const data = parsed.data;

    const agent = this.agents.get(ownerAgentId);
    if (!agent) {
      throw new ScheduleError(
        'agent_not_found',
        `agent ${ownerAgentId} not found`,
      );
    }
    // agent_home presence is a real wake-time precondition; reject at
    // schedule time so the agent learns immediately rather than seeing
    // a `failed` schedule later.
    const home = this.workspaces.getAgentHomeByOwner(ownerAgentId);
    if (!home || !home.dm_channel_id) {
      throw new ScheduleError(
        'agent_home_not_found',
        `agent ${ownerAgentId} has no agent_home dm_channel`,
      );
    }

    const active = this.schedules.countActive(ownerAgentId);
    if (active >= SCHEDULE_MAX_ACTIVE_PER_AGENT) {
      throw new ScheduleError(
        'too_many_active_schedules',
        `agent has ${active} active schedules (cap ${SCHEDULE_MAX_ACTIVE_PER_AGENT})`,
      );
    }

    const now = this.now();

    // Canonicalize spec + initial next_fire_at.
    let canonicalSpec: ScheduleSpec;
    let nextFireAt: number;
    if (data.spec.kind === 'once') {
      const fireAt = data.spec.fire_at
        ? data.spec.fire_at
        : now + (data.spec.delay_seconds ?? 0) * 1000;
      this.assertOneShotDelay(now, fireAt);
      canonicalSpec = { kind: 'once', fire_at: fireAt };
      nextFireAt = fireAt;
    } else if (data.spec.kind === 'interval') {
      // interval lower bound is enforced in the zod schema; assert
      // here for defense-in-depth.
      if (data.spec.every_seconds < SCHEDULE_MIN_INTERVAL_SECONDS) {
        throw new ScheduleError(
          'invalid_input',
          `interval every_seconds must be >= ${SCHEDULE_MIN_INTERVAL_SECONDS}`,
        );
      }
      this.assertRepeatBounded(data);
      const startAt = data.spec.start_at ?? now + data.spec.every_seconds * 1000;
      // start_at in the past is fine — scheduler tick treats it as
      // overdue and fires immediately, advancing from `actual_fire_at`.
      // But guard against unboundedly stale values that would burn
      // CPU in the catch-up loop.
      if (startAt < now - SCHEDULE_MAX_DELAY_SECONDS * 1000) {
        throw new ScheduleError(
          'fire_at_too_soon',
          'start_at is too far in the past',
        );
      }
      canonicalSpec = {
        kind: 'interval',
        every_seconds: data.spec.every_seconds,
        ...(data.spec.start_at !== undefined
          ? { start_at: data.spec.start_at }
          : {}),
      };
      nextFireAt = startAt;
    } else {
      // cron
      this.assertRepeatBounded(data);
      this.assertValidTimezone(data.spec.timezone);
      const next = this.computeCronNext(
        data.spec.expression,
        data.spec.timezone,
        now,
      );
      canonicalSpec = {
        kind: 'cron',
        expression: data.spec.expression,
        timezone: data.spec.timezone,
      };
      nextFireAt = next;
    }

    // until_at sanity: must be in the future and after first fire,
    // otherwise the schedule could never fire even once.
    if (data.until_at !== undefined) {
      if (data.until_at <= now) {
        throw new ScheduleError(
          'invalid_input',
          'until_at must be in the future',
        );
      }
      if (data.until_at < nextFireAt) {
        throw new ScheduleError(
          'invalid_input',
          'until_at is before the first fire time',
        );
      }
    }

    const schedule = this.schedules.insert({
      ownerAgentId,
      message: data.message,
      spec: canonicalSpec,
      nextFireAt,
      maxOccurrences: data.max_occurrences ?? null,
      untilAt: data.until_at ?? null,
    });

    // Tighten near timer in case this is the new earliest due row.
    this.armNearTimer();

    return schedule;
  }

  /** List `ownerAgentId`'s schedules filtered by status family.
   *  `'active'` is sugar for `['pending','firing']`; the DB never
   *  persists the literal `active`. */
  list(
    ownerAgentId: string,
    status: ScheduleListStatusFilter | undefined,
    limit: number | undefined,
  ): ScheduleDto[] {
    const filter = this.expandStatusFilter(status ?? 'all');
    return this.schedules.listForAgent(ownerAgentId, filter, limit ?? 100);
  }

  /** Agent-initiated cancel. Must validate `ownerAgentId` matches the
   *  schedule's owner — without this an agent could cancel another
   *  agent's schedule by guessing IDs. */
  cancel(scheduleId: string, ownerAgentId: string): ScheduleDto {
    const existing = this.schedules.get(scheduleId);
    if (!existing) {
      throw new ScheduleError(
        'schedule_not_found',
        `schedule ${scheduleId} not found`,
      );
    }
    if (existing.owner_agent_id !== ownerAgentId) {
      throw new ScheduleError(
        'not_owner',
        `schedule ${scheduleId} is owned by another agent`,
      );
    }
    const ok = this.schedules.cancel(scheduleId);
    if (!ok) {
      throw new ScheduleError(
        'not_cancellable',
        `schedule ${scheduleId} is in terminal state ${existing.status}`,
      );
    }
    const after = this.schedules.get(scheduleId);
    if (!after) {
      throw new Error(`schedule ${scheduleId} vanished after cancel`);
    }
    return after;
  }

  // ── Scheduler internals ───────────────────────────────────────

  /**
   * One scan of due rows. For each: CAS-claim → fire wake → advance
   * (repeat) or terminal `done` (one-shot or repeat-cap hit). Failure
   * to enqueue/wake → terminal `failed`.
   *
   * Public so tests can drive ticks manually with `disableAutoTick`.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const due = this.schedules.listDuePending(now, 200);
      for (const dto of due) {
        await this.processOne(dto);
      }
      this.armNearTimer();
    } finally {
      this.ticking = false;
    }
  }

  /** Caller-visible for tests; service code uses tick() which iterates. */
  async processOne(dto: ScheduleDto): Promise<void> {
    if (!this.schedules.tryClaim(dto.id)) {
      // Lost the CAS race — another tick already owns this fire.
      return;
    }
    const actualFireAt = this.now();
    // Pre-compute the post-fire transition (terminal vs re-arm + the
    // next fire time) BEFORE delivering the wake — the wake body needs
    // both `next_fire_at` and `missed_count` to be useful to the agent.
    const advancement = this.planAdvancement(dto, actualFireAt);
    try {
      await this.deliverWake(dto, actualFireAt, advancement);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { scheduleId: dto.id, ownerAgentId: dto.owner_agent_id, err },
        'schedule-service: wake delivery failed; marking failed',
      );
      // Predicated on `status='firing'` so a concurrent cancel still wins.
      this.schedules.markFailed(dto.id, reason);
      return;
    }
    // Apply the planned transition. Each predicate is `status='firing'`,
    // so a `cancel()` that raced in after CAS but before this update
    // makes the row terminal-`cancelled` — we silently accept that
    // outcome (the wake itself was already delivered; cancel only
    // promises "no future fires", which is honored).
    if (advancement.terminal) {
      this.schedules.markDone(dto.id, actualFireAt);
    } else {
      // advancement.terminal === false guarantees nextFireAt is set
      // (planAdvancement only returns terminal:false with a number).
      this.schedules.markFiredAndRearm(
        dto.id,
        actualFireAt,
        advancement.nextFireAt as number,
      );
    }
  }

  /** Compute what should happen after this fire — terminal `done` vs
   *  pending-with-rearm — plus the next fire time. Pure: no DB writes. */
  private planAdvancement(
    dto: ScheduleDto,
    actualFireAt: number,
  ): Advancement {
    if (dto.spec.kind === 'once') {
      return { terminal: true, nextFireAt: null, missedCount: 0 };
    }
    const newCount = dto.fired_count + 1;
    if (dto.max_occurrences !== null && newCount >= dto.max_occurrences) {
      return {
        terminal: true,
        nextFireAt: null,
        missedCount: this.estimateMissedCount(dto, actualFireAt),
      };
    }
    let nextFireAt: number;
    if (dto.spec.kind === 'interval') {
      nextFireAt = this.computeIntervalNext(
        dto.spec.every_seconds,
        actualFireAt,
      );
    } else {
      nextFireAt = this.computeCronNext(
        dto.spec.expression,
        dto.spec.timezone,
        actualFireAt,
      );
    }
    if (dto.until_at !== null && nextFireAt > dto.until_at) {
      return {
        terminal: true,
        nextFireAt: null,
        missedCount: this.estimateMissedCount(dto, actualFireAt),
      };
    }
    return {
      terminal: false,
      nextFireAt,
      missedCount: this.estimateMissedCount(dto, actualFireAt),
    };
  }

  /**
   * How many planned occurrences we skipped while late, NOT counting
   * the current catch-up fire. For interval this is exact; for cron it
   * counts via the parser; for `once` it's always 0 (a missed one-shot
   * is just "late", not "missed multiple"). This is a hint for the
   * agent and bounded to keep cron iteration cheap.
   */
  private estimateMissedCount(
    dto: ScheduleDto,
    actualFireAt: number,
  ): number {
    if (dto.spec.kind === 'once') return 0;
    const delta = actualFireAt - dto.next_fire_at;
    if (delta <= 0) return 0;
    if (dto.spec.kind === 'interval') {
      // floor(delta/every) full intervals elapsed; the current fire
      // covers the original `dto.next_fire_at`, so the EXTRA misses
      // are floor(delta/every).
      const everyMs = dto.spec.every_seconds * 1000;
      return Math.floor(delta / everyMs);
    }
    // cron: iterate occurrences strictly between (next_fire_at, actualFireAt).
    // Hard-cap iterations to avoid runaway when delta is huge.
    try {
      const interval = parseExpression(dto.spec.expression, {
        currentDate: new Date(dto.next_fire_at),
        tz: dto.spec.timezone,
      });
      let count = 0;
      const cap = 1000;
      while (count < cap) {
        const occ = interval.next();
        if (occ.getTime() >= actualFireAt) break;
        count++;
      }
      return count;
    } catch {
      // If the expression somehow stopped parsing between create and
      // fire (shouldn't happen), don't crash the wake.
      return 0;
    }
  }

  private async deliverWake(
    dto: ScheduleDto,
    actualFireAt: number,
    advancement: Advancement,
  ): Promise<void> {
    const home = this.workspaces.getAgentHomeByOwner(dto.owner_agent_id);
    if (!home || !home.dm_channel_id) {
      // Agent_home should exist (we validated at create time and the
      // CASCADE guards owner deletion), but guard anyway.
      throw new Error(
        `owner ${dto.owner_agent_id} has no agent_home dm_channel`,
      );
    }
    const dmChannelId = home.dm_channel_id;
    const body = renderWakeBody(dto, actualFireAt, advancement);
    const msg = this.messages.insertForConversation({
      conversationId: dmChannelId,
      fromKind: 'system',
      content: body,
      metadata: {
        subtype: systemSubtype('schedule_fire'),
        schedule_id: dto.id,
        spec_kind: dto.spec.kind,
        // Pre-rendered human spec label so the renderer can show
        // `cron */5 9-18 * * 1-5` / `interval 60s` / `once` without
        // re-encoding ScheduleSpec shape on the client.
        spec_summary: renderSpecSummary(dto.spec),
        // The user's reminder text (no producer scaffolding). Lets
        // the renderer surface a clean banner body while
        // `message.content` retains the agent-stdin instruction wrap.
        body: dto.message,
        actual_fire_at: actualFireAt,
        planned_fire_at: dto.next_fire_at,
        missed_count: advancement.missedCount,
        next_fire_at: advancement.nextFireAt,
      },
    });
    // Make the wake visible to an already-open agent_home DM before
    // delivery/start. Without this, the row exists and the agent wakes,
    // but the renderer only sees it after a manual refetch.
    this.events.publish(dmChannelId, {
      kind: 'message',
      payload: { message: msg },
    });
    this.events.publishToScope('viewer:local', 'unread_updated', {
      conversation_id: dmChannelId,
    });
    // Order matters: `start()` is required for non-oneShot drivers
    // (claude). If start fails, the inbox row sits unread until some
    // other path starts the agent — which is misleading because the
    // schedule would otherwise look "delivered". Treat both legs as
    // required; `processOne` will markFailed if either throws.
    await this.conversationManager.deliverMessage(
      dmChannelId,
      dto.owner_agent_id,
      msg.id,
    );
    await this.conversationManager.start(dmChannelId, dto.owner_agent_id);
  }

  // ── Validation helpers ────────────────────────────────────────

  private assertOneShotDelay(now: number, fireAt: number): void {
    const deltaMs = fireAt - now;
    if (deltaMs < SCHEDULE_MIN_DELAY_SECONDS * 1000) {
      throw new ScheduleError(
        'fire_at_too_soon',
        `fire_at must be at least ${SCHEDULE_MIN_DELAY_SECONDS}s in the future`,
      );
    }
    if (deltaMs > SCHEDULE_MAX_DELAY_SECONDS * 1000) {
      throw new ScheduleError(
        'fire_at_too_far',
        `fire_at must be at most ${SCHEDULE_MAX_DELAY_SECONDS / 86400} days in the future`,
      );
    }
  }

  private assertRepeatBounded(input: ScheduleCreateInput): void {
    const hasCap =
      input.max_occurrences !== undefined || input.until_at !== undefined;
    if (!hasCap && input.allow_unbounded !== true) {
      throw new ScheduleError(
        'unbounded_repeat_requires_explicit_limit',
        'repeat schedule must set max_occurrences, until_at, or allow_unbounded=true',
      );
    }
  }

  private assertValidTimezone(tz: string): void {
    try {
      // Throws RangeError on invalid IANA name; all-or-nothing test.
      // Intl.DateTimeFormat with timeZone is the standard runtime check
      // (matches what cron-parser internally uses via Luxon).
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      throw new ScheduleError(
        'invalid_timezone',
        `'${tz}' is not a valid IANA timezone`,
      );
    }
  }

  private computeCronNext(
    expression: string,
    timezone: string,
    fromTime: number,
  ): number {
    // Reject 6-field (with seconds) and `@daily`/`@hourly` style
    // aliases up front. cron-parser quietly accepts both, but v1's
    // contract is "5-field UNIX cron, minute granularity". Allowing
    // sub-minute fires would also break the 60s sweep cadence.
    assertFiveFieldCron(expression);
    try {
      const interval = parseExpression(expression, {
        currentDate: new Date(fromTime),
        tz: timezone,
      });
      // .next() returns a CronDate (extends Date); .getTime() = epoch ms.
      const nextDate = interval.next();
      return nextDate.getTime();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ScheduleError(
        'invalid_cron_expression',
        `cron expression '${expression}' is invalid: ${message}`,
      );
    }
  }

  private computeIntervalNext(
    everySeconds: number,
    fromTime: number,
  ): number {
    return fromTime + everySeconds * 1000;
  }

  private expandStatusFilter(
    filter: ScheduleListStatusFilter,
  ): readonly ScheduleStatus[] | null {
    if (filter === 'all') return null;
    if (filter === 'active') return ['pending', 'firing'];
    return [filter];
  }

  private armNearTimer(): void {
    const next = this.schedules.peekNextDue();
    if (next === null) {
      // No pending rows at all — drop any pending near timer.
      if (this.nearTimer) {
        clearTimeout(this.nearTimer);
        this.nearTimer = null;
        this.nearTimerFireAt = null;
      }
      return;
    }
    const now = this.now();
    const delay = Math.max(0, next - now);
    if (delay > NEAR_TIMER_CAP_MS) {
      // Too far out — sweep tick will catch it later.
      if (this.nearTimer) {
        clearTimeout(this.nearTimer);
        this.nearTimer = null;
        this.nearTimerFireAt = null;
      }
      return;
    }
    // Skip re-arm if we already have a timer for this same fire-at;
    // avoids churn when many rows share a `next_fire_at`.
    if (this.nearTimerFireAt === next && this.nearTimer) return;
    if (this.nearTimer) clearTimeout(this.nearTimer);
    this.nearTimerFireAt = next;
    this.nearTimer = setTimeout(() => {
      this.nearTimer = null;
      this.nearTimerFireAt = null;
      void this.tick().catch(err =>
        this.logger.error(
          { err },
          'schedule-service: near-timer tick failed',
        ),
      );
    }, delay);
    // Avoid keeping the test harness alive on the timer alone.
    if (typeof this.nearTimer.unref === 'function') {
      this.nearTimer.unref();
    }
  }
}

/** Pre-render the schedule spec into a single human-readable label
 *  embedded in `schedule_fire` system metadata. Renderers display
 *  it on the wake banner header. */
function renderSpecSummary(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case 'once':
      return 'once';
    case 'interval':
      return `interval ${spec.every_seconds}s`;
    case 'cron':
      return `cron ${spec.expression} (${spec.timezone})`;
  }
}

function renderWakeBody(
  dto: ScheduleDto,
  actualFireAt: number,
  advancement: Advancement,
): string {
  const planned = new Date(dto.next_fire_at).toISOString();
  const relative = formatRelativeAgo(actualFireAt - dto.next_fire_at);
  const lines: string[] = [];
  lines.push(
    `Schedule fired (kind: ${dto.spec.kind}, planned ${planned}, ${relative}):`,
  );
  lines.push(dto.message);
  if (advancement.missedCount > 0) {
    lines.push('');
    lines.push(
      `Missed ${advancement.missedCount} prior occurrence(s) while offline; this is a single catch-up — not a backfill.`,
    );
  }
  // Hint that this schedule will fire again — agent can plan for it.
  if (dto.spec.kind !== 'once' && !advancement.terminal) {
    const occLabel = dto.max_occurrences
      ? `${dto.fired_count + 1}/${dto.max_occurrences}`
      : `${dto.fired_count + 1}/∞`;
    lines.push('');
    lines.push(
      `Next fire at ${new Date(advancement.nextFireAt!).toISOString()} (fired_count: ${occLabel}).`,
    );
  } else if (dto.spec.kind !== 'once' && advancement.terminal) {
    lines.push('');
    lines.push('This was the final fire of the schedule.');
  }
  lines.push('');
  lines.push(
    'This is a self-scheduled task. Decide if action is needed and proceed.',
  );
  lines.push(
    'If nothing to do, reply briefly with "noted, no action" and stop.',
  );
  return lines.join('\n');
}

interface Advancement {
  /** True when this fire ends the schedule (one-shot; or repeat that
   *  hit `max_occurrences` / would cross `until_at`). */
  terminal: boolean;
  /** When the next fire will land. Null for terminal fires. */
  nextFireAt: number | null;
  /** Planned occurrences skipped while late, NOT counting the current
   *  catch-up fire. 0 for on-time fires and one-shots. */
  missedCount: number;
}

/**
 * Reject anything that isn't strict 5-field UNIX cron. cron-parser
 * silently accepts:
 *   - 6-field expressions (`* * * * * *`) — adds a seconds column.
 *   - shorthand aliases (`@daily`, `@hourly`, `@reboot`, …).
 *   - extra whitespace between fields (still 5 logical tokens).
 * v1 contract: agent always sends exactly 5 whitespace-separated
 * tokens, minute granularity. Tighter than what the parser accepts.
 */
function assertFiveFieldCron(expression: string): void {
  const trimmed = expression.trim();
  if (trimmed.startsWith('@')) {
    throw new ScheduleError(
      'invalid_cron_expression',
      `cron alias '${trimmed}' is not supported; use a 5-field expression`,
    );
  }
  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 5) {
    throw new ScheduleError(
      'invalid_cron_expression',
      `cron expression must have exactly 5 fields (got ${tokens.length}); ` +
        `seconds-precision (6 fields) is not supported in v1`,
    );
  }
}

function formatRelativeAgo(deltaMs: number): string {
  // `deltaMs = actualFire - planned`. Positive means we fired late
  // (missed-on-restart or scheduler lag); negative would only happen
  // if the system clock jumped — fall back to a generic phrasing.
  if (deltaMs <= 0) return 'on time';
  const absSec = Math.round(deltaMs / 1000);
  if (absSec < 60) return `fired ${absSec}s late`;
  const min = Math.round(absSec / 60);
  if (min < 60) return `fired ${min}m late`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `fired ${hr}h late`;
  const day = Math.round(hr / 24);
  return `fired ${day}d late`;
}
