import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
  ScheduleSpecSchema,
  type ScheduleDto,
  type ScheduleSpec,
  type ScheduleStatus,
} from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

interface ScheduleRow {
  id: string;
  owner_agent_id: string;
  target_conversation_id: string;
  title: string;
  message: string;
  spec_json: string;
  next_fire_at: number;
  status: ScheduleStatus;
  fired_count: number;
  last_fired_at: number | null;
  max_occurrences: number | null;
  until_at: number | null;
  failure_reason: string | null;
  cancelled_at: number | null;
  // v39 fire-failure metrics; see ScheduleDtoSchema for semantics.
  last_failure_reason: string | null;
  last_failure_at: number | null;
  consecutive_failure_count: number;
  created_at: number;
  updated_at: number;
  // Projected by every SELECT via LEFT JOIN; null when the target row
  // no longer exists (orphan) — formatted as 'Unavailable conversation'.
  target_title: string | null;
  target_kind: 'channel' | 'dm_channel' | 'thread' | null;
  target_parent_title: string | null;
}

/**
 * Common SELECT fragment that joins conversations + their parents so
 * `rowToDto` can project `target_label`. Centralised so every read site
 * (agent list, scheduler tick, get-by-id) sees the same projection
 * shape and the label is computed once.
 *
 * Permission note: this projection is intentionally label-only — title
 * and kind, no workspace path / member / parent ids beyond what the
 * label needs. The schedule list endpoint already authorises by agent
 * ownership; per the "follow schedule permission" boundary, the label
 * is part of the schedule's own description (where it fires), not a
 * leaked target-conversation metadata projection.
 */
const SCHEDULE_SELECT_WITH_TARGET = `
  SELECT s.*,
         tc.title           AS target_title,
         tc.kind            AS target_kind,
         tp.title           AS target_parent_title
    FROM schedules s
    LEFT JOIN conversations tc ON tc.id = s.target_conversation_id
    LEFT JOIN conversations tp ON tp.id = tc.parent_conversation_id
`;

function buildTargetLabel(row: ScheduleRow): string {
  if (row.target_title === null || row.target_kind === null) {
    return 'Unavailable conversation';
  }
  if (row.target_kind === 'thread') {
    const parent = row.target_parent_title?.trim();
    return parent ? `#${parent}:${row.target_title}` : row.target_title;
  }
  if (row.target_kind === 'dm_channel') {
    return `@${row.target_title}`;
  }
  return `#${row.target_title}`;
}

function rowToDto(row: ScheduleRow): ScheduleDto {
  return {
    id: row.id,
    owner_agent_id: row.owner_agent_id,
    target_conversation_id: row.target_conversation_id,
    target_label: buildTargetLabel(row),
    title: row.title,
    message: row.message,
    spec: ScheduleSpecSchema.parse(JSON.parse(row.spec_json)),
    next_fire_at: row.next_fire_at,
    status: row.status,
    fired_count: row.fired_count,
    last_fired_at: row.last_fired_at,
    max_occurrences: row.max_occurrences,
    until_at: row.until_at,
    failure_reason: row.failure_reason,
    cancelled_at: row.cancelled_at,
    last_failure_reason: row.last_failure_reason,
    last_failure_at: row.last_failure_at,
    consecutive_failure_count: row.consecutive_failure_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface InsertScheduleParams {
  ownerAgentId: string;
  /** Required. Resolved by the service from input or defaulted to the
   *  calling conversation. The repo never derives a target itself —
   *  validation lives in the service so unrelated tests can construct
   *  schedules with arbitrary targets. */
  targetConversationId: string;
  title: string;
  message: string;
  spec: ScheduleSpec;
  nextFireAt: number;
  maxOccurrences?: number | null;
  untilAt?: number | null;
}

export class ScheduleRepo {
  constructor(private readonly db: Db) {}

  insert(params: InsertScheduleParams): ScheduleDto {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO schedules
         (id, owner_agent_id, target_conversation_id, title, message, spec_json, next_fire_at, status,
          fired_count, last_fired_at, max_occurrences, until_at,
          failure_reason, cancelled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending',
                 0, NULL, ?, ?,
                 NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        params.ownerAgentId,
        params.targetConversationId,
        params.title,
        params.message,
        JSON.stringify(params.spec),
        params.nextFireAt,
        params.maxOccurrences ?? null,
        params.untilAt ?? null,
        now,
        now,
      );
    const dto = this.get(id);
    if (!dto) throw new Error(`schedule ${id} vanished after insert`);
    return dto;
  }

  get(id: string): ScheduleDto | null {
    const row = this.db
      .prepare<[string], ScheduleRow>(
        `${SCHEDULE_SELECT_WITH_TARGET} WHERE s.id = ?`,
      )
      .get(id);
    return row ? rowToDto(row) : null;
  }

  /** Snapshot of every row matching the given filters, ordered by
   *  `next_fire_at ASC` then `created_at ASC` so the agent sees the
   *  most-imminent items first. */
  listForAgent(
    ownerAgentId: string,
    statuses: readonly ScheduleStatus[] | null,
    limit = 100,
  ): ScheduleDto[] {
    if (statuses && statuses.length === 0) return [];
    const placeholders = statuses
      ? statuses.map(() => '?').join(',')
      : null;
    const where = placeholders
      ? `s.owner_agent_id = ? AND s.status IN (${placeholders})`
      : `s.owner_agent_id = ?`;
    const params: (string | number)[] = [ownerAgentId];
    if (statuses) params.push(...statuses);
    params.push(limit);
    const rows = this.db
      .prepare<typeof params, ScheduleRow>(
        `${SCHEDULE_SELECT_WITH_TARGET}
         WHERE ${where}
         ORDER BY s.next_fire_at ASC, s.created_at ASC
         LIMIT ?`,
      )
      .all(...params);
    return rows.map(rowToDto);
  }

  /** Number of rows for the agent currently in `pending` or `firing`.
   *  Used to enforce the per-agent active quota. */
  countActive(ownerAgentId: string): number {
    const row = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM schedules
         WHERE owner_agent_id = ? AND status IN ('pending','firing')`,
      )
      .get(ownerAgentId);
    return row?.c ?? 0;
  }

  /** Returns rows whose `next_fire_at` is at or before `now` and which
   *  are still `pending`. The scheduler iterates this list and tries to
   *  CAS each into `firing`. */
  listDuePending(now: number, limit = 100): ScheduleDto[] {
    const rows = this.db
      .prepare<[number, number], ScheduleRow>(
        `${SCHEDULE_SELECT_WITH_TARGET}
         WHERE s.status = 'pending' AND s.next_fire_at <= ?
         ORDER BY s.next_fire_at ASC
         LIMIT ?`,
      )
      .all(now, limit);
    return rows.map(rowToDto);
  }

  /** Returns the next pending schedule's `next_fire_at` (or null when
   *  none exist) so the scheduler can arm a short-window setTimeout
   *  for low-latency wake. */
  peekNextDue(): number | null {
    const row = this.db
      .prepare<[], { next_fire_at: number }>(
        `SELECT next_fire_at FROM schedules
         WHERE status = 'pending'
         ORDER BY next_fire_at ASC
         LIMIT 1`,
      )
      .get();
    return row?.next_fire_at ?? null;
  }

  /**
   * Atomically claim a `pending` row by transitioning it to `firing`.
   * Returns `true` only when this caller won the race. CAS is enforced
   * by the `WHERE status='pending'` predicate combined with `RETURNING`
   * — concurrent ticks (dev hot-reload double scheduler, or future
   * multi-instance) all converge on at most one winner per row.
   */
  tryClaim(id: string): boolean {
    const now = Date.now();
    const rows = this.db
      .prepare<[number, string], { id: string }>(
        `UPDATE schedules
            SET status = 'firing', updated_at = ?
          WHERE id = ? AND status = 'pending'
          RETURNING id`,
      )
      .all(now, id);
    return rows.length > 0;
  }

  /**
   * Repeat fire success: bump fired_count, advance next_fire_at, drop
   * back to `pending`. Caller has computed next_fire_at strictly from
   * `actual_fire_at` (NOT from old `next_fire_at`) so missed-on-restart
   * does not backfill.
   *
   * Predicated on `status='firing'` so a concurrent `cancel()` that
   * raced in after our CAS-claim wins: the cancel transitions
   * `firing → cancelled`, and this update finds nothing to change.
   * Returns `true` when we successfully re-armed; `false` when cancel
   * (or some other terminal write) won the race and the caller should
   * not treat the fire as on-track.
   */
  markFiredAndRearm(
    id: string,
    actualFireAt: number,
    nextFireAt: number,
  ): boolean {
    const now = Date.now();
    const rows = this.db
      .prepare<[number, number, number, string], { id: string }>(
        `UPDATE schedules
            SET status = 'pending',
                fired_count = fired_count + 1,
                last_fired_at = ?,
                next_fire_at = ?,
                consecutive_failure_count = 0,
                updated_at = ?
          WHERE id = ? AND status = 'firing'
          RETURNING id`,
      )
      .all(actualFireAt, nextFireAt, now, id);
    return rows.length > 0;
  }

  /** Terminal one-shot fire OR repeat that hit max_occurrences/until_at.
   *  Status becomes `done`; no further ticks act on this row.
   *  Predicated on `status='firing'` (see markFiredAndRearm rationale). */
  markDone(id: string, actualFireAt: number): boolean {
    const now = Date.now();
    const rows = this.db
      .prepare<[number, number, string], { id: string }>(
        `UPDATE schedules
            SET status = 'done',
                fired_count = fired_count + 1,
                last_fired_at = ?,
                consecutive_failure_count = 0,
                updated_at = ?
          WHERE id = ? AND status = 'firing'
          RETURNING id`,
      )
      .all(actualFireAt, now, id);
    return rows.length > 0;
  }

  /** Wake delivery failed for a `kind:'once'` schedule (terminal — the
   *  plan only had one fire to attempt; there is no future tick that
   *  could retry).
   *
   *  For `cron|interval`, callers MUST use `markFireFailed` instead so
   *  the schedule stays on its natural cadence. Routing transient
   *  fire-time failures (daemon transport detached, target temporarily
   *  closed, etc.) into terminal `failed` would silently kill long-
   *  running plans on a single bad tick.
   *
   *  Predicated on `status='firing'`: if a cancel raced and won, the
   *  schedule is already in `cancelled`; we don't overwrite it. */
  markFailed(id: string, reason: string): boolean {
    const now = Date.now();
    const rows = this.db
      .prepare<[string, number, string], { id: string }>(
        `UPDATE schedules
            SET status = 'failed',
                failure_reason = ?,
                updated_at = ?
          WHERE id = ? AND status = 'firing'
          RETURNING id`,
      )
      .all(reason, now, id);
    return rows.length > 0;
  }

  /**
   * Wake delivery failed for a `cron|interval` schedule. Records the
   * fire-level failure (`last_failure_*`, `consecutive_failure_count++`)
   * but keeps the plan alive: `status` returns to `pending` and
   * `next_fire_at` advances to the natural next cadence tick (caller
   * computes via spec — see `ScheduleService.planFailureRearm`).
   *
   * `consecutive_failure_count` resets to 0 on the next successful fire
   * (`markFiredAndRearm` / `markDone`); UI/observability layers read it
   * to surface stuck schedules without auto-terminating them. The
   * design rationale, including the rejected "auto-terminate after N"
   * branch, lives at `docs/architecture-principles.md` (or the design
   * doc that ships with this PR).
   *
   * Predicated on `status='firing'`: a concurrent cancel still wins.
   * Returns `true` when the row transitioned, `false` when a racing
   * terminal write got there first.
   */
  markFireFailed(id: string, reason: string, nextFireAt: number): boolean {
    const now = Date.now();
    const rows = this.db
      .prepare<[string, number, number, number, string], { id: string }>(
        `UPDATE schedules
            SET status = 'pending',
                last_failure_reason = ?,
                last_failure_at = ?,
                consecutive_failure_count = consecutive_failure_count + 1,
                next_fire_at = ?,
                updated_at = ?
          WHERE id = ? AND status = 'firing'
          RETURNING id`,
      )
      .all(reason, now, nextFireAt, now, id);
    return rows.length > 0;
  }

  /** Agent-initiated cancel. Only legal from `pending` or `firing` —
   *  caller validates and returns `not_cancellable` otherwise. */
  cancel(id: string): boolean {
    const now = Date.now();
    const rows = this.db
      .prepare<[number, number, string], { id: string }>(
        `UPDATE schedules
            SET status = 'cancelled',
                cancelled_at = ?,
                updated_at = ?
          WHERE id = ? AND status IN ('pending','firing')
          RETURNING id`,
      )
      .all(now, now, id);
    return rows.length > 0;
  }

  /**
   * Crash recovery: any row left in `firing` from a prior process
   * lifetime is reset to `pending` so the next scheduler tick will
   * re-claim and fire it. Returns the number of rows reset.
   */
  resetStaleFiring(): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE schedules
            SET status = 'pending', updated_at = ?
          WHERE status = 'firing'`,
      )
      .run(now);
    return result.changes;
  }
}
