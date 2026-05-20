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
  created_at: number;
  updated_at: number;
}

function rowToDto(row: ScheduleRow): ScheduleDto {
  return {
    id: row.id,
    owner_agent_id: row.owner_agent_id,
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface InsertScheduleParams {
  ownerAgentId: string;
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
         (id, owner_agent_id, title, message, spec_json, next_fire_at, status,
          fired_count, last_fired_at, max_occurrences, until_at,
          failure_reason, cancelled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending',
                 0, NULL, ?, ?,
                 NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        params.ownerAgentId,
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
        `SELECT * FROM schedules WHERE id = ?`,
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
      ? `owner_agent_id = ? AND status IN (${placeholders})`
      : `owner_agent_id = ?`;
    const params: (string | number)[] = [ownerAgentId];
    if (statuses) params.push(...statuses);
    params.push(limit);
    const rows = this.db
      .prepare<typeof params, ScheduleRow>(
        `SELECT * FROM schedules
         WHERE ${where}
         ORDER BY next_fire_at ASC, created_at ASC
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
        `SELECT * FROM schedules
         WHERE status = 'pending' AND next_fire_at <= ?
         ORDER BY next_fire_at ASC
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
                updated_at = ?
          WHERE id = ? AND status = 'firing'
          RETURNING id`,
      )
      .all(actualFireAt, now, id);
    return rows.length > 0;
  }

  /** Wake delivery failed (terminal in v1; we don't auto-retry per-fire
   *  to avoid masking real wiring problems with silent loops).
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
