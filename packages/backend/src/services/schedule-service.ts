import { parseExpression } from 'cron-parser';
import {
  SCHEDULE_MAX_ACTIVE_PER_AGENT,
  SCHEDULE_MAX_DELAY_SECONDS,
  SCHEDULE_MIN_DELAY_SECONDS,
  SCHEDULE_MIN_INTERVAL_SECONDS,
  ScheduleDefinitionSchema,
  isWorkspacePlaced,
  type ScheduleDefinition,
  type ScheduleDto,
  type ScheduleListStatusFilter,
  type ScheduleSpec,
  type ScheduleStatus,
  type AgentCapability,
  systemSubtype,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type { AgentRuntimeHost } from '../runtime/agent-runtime-host.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { ConversationReadRepo } from '../repos/conversation-read-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { ScheduleRepo } from '../repos/schedule-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import { publishUnreadUpdatedToConversationViewers } from '../viewer-scope.js';
import type { AttentionBadgeRepo } from '../repos/attention-badge-repo.js';

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
  | 'target_conversation_not_found'
  | 'target_conversation_closed'
  | 'agent_not_in_target_conversation'
  | 'schedule_not_found'
  | 'not_owner'
  | 'not_cancellable'
  | 'capability_denied';

export class ScheduleError extends Error {
  constructor(
    public readonly code: ScheduleErrorCode,
    message: string,
    /** Set only when `code === 'capability_denied'` — the missing
     *  capability bucket, surfaced as a typed field (doc §3.4b). */
    public readonly capability?: AgentCapability,
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

/**
 * Agent-capability gate signature (graded-permissions cut 2). The
 * injected closure binds the real `canAgentUseCapability` so the
 * agent_home exemption + table lookup live in ONE place. Used by `cancel`
 * only: `create`'s `manage_schedules` gate moved to the door, where the
 * destination's PLACEMENT is what decides (#task:2021 P4-4).
 */
export type ScheduleCapabilityChecker = (
  agentId: string,
  workspaceId: string,
  capability: AgentCapability,
) => boolean;

export interface ScheduleServiceOptions {
  schedules: ScheduleRepo;
  workspaces: WorkspaceRepo;
  /** Used to re-validate the resolved wake destination at create time
   *  (existence, not closed, owner still a PARTICIPANT per placement) and again
   *  at fire time. */
  conversations: ConversationRepo;
  /** Authoritative unread read-model for the enriched `unread_updated` frame
   *  (#task:1283). */
  conversationReads: ConversationReadRepo;
  /** Tiered-badge projection, co-emitted with every `unread_updated`
   *  (#task:1870). Injected rather than built from a db handle because this
   *  service is repo-mediated by design and holds none. */
  attentionBadges: AttentionBadgeRepo;
  messages: MessageRepo;
  agents: AgentRepo;
  runtimeHost: AgentRuntimeHost;
  events: ScopeEventBus;
  logger: BackendLogger;
  /**
   * Agent-capability gate (graded-permissions cut 2) — injected so the
   * agent_home exemption + table lookup have a SINGLE source
   * (`canAgentUseCapability`). Evaluated on the resolved schedule's target
   * workspace (cancel) — `manage_schedules`. Create's gate is the door's.
   */
  canUseCapability: ScheduleCapabilityChecker;
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
  private readonly conversations: ConversationRepo;
  private readonly conversationReads: ConversationReadRepo;
  private readonly attentionBadges: AttentionBadgeRepo;
  private readonly messages: MessageRepo;
  private readonly agents: AgentRepo;
  private readonly runtimeHost: AgentRuntimeHost;
  private readonly events: ScopeEventBus;
  private readonly logger: BackendLogger;
  private readonly canUseCapability: ScheduleCapabilityChecker;
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
    this.conversations = opts.conversations;
    this.conversationReads = opts.conversationReads;
    this.attentionBadges = opts.attentionBadges;
    this.messages = opts.messages;
    this.agents = opts.agents;
    this.runtimeHost = opts.runtimeHost;
    this.events = opts.events;
    this.logger = opts.logger;
    this.canUseCapability = opts.canUseCapability;
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
   *
   * `targetConversationId` is the RESOLVED wake destination — the conversation
   * the door's address named (#task:2021 P4-4), not the conversation the call
   * arrived from and not a default. The address grammar, the unknown/unauthorized
   * collapse and `manage_schedules` are the door's (`routes/internal-agent/
   * schedule-routes.ts`); what stays here is what the SERVICE owns: the row must
   * still exist, must not be closed, and the owner must still participate in it.
   *
   * Those three are re-asked rather than trusted because a resolved target is a
   * snapshot, not a capability token — and because they are exactly the facts the
   * fire path will need to be true LATER (`deliverWake` asks the same three).
   *
   * `input` is a {@link ScheduleDefinition}, which is the wire input MINUS its
   * address: the destination is stated exactly once per call, as an id, so there
   * is no second spelling for this method to ignore or contradict.
   *
   * The principle behind the destination itself is unchanged: "the
   * `(conversation, agent)` runtime that posts the result is the one that did the
   * work" — splitting fire-target from execution-target would break the
   * subject-continuity invariant.
   */
  create(
    input: ScheduleDefinition,
    ownerAgentId: string,
    targetConversationId: string,
  ): ScheduleDto {
    const parsed = ScheduleDefinitionSchema.safeParse(input);
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
        `agent ${ownerAgentId} has no agent_home DM channel`,
      );
    }

    // Re-validate the resolved destination. The address is already gone by here;
    // what is checked is the ROW: it must exist, must not be closed, and must
    // still have the owner as a participant. We do NOT also check `archived_at` —
    // archived channels still accept new messages (archive is a soft-list-out
    // flag, not a write barrier); closure (`closed_at`) is the hard "no more
    // messages" predicate.
    const target = this.conversations.get(targetConversationId);
    if (!target) {
      throw new ScheduleError(
        'target_conversation_not_found',
        `target conversation ${targetConversationId} not found`,
      );
    }
    if (target.closed_at !== null) {
      throw new ScheduleError(
        'target_conversation_closed',
        `target conversation ${targetConversationId} is closed`,
      );
    }
    // PARTICIPATION per placement, through the one authority — not a
    // `conversation_agents` lookup. A roster row is inert on a `direct_pair` and
    // absent on an `agent_inbox` (§4.2), so the old roster gate refused every
    // placement outside a workspace channel: a DM was unschedulable for a reason
    // that had nothing to do with authority. Reaching this arm now needs a race
    // (the door already resolved participation microseconds ago), which is
    // precisely why it stays: the window between resolve and insert is real.
    if (!this.conversations.isAgentParticipant(targetConversationId, ownerAgentId)) {
      throw new ScheduleError(
        'agent_not_in_target_conversation',
        `agent ${ownerAgentId} is not a participant of target conversation ${targetConversationId}`,
      );
    }

    // NO capability gate here. `manage_schedules` is judged at the DOOR, against
    // the destination's PLACEMENT (`requireAgentConversationCapability`), because
    // a capability is a grant inside a workspace and two of the three placements
    // have no workspace at all: a `direct_pair`'s endpoints are its authority and
    // an inbox's single participant is its own. The previous version read
    // `target.workspace_id` directly and refused a null one as "no grant can
    // exist here", which was defensible only while the roster gate above made
    // every workspace-less placement unreachable anyway. It no longer does, and
    // one rule for placement authority beats two that must agree.
    //
    // `cancel` still asks `canUseCapability` itself — it resolves its target from
    // a stored schedule rather than from an address, and it deliberately treats a
    // workspace-less target as cancellable (see the comment there).

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
      targetConversationId,
      title: data.title,
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
    // Capability gate (graded-permissions cut 2): `manage_schedules` on
    // the schedule's target conversation's workspace — the same axis the
    // create call was gated on. If the target conversation has since been
    // deleted the schedule is dangling; the owner-match above is the only
    // guard and we let the owner clean it up.
    //
    // A target with NO workspace is handled the same way as the deleted one, and
    // deliberately NOT like the create path's refusal: cancel is the OWNER's
    // cleanup verb, so a scope in which no `manage_schedules` grant can exist
    // must not be able to strand the owner's own schedule. Withholding creation
    // and withholding deletion are not the same conservative choice.
    const target = this.conversations.get(existing.target_conversation_id);
    if (
      target &&
      target.workspace_id !== null &&
      !this.canUseCapability(
        ownerAgentId,
        target.workspace_id,
        'manage_schedules',
      )
    ) {
      throw new ScheduleError(
        'capability_denied',
        `agent ${ownerAgentId} lacks manage_schedules in workspace ${target.workspace_id}`,
        'manage_schedules',
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
      // Branch on plan kind. `once` has no future fire to retry — its
      // single attempt is over either way, so it's correctly terminal.
      // `cron|interval` must NOT terminate on a single bad tick (e.g.
      // transient daemon transport detach, target temporarily closed):
      // we record fire-level failure metrics and re-arm to the natural
      // next cadence tick. See ADR / design doc for the "no auto-
      // terminate after N" rationale.
      if (dto.spec.kind === 'once') {
        this.logger.error(
          { scheduleId: dto.id, ownerAgentId: dto.owner_agent_id, err },
          'schedule-service: wake delivery failed; marking failed (once)',
        );
        this.schedules.markFailed(dto.id, reason);
        return;
      }
      const failureRearm = this.planFailureRearm(dto, actualFireAt);
      if (failureRearm.terminal) {
        // Cron/interval whose natural-next-tick would be past `until_at`
        // — the plan window is over and there is no future attempt
        // possible. Treat as natural plan-end (`done`); UI surfaces
        // `consecutive_failure_count > 0` so the operator can tell the
        // tail fires failed.
        this.logger.error(
          { scheduleId: dto.id, ownerAgentId: dto.owner_agent_id, err },
          'schedule-service: wake delivery failed and until_at exhausted; marking done',
        );
        this.schedules.markDone(dto.id, actualFireAt);
        return;
      }
      this.logger.warn(
        {
          scheduleId: dto.id,
          ownerAgentId: dto.owner_agent_id,
          nextFireAt: failureRearm.nextFireAt,
          err,
        },
        'schedule-service: wake delivery failed; re-arming for next cadence tick',
      );
      this.schedules.markFireFailed(
        dto.id,
        reason,
        failureRearm.nextFireAt,
      );
      this.armNearTimer();
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
   * Compute the next-fire transition for a `cron|interval` schedule
   * whose current fire FAILED. Mirrors `planAdvancement` for the success
   * path, with two differences:
   *
   *   - `max_occurrences` is intentionally NOT consulted. The failed
   *     fire didn't increment `fired_count`, so the plan still owes
   *     that occurrence; we should retry on the natural next cadence
   *     tick rather than terminate. (If the next successful fire then
   *     hits `max_occurrences`, `planAdvancement` will route through
   *     `markDone` as usual.)
   *   - `until_at` IS consulted. It's a wall-clock deadline; once past,
   *     no future tick is possible regardless of failure history, so
   *     the schedule terminates as `done` (UI surfaces
   *     `consecutive_failure_count > 0` to indicate the tail fires
   *     never landed).
   *
   * Returns `terminal:false` with the natural next fire-at for the
   * caller to pass into `markFireFailed`. The caller never invokes
   * this for `kind:'once'` (those terminate via `markFailed`); the
   * branch is asserted with an Error rather than silently returning a
   * default.
   */
  private planFailureRearm(
    dto: ScheduleDto,
    actualFireAt: number,
  ): { terminal: true; nextFireAt: null } | { terminal: false; nextFireAt: number } {
    if (dto.spec.kind === 'once') {
      throw new Error(
        'planFailureRearm: caller must route kind:once through markFailed, not here',
      );
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
      return { terminal: true, nextFireAt: null };
    }
    return { terminal: false, nextFireAt };
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
    // Resolve the execution target. Validated at create time but
    // checked again here because conversations can be closed/removed
    // between create and fire — when that happens the schedule must
    // fail loudly (not silently fall back to agent_home), and the
    // owner needs an out-of-band signal so they don't keep waiting
    // for a wake that will never land.
    //
    // The third check is PARTICIPATION per placement, the same authority create
    // used, and it has to be: a schedule may target a DM pair, whose participants
    // are its endpoint columns and never a roster row (§4.2). A
    // `conversation_agents` lookup here would let every DM-targeted schedule fire
    // exactly zero times and report "owner not member" about a conversation the
    // owner is half of.
    const targetConvId = dto.target_conversation_id;
    const target = this.conversations.get(targetConvId);
    if (!target) {
      this.notifyOwnerOfDeadTarget(dto, 'missing');
      throw new Error(
        `target_conversation_unavailable: ${targetConvId} (missing)`,
      );
    }
    if (target.closed_at !== null) {
      this.notifyOwnerOfDeadTarget(dto, 'closed');
      throw new Error(
        `target_conversation_unavailable: ${targetConvId} (closed)`,
      );
    }
    if (!this.conversations.isAgentParticipant(targetConvId, dto.owner_agent_id)) {
      this.notifyOwnerOfDeadTarget(dto, 'not_member');
      throw new Error(
        `target_conversation_unavailable: ${targetConvId} (owner not participant)`,
      );
    }

    const body = renderWakeBody(dto, actualFireAt, advancement);
    const msg = this.messages.insertForConversation({
      conversationId: targetConvId,
      fromKind: 'system',
      content: body,
      // Out of the freshness universe (design doc §5.2): a schedule fire
      // is the owner's self-wake, not channel discourse — it is delivered
      // ONLY to the owner below, so bumping the stream head would leave
      // every other agent member CAS-blocked on a row that never arrives
      // (a signal-only 409 deadlock). Fan-out to all members instead
      // would wake every agent per fire — a product regression.
      freshnessExempt: true,
      metadata: {
        subtype: systemSubtype('schedule_fire'),
        schedule_id: dto.id,
        title: dto.title,
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
    // Make the wake visible to an already-open viewer of the target
    // conversation before delivery/start. Without this, the row exists
    // and the agent wakes, but the renderer only sees it after a manual
    // refetch.
    this.events.publish(targetConvId, {
      kind: 'message',
      payload: { message: msg },
    });
    // WORKSPACE PLACEMENTS ONLY, branched HERE rather than inside the publisher
    // (#task:2021 P4-4, same split as `conversation-message/delivery.ts`). The
    // unread read model is keyed by workspace, so it has no coordinate for a
    // workspace-less placement and the publisher says so by throwing. Since P4-4
    // the wake destination is whatever the address named — a `direct_pair` is now
    // reachable here — and an unguarded call would turn every DM-targeted fire
    // into `status='failed'` with a placement error as its `failure_reason`:
    // schedules that create cleanly and then fire exactly zero times.
    //
    // What is skipped is real and named: a pair with a human endpoint has a human
    // who ought to see this wake as unread, and giving them one needs an unread
    // coordinate that is not workspace-keyed — the DM read surface, a separate
    // slice. The renderer's live path is unaffected: the `message` event above is
    // published for every placement. Pinned by test, not logged — it happens on
    // every DM fire, so a log line would be pure volume.
    if (isWorkspacePlaced(target)) {
      publishUnreadUpdatedToConversationViewers(
        this.events,
        this.attentionBadges,
        this.conversations,
        this.conversationReads,
        targetConvId,
      );
    }
    // Order matters: `start()` is required for non-oneShot drivers
    // (claude). If start fails, the inbox row sits unread until some
    // other path starts the agent — which is misleading because the
    // schedule would otherwise look "delivered". Treat both legs as
    // required; `processOne` will markFailed if either throws.
    await this.runtimeHost.deliverMessage(
      targetConvId,
      dto.owner_agent_id,
      msg.id,
    );
    await this.runtimeHost.start(targetConvId, dto.owner_agent_id);
  }

  /** Best-effort lifecycle notice when the schedule's target conversation
   *  has become unreachable (deleted, closed, or owner removed) between
   *  create and fire. Posts a plain system message into the owner's
   *  agent_home DM so the operator finds out without staring at the
   *  silent target. Failure here must not mask the underlying wake
   *  failure — we swallow throws and rely on the wake's own log line.
   *
   *  This is deliberately a generic system message (no new typed
   *  metadata subtype) — v1 has one operator and the human-readable
   *  body is enough; if the failure mode becomes common we can graduate
   *  it to a `schedule_failed` subtype later. */
  private notifyOwnerOfDeadTarget(
    dto: ScheduleDto,
    reason: 'missing' | 'closed' | 'not_member',
  ): void {
    try {
      const home = this.workspaces.getAgentHomeByOwner(dto.owner_agent_id);
      if (!home || !home.dm_channel_id) return;
      const reasonText =
        reason === 'missing'
          ? 'no longer exists'
          : reason === 'closed'
          ? 'has been closed'
          : 'no longer has you as a participant';
      const content =
        `Schedule "${dto.title || dto.id}" could not fire: target ` +
        `conversation ${dto.target_conversation_id} ${reasonText}. ` +
        `Marking the schedule as failed; create a new one with a valid ` +
        `target if you still need it.`;
      const msg = this.messages.insertForConversation({
        conversationId: home.dm_channel_id,
        fromKind: 'system',
        content,
      });
      // Universe alignment (§5.2): this row bumps the DM's stream head, so
      // the owner agent must have a normal delivery to advance past it —
      // without one, its next DM send would 409 forever under the
      // signal-only contract. Best-effort like the rest of this notice.
      void this.runtimeHost
        .deliverMessage(home.dm_channel_id, dto.owner_agent_id, msg.id)
        .catch(err => {
          this.logger.warn(
            { scheduleId: dto.id, err },
            'schedule-service: target-dead notice delivery failed; row stays pending',
          );
        });
      this.events.publish(home.dm_channel_id, {
        kind: 'message',
        payload: { message: msg },
      });
      publishUnreadUpdatedToConversationViewers(
        this.events,
        this.attentionBadges,
        this.conversations,
        this.conversationReads,
        home.dm_channel_id,
      );
    } catch (err) {
      this.logger.warn(
        { scheduleId: dto.id, err },
        'schedule-service: failed to post target-dead notice; continuing',
      );
    }
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

  private assertRepeatBounded(input: ScheduleDefinition): void {
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
