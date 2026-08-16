import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
  apiPaths,
  principalAvatarUrl,
  type AgentDto,
  type AgentRow,
  type AgentRuntimeParticipation,
  type ConversationPlacementKind,
  type ConversationRosterPolicy,
  type CreateAgentInput,
  type RuntimeKind,
  type SwitchAgentRuntimeInput,
  type UpdateAgentInput,
  type WorkspaceKind,
} from '@silverhand/shared';
import { agentParticipates } from './conversation-placement-sql.js';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

export function agentRowToDto(row: AgentRow): AgentDto {
  // SQLite stores booleans as 0/1; coerce back to boolean | null.
  const fast = row.fast_mode as unknown as number | boolean | null;
  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    runtime: row.runtime,
    model: row.model,
    reasoning_effort: row.reasoning_effort,
    fast_mode:
      fast === null || fast === undefined ? null : Boolean(fast),
    host_id: row.host_id,
    description: row.description,
    session_scope: row.session_scope,
    created_by_user_id: row.created_by_user_id,
    // Mirror UserDto: present when the row has an avatar blob set;
    // cache-busted via `updated_at` so the renderer's HTTP cache
    // refreshes whenever AgentService.uploadAvatar / clearAvatar runs
    // (both bump updated_at via `setAvatar`/`clearAvatar`).
    avatar_url: principalAvatarUrl(
      apiPaths.agentAvatar(row.id),
      row.avatar_storage_key,
      row.updated_at,
    ),
    // v33 (D4.d): materialization lifecycle. `idempotency_key` is
    // intentionally NOT projected — retry uses a route-local
    // management payload, not the default DTO (Cindy D1 round-2 P2).
    materialization_status: row.materialization_status,
    materialization_failed_code: row.materialization_failed_code,
    materialization_failed_at: row.materialization_failed_at,
    deletion_started_at: row.deletion_started_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToDto(row: AgentRow): AgentDto {
  return agentRowToDto(row);
}

export class AgentRepo {
  constructor(private readonly db: Db) {}

  list(): AgentDto[] {
    const rows = this.db
      .prepare<[], AgentRow>('SELECT * FROM agents ORDER BY created_at ASC')
      .all();
    return rows.map(rowToDto);
  }

  /**
   * v36 (#task:808) — host-scoped registration view used by
   * `GET /api/hosts/:id/status` to render the agents bound to a host
   * (NOT a process list — that's `runtime_status`). Cross-user / ACL
   * checks live at the route layer; this method only joins on
   * `host_id`. Ordering matches the global list so the renderer's
   * row-key stability matches between contexts.
   */
  listByHost(hostId: string): AgentDto[] {
    const rows = this.db
      .prepare<[string], AgentRow>(
        'SELECT * FROM agents WHERE host_id = ? ORDER BY created_at ASC',
      )
      .all(hostId);
    return rows.map(rowToDto);
  }

  get(id: string): AgentDto | null {
    const row = this.db
      .prepare<[string], AgentRow>('SELECT * FROM agents WHERE id = ?')
      .get(id);
    return row ? rowToDto(row) : null;
  }

  getByName(name: string): AgentDto | null {
    const row = this.db
      .prepare<[string], AgentRow>('SELECT * FROM agents WHERE name = ?')
      .get(name);
    return row ? rowToDto(row) : null;
  }

  /**
   * FIXTURE-ONLY row factory: inserts an `active` `agents` row and NOTHING else.
   *
   * It has no production caller and must not gain one — production creates an
   * Agent through `AgentProvisioningPersistence.reserveAgentAggregate`, which
   * pairs {@link AgentRepo.reserveForMaterialize} with the agent's inbox
   * placement in one transaction (v71 §4.2). A row written here is missing that
   * inbox, so a mention of its handle would throw `AgentInboxMissingError`
   * INSIDE the sender's message transaction. Tests that exercise a CC / inbox
   * read face therefore insert the inbox explicitly; tests that do not, do not
   * care. `tests/guard-agent-create-fixture-only.test.ts` pins the no-production-
   * caller half of that rule.
   */
  create(
    input: CreateAgentInput,
    defaultHostId: string,
    createdByUserId: string,
  ): AgentDto {
    const id = newId();
    const now = Date.now();
    // display_name defaults to the handle so the UI doesn't have to
    // collect both at create time. Users edit display_name later via
    // the agent profile page.
    //
    // `created_by_user_id` is required (NOT NULL since v26). Callers
    // must thread the creator's user id from their auth principal —
    // routes pass `getUserPrincipal(c).userId`; tests pass an explicit
    // fixture user id. The cross-namespace name-collision trigger
    // (v21) and FK to `users(id)` (v26) both fire here on bad input.
    this.db
      .prepare(
        `INSERT INTO agents
         (id, name, display_name, runtime, model, reasoning_effort, fast_mode,
          host_id, description, session_scope, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.name,
        input.runtime,
        input.model ?? null,
        input.reasoning_effort ?? null,
        input.fast_mode === undefined ? null : input.fast_mode ? 1 : 0,
        input.host_id ?? defaultHostId,
        input.description ?? null,
        input.session_scope ?? 'conversation',
        createdByUserId,
        now,
        now,
      );
    const row = this.get(id);
    if (!row) throw new Error('insert failed');
    return row;
  }

  // ── D4.d D3: materialization lifecycle methods ──────────────────
  //
  // §6.1 + §6.3 give the route 4 mutations on `agents` it must
  // own through the materialize lifecycle:
  //
  //   1. Lookup by `(created_by_user_id, idempotency_key)` to
  //      decide short-circuit / mismatch / fresh attempt.
  //   2. Reserve a `pending_materialization` row with metadata
  //      snapshot before dispatching the wire intent (L1).
  //   3. Flip the reserved row to `active` after daemon ack +
  //      dependent-row inserts succeed (L3a).
  //   4. Flip the reserved row to `failed` with a typed code
  //      after daemon typed err / timeout / dependent-row insert
  //      failure (L3b).
  //
  // Idempotency-Key is per-creator scoped — the v33 partial
  // unique index is `(created_by_user_id, idempotency_key)
  // WHERE idempotency_key IS NOT NULL`. Cross-user existence side
  // channel is impossible at the SQL layer (Cindy round-2 P1 #5).
  //
  // The flip helpers do NOT return the projected DTO — they're
  // mutation-only. Routes call `getRow` after flip when they need
  // the projection (e.g. for the 201 response payload).

  /**
   * Lookup an agent row by `(created_by_user_id, idempotency_key)`.
   * Returns `null` if no such row exists — that's the fresh-attempt
   * path. Returns the row (in ANY status: pending, active, failed)
   * if one exists — that's the short-circuit path the route then
   * dispatches based on `materialization_status`.
   *
   * Note: this returns `AgentRow` (with `idempotency_key` field)
   * NOT `AgentDto` (which deliberately drops it per Cindy D1
   * round-2 P2). The mismatch check needs the metadata snapshot
   * fields, which the DTO carries, but the route also needs to
   * confirm key match — so giving it the full row is cleaner.
   */
  findByIdempotencyKey(
    createdByUserId: string,
    idempotencyKey: string,
  ): AgentRow | null {
    const row = this.db
      .prepare<[string, string], AgentRow>(
        `SELECT * FROM agents
           WHERE created_by_user_id = ?
             AND idempotency_key = ?`,
      )
      .get(createdByUserId, idempotencyKey);
    return row ?? null;
  }

  /**
   * Insert a fresh agent row in `pending_materialization` state
   * with the supplied `idempotency_key` captured into the row
   * (the unique index enforces per-creator uniqueness — caller
   * must have called `findByIdempotencyKey` first and ensured
   * the slot is free).
   *
   * Returns the new row's `AgentRow` (with all v33 fields). The
   * route's L1 phase calls this BEFORE dispatching the wire intent,
   * so the resulting row carries everything the L2 dispatch needs:
   * `id` (= `agent_id` in the wire arm), `host_id` (= placement
   * resolution), `name` / `runtime` / `model` / `description` /
   * `idempotency_key` (the metadata snapshot the L0 mismatch check
   * compares against on later retries).
   *
   * The v33 column `materialization_status` defaults to `'active'`
   * for backfill rows; we explicitly set it to
   * `'pending_materialization'` here so the new lifecycle is
   * observable from the moment the row exists.
   *
   * NOT the aggregate factory (v71 §4.2): this writes the BARE row. An Agent is
   * the row PLUS its inbox placement, and only
   * `AgentProvisioningPersistence.reserveAgentAggregate` writes both in one
   * transaction. Reserve is where that pairing belongs rather than the L3a
   * dependent graph, because the handle is addressable from this INSERT onward —
   * `getByName` has no `materialization_status` filter — so a `failed` row still
   * owes a mention a destination, and a `?retry=true` that re-entered L3a on the
   * same row would collide with the inbox its first attempt already committed.
   */
  reserveForMaterialize(
    input: CreateAgentInput,
    defaultHostId: string,
    createdByUserId: string,
    idempotencyKey: string,
  ): AgentRow {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO agents
         (id, name, display_name, runtime, model, reasoning_effort, fast_mode,
          host_id, description, session_scope, created_by_user_id,
          materialization_status, idempotency_key,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 'pending_materialization', ?,
                 ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.name,
        input.runtime,
        input.model ?? null,
        input.reasoning_effort ?? null,
        input.fast_mode === undefined ? null : input.fast_mode ? 1 : 0,
        input.host_id ?? defaultHostId,
        input.description ?? null,
        input.session_scope ?? 'conversation',
        createdByUserId,
        idempotencyKey,
        now,
        now,
      );
    const row = this.getRow(id);
    if (!row) throw new Error('reserve insert failed');
    return row;
  }

  /**
   * Flip a `pending_materialization` row to `'active'`. Called by the
   * create-agent L3a tx after the daemon ack arrives ok AND all
   * dependent rows have been inserted in the same tx.
   *
   * The ONLY legal pre-state is `pending_materialization`. `active` is
   * deliberately NOT matched: a row that is already active already has its
   * dependent graph, and matching it here would let a second provisioning run
   * build a SECOND graph (a second DM channel, a second onboarding message).
   * `failed` is not matched either — a failed row must never be activated
   * in-place (`?retry=true` goes through the reserve path again).
   *
   * Returns the number of rows the conditional UPDATE matched: 1 when the
   * transition succeeded, 0 when the row is not `pending_materialization`
   * (failed / active / vanished — eligibility lost to a concurrent transition).
   * The caller MUST fail closed on 0 — a row that lost eligibility must never
   * get a dependent graph built under it. This is the saga's single-winner
   * mechanism — see `application/agent-provisioning-ports.ts`.
   */
  flipToActive(id: string): number {
    return this.db
      .prepare(
        `UPDATE agents
            SET materialization_status = 'active',
                materialization_failed_code = NULL,
                materialization_failed_at   = NULL,
                updated_at = ?
          WHERE id = ?
            AND materialization_status = 'pending_materialization'`,
      )
      .run(Date.now(), id).changes;
  }

  /**
   * Flip a `pending_materialization` row to `'failed'` with a
   * typed failure code + the failure timestamp. Called by the
   * route's L3b path on:
   *
   *   - daemon ack typed err (`agent_dir_collision`,
   *     `fs_quota_exceeded`, `fs_unavailable`, `unsupported_template`,
   *     `unsupported_runtime`, `internal_error`)
   *   - daemon ack timeout (`materialize_timeout`)
   *   - L3a tx failure (`dependent_row_insert_failed`)
   *   - daemon ack `agent_dir !== agent_home_workspace_path` skew
   *     (`daemon_internal_error`, §6.5)
   *
   * AND by the D4 boot reconciler with code
   * `backend_crash_during_materialize` for stale pending rows.
   *
   * Refuses to flip from `'active'` — once a row is active, the
   * failure surface is via destructive DELETE, not in-place flip
   * (Cindy round-1 P1 #2: active-row destructive flow is unchanged).
   */
  flipToFailed(id: string, failedCode: string, failedAt: number): void {
    this.db
      .prepare(
        `UPDATE agents
            SET materialization_status      = 'failed',
                materialization_failed_code = ?,
                materialization_failed_at   = ?,
                updated_at = ?
          WHERE id = ?
            AND materialization_status IN ('pending_materialization', 'failed')`,
      )
      .run(failedCode, failedAt, Date.now(), id);
  }

  /**
   * D4.d D5 — flip a `failed` row back to `pending_materialization`
   * to support `POST /api/agents` `?retry=true` (§3.2 (a) same-row
   * retry). Clears `materialization_failed_code` /
   * `materialization_failed_at` so the next L3b (if this retry also
   * fails) writes a fresh failure stamp, not a stale one.
   *
   * STRICTLY `failed → pending_materialization` ONLY. The status
   * guard is intentionally narrow:
   *   - `pending_materialization` → reject. A second in-flight
   *     retry would race the first; the route layer enforces
   *     same-row retry serializability via the existing-row
   *     dispatch (`materialization_in_progress` for pending) which
   *     fires BEFORE this helper is reached.
   *   - `active` → reject. The row is already where the user wants
   *     it; reopening it for retry would needlessly drop the
   *     `active` dependent-row graph guarantee from §6.3 (an active
   *     row ALWAYS has its full dependents).
   *   - `failed` → flip + clear failed_*.
   *
   * Returns the agent id on success, or `null` if the guard rejected
   * (i.e., the row's status was not `failed` at the moment of the
   * UPDATE). Caller MUST treat `null` as a route-layer 409
   * `retry_target_not_failed` — the retry race lost to a concurrent
   * mutation, and the response must not lie about the outcome.
   *
   * Why a separate helper instead of reusing `flipToActive` or
   * `reserveForMaterialize`:
   *   - `reserveForMaterialize` INSERTs a brand-new row; retry
   *     UPDATEs the existing row.
   *   - `flipToActive` carries the wrong status guard
   *     (`pending_materialization`/`active`) and the wrong
   *     direction (failed → active is never legal per §3.2; failed
   *     rows can only re-enter the lifecycle through pending).
   */
  flipFailedToReserveAgain(id: string): string | null {
    const result = this.db
      .prepare(
        `UPDATE agents
            SET materialization_status      = 'pending_materialization',
                materialization_failed_code = NULL,
                materialization_failed_at   = NULL,
                updated_at = ?
          WHERE id = ?
            AND materialization_status = 'failed'`,
      )
      .run(Date.now(), id);
    return result.changes === 1 ? id : null;
  }

  /**
   * D4.d §5 boot reconciler primitive — mark stale
   * `pending_materialization` rows as `failed` with the canonical
   * `backend_crash_during_materialize` code. "Stale" means the row
   * was created strictly more than `olderThanMs` before `now`.
   *
   * This is a **mark-failed-only** operation — it does NOT attempt to
   * compensate by re-driving the materialize intent. The design choice
   * is intentional: any row that has been pending past the threshold
   * has, by definition, outlived the HTTP lifecycle that owns the
   * per-request flip (commandTimeoutMs default 30s, §3.4); the backend
   * has no in-process context to resume from, the daemon may or may
   * not have completed its half, and a compensating retry would
   * either double-materialize (if the daemon completed) or reissue an
   * intent the operator already abandoned. The user's recovery path
   * is `?retry=true` on the failed row via the management UI — that's
   * a fresh attempt with a new wire intent, not a continuation.
   *
   * Caller invariants:
   *   - Runs SYNCHRONOUSLY during backend bootstrap, after migrations
   *     are applied and BEFORE the HTTP listener binds (§5). See
   *     `runBootMaterializeReconciler` in
   *     `packages/backend/src/runtime/materialize-reconciler.ts` for
   *     the wired call site.
   *   - `now` and `olderThanMs` are both wall-clock millisecond
   *     values; the WHERE clause filters by `created_at < now -
   *     olderThanMs`. `created_at` for materialize-lifecycle rows is
   *     stamped at L1 reserve (`reserveForMaterialize`).
   *   - Rows NEWER than the threshold are left in
   *     `pending_materialization` intact (they might be genuine
   *     in-flight requests if a sibling backend instance ever exists;
   *     today CLAUDE.md pins single-process write, but the threshold
   *     is the right guard if that model ever changes).
   *
   * Returns `{ affected: <count>, ids: <agent_id[]> }`. The ID list
   * is captured via `UPDATE ... RETURNING id`; callers use it for
   * structured logging so operators can grep for "which rows did the
   * reconciler touch on this boot".
   */
  markStaleMaterializationsFailed(params: {
    now: number;
    olderThanMs: number;
  }): { affected: number; ids: string[] } {
    const { now, olderThanMs } = params;
    const cutoff = now - olderThanMs;
    // SQLite `UPDATE ... RETURNING` returns one row per updated row
    // (better-sqlite3 surfaces it via `.all()`). The `RETURNING id`
    // clause lets the boot log enumerate the affected agent ids
    // without an extra SELECT round-trip.
    const rows = this.db
      .prepare<
        [number, number, number],
        { id: string }
      >(
        `UPDATE agents
            SET materialization_status      = 'failed',
                materialization_failed_code = 'backend_crash_during_materialize',
                materialization_failed_at   = ?,
                updated_at = ?
          WHERE materialization_status = 'pending_materialization'
            AND created_at < ?
          RETURNING id`,
      )
      .all(now, now, cutoff);
    return {
      affected: rows.length,
      ids: rows.map(r => r.id),
    };
  }

  /**
   * Partial update. Only keys present in `input` are written. Returns
   * the updated row, or null if the agent does not exist. Caller is
   * responsible for higher-level invariants — this repo just persists.
   */
  update(id: string, input: UpdateAgentInput): AgentDto | null {
    if (!this.get(id)) return null;
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (input.display_name !== undefined) {
      sets.push('display_name = ?');
      values.push(input.display_name);
    }
    if (input.description !== undefined) {
      sets.push('description = ?');
      values.push(input.description);
    }
    if (input.model !== undefined) {
      sets.push('model = ?');
      values.push(input.model);
    }
    if (input.reasoning_effort !== undefined) {
      sets.push('reasoning_effort = ?');
      values.push(input.reasoning_effort);
    }
    if (input.fast_mode !== undefined) {
      sets.push('fast_mode = ?');
      values.push(input.fast_mode === null ? null : input.fast_mode ? 1 : 0);
    }
    if (sets.length === 0) return this.get(id);
    sets.push('updated_at = ?');
    const now = Date.now();
    this.db
      .prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, now, id);
    return this.get(id);
  }

  /**
   * Acquire the durable runtime-transition lock without changing the current
   * runtime. The compare-and-set makes concurrent transitions fail loudly.
   */
  beginRuntimeTransition(
    id: string,
    target: RuntimeKind,
    now = Date.now(),
  ): 'started' | 'not_found' | 'in_progress' | 'deleting' {
    const result = this.db
      .prepare(
        `UPDATE agents
            SET runtime_transition_target = ?,
                runtime_transition_started_at = ?
          WHERE id = ?
            AND runtime_transition_target IS NULL
            AND deletion_started_at IS NULL`,
      )
      .run(target, now, id);
    if (result.changes > 0) return 'started';
    const row = this.getRow(id);
    if (!row) return 'not_found';
    return row.deletion_started_at !== null ? 'deleting' : 'in_progress';
  }

  /** Release a matching transition lock after a pre-commit failure. */
  abortRuntimeTransition(id: string, target: RuntimeKind): boolean {
    const result = this.db
      .prepare(
        `UPDATE agents
            SET runtime_transition_target = NULL,
                runtime_transition_started_at = NULL
          WHERE id = ?
            AND runtime_transition_target = ?`,
      )
      .run(id, target);
    return result.changes > 0;
  }

  /**
   * Commit runtime and target-runtime tuning as one write, then release the
   * lock. A target mismatch is a lost-ownership failure, never a blind update.
   */
  completeRuntimeTransition(
    id: string,
    input: SwitchAgentRuntimeInput,
  ): AgentDto | null {
    const result = this.db
      .prepare(
        `UPDATE agents
            SET runtime = ?,
                model = ?,
                reasoning_effort = ?,
                fast_mode = ?,
                runtime_transition_target = NULL,
                runtime_transition_started_at = NULL,
                updated_at = ?
          WHERE id = ?
            AND runtime_transition_target = ?`,
      )
      .run(
        input.runtime,
        input.model,
        input.reasoning_effort,
        input.fast_mode === null ? null : input.fast_mode ? 1 : 0,
        Date.now(),
        id,
        input.runtime,
      );
    if (result.changes === 0) return null;
    return this.get(id);
  }

  isRuntimeTransitioning(id: string): boolean {
    return this.getRow(id)?.runtime_transition_target != null;
  }

  /**
   * Boot recovery for transitions interrupted before commit. The current
   * runtime remains authoritative until `completeRuntimeTransition`, so stale
   * locks can be rolled back without reconstructing an epoch.
   */
  clearStaleRuntimeTransitions(): number {
    return this.db
      .prepare(
        `UPDATE agents
            SET runtime_transition_target = NULL,
                runtime_transition_started_at = NULL
          WHERE runtime_transition_target IS NOT NULL`,
      )
      .run().changes;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  /**
   * Set avatar storage_key + content_type as a unit. Caller (the
   * AgentService) must have already persisted the blob via
   * `BlobFileStorage.put`. Mirrors `UserRepo.setAvatar`. Returns the
   * updated row, or null when the agent does not exist.
   *
   * Both columns are written together so the v26 CHECK pair
   * (`(key NULL AND ct NULL) OR (key NOT NULL AND ct NOT NULL)`)
   * holds across every commit boundary.
   */
  setAvatar(
    id: string,
    avatar: { storageKey: string; contentType: string },
  ): AgentDto | null {
    if (!this.get(id)) return null;
    this.db
      .prepare(
        `UPDATE agents
            SET avatar_storage_key = ?,
                avatar_content_type = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(avatar.storageKey, avatar.contentType, Date.now(), id);
    return this.get(id);
  }

  /** Clear avatar (both storage_key + content_type to NULL together).
   *  Mirrors `UserRepo.clearAvatar`. */
  clearAvatar(id: string): AgentDto | null {
    if (!this.get(id)) return null;
    this.db
      .prepare(
        `UPDATE agents
            SET avatar_storage_key = NULL,
                avatar_content_type = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(Date.now(), id);
    return this.get(id);
  }

  /** Read raw row including avatar storage fields. The DTO drops the
   *  storage key (renderer fetches via `avatar_url`); routes that need
   *  the key (avatar download / cleanup) call this. */
  getRow(id: string): AgentRow | null {
    const row = this.db
      .prepare<[string], AgentRow>('SELECT * FROM agents WHERE id = ?')
      .get(id);
    return row ?? null;
  }

  /**
   * Every conversation this agent participates in, with display coordinates for
   * the profile. This is a PARTICIPATION projection and never reads runtime slots;
   * the control/read-model unit for processes is `RuntimeSlotRepo.listSeats`.
   *
   * Participation is placement-aware (`agentParticipates`): workspace roster,
   * AgentInbox ownership and DirectPair endpoints all flow through the same SQL
   * authority. The LEFT workspace join is only a coordinate projection for
   * workspace-less placements; it cannot filter participation or runtime state.
   * Closed rows remain in the control list, while `excludeArchived` produces the
   * renderer's narrower activity list.
   */
  listRuntimeParticipations(
    agentId: string,
    opts?: { excludeArchived?: boolean },
  ): AgentRuntimeParticipation[] {
    type Row = {
      conversation_id: string;
      workspace_id: string | null;
      workspace_name: string | null;
      workspace_kind: WorkspaceKind | null;
      conversation_placement_kind: ConversationPlacementKind;
      conversation_roster_policy: ConversationRosterPolicy;
      channel_id: string;
      channel_title: string;
      closed_at: number | null;
    };
    // `excludeArchived` is a DISPLAY-only scope (the agent Activity roster hides
    // archived channels). It must NOT be the default: control-plane callers
    // (Stop-all, delete-agent purge) rely on the COMPLETE view so a runtime left
    // running in an archived channel — archive-stop is best-effort/async and can
    // fail when the host is offline — stays reachable to stop/purge. (#task:1398)
    const archivedFilter = opts?.excludeArchived
      ? 'AND c.archived_at IS NULL'
      : '';
    const participates = agentParticipates('c', agentId);
    // The participation params are spliced into the JOIN, so they precede the
    // WHERE's own `agent_id` — same ordering discipline as the other faces that
    // embed this fragment.
    const params: string[] = [...participates.params];
    const rows = this.db
      .prepare<string[], Row>(
        `SELECT
           c.id               AS conversation_id,
           c.workspace_id     AS workspace_id,
           w.name             AS workspace_name,
           w.workspace_kind   AS workspace_kind,
           c.placement_kind   AS conversation_placement_kind,
           c.roster_policy    AS conversation_roster_policy,
           c.id               AS channel_id,
           c.title            AS channel_title,
           c.closed_at        AS closed_at
         FROM conversations c
         LEFT JOIN workspaces w ON w.id = c.workspace_id
         WHERE ${participates.sql} ${archivedFilter}
         ORDER BY c.closed_at IS NULL DESC, c.updated_at DESC`,
      )
      .all(...params);
    return rows;
  }
}
