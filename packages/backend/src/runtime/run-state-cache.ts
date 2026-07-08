/**
 * `RunStateCache` — backend's in-memory projection of every live
 * runtime's last-known state as reported by the silverhand-daemon.
 *
 * ## Responsibility scope (Cindy `KMJFmcS4hf_tJ5hj` boundary 1)
 *
 * This module ONLY stores what the daemon has told us. It does NOT:
 *   - Subscribe to the daemon (`RuntimeEventHandler` owns that)
 *   - Issue commands (`RuntimeBridge` owns that)
 *   - Publish SSE / write DB / drain inbox / accumulate activity log
 *     (`RuntimeEventHandler` owns each of those, reading from this cache)
 *
 * The split exists because CM ballooned to ~2.7k lines by collapsing
 * cache + command + side-effects into one class; the daemon refactor
 * keeps them apart so each layer can be tested with a fake of its
 * single dependency.
 *
 * ## What the cache stores per (conversationId, agentId)
 *
 *   - `phase` — daemon-side lifecycle (idle/spawning/startup_pending/
 *     ready/draining/exited). Only daemon knows this authoritatively;
 *     backend uses it to gate delivery (`ready` only) and decide
 *     hydrate-vs-spawn (`exited` means we may spawn fresh).
 *   - `runState` — the rich `AgentRunState` DTO the renderer needs
 *     (status / activitySnippet / toolCallCounts / compaction). Daemon
 *     derives this from parsed events in `RealSupervisor.emitState`
 *     and ships it on `runtime_state` events; backend never re-derives
 *     it. `null` until daemon emits its first state.
 *   - `pid` / `startedAt` — purely diagnostic, for activity-log
 *     headers and the AgentRuntime DB row's `last_pid`. Not used for
 *     gating.
 *   - `updatedAt` — cache-side wall clock so out-of-order events with
 *     identical daemon `ts` still order deterministically.
 *
 * ## Daemon instance tracking (cross-reconnect safety)
 *
 * If backend reconnects to a NEW daemon (different `daemon_pid`), the
 * old cache is stale — that daemon's runtimes no longer exist. Callers
 * pass `daemonInstanceKey` (minted by `makeDaemonInstanceKey()` from the
 * daemon's `ready` event) on every apply; the cache wipes entries from a
 * different key before applying new ones. This keeps the "old daemon's
 * last known state" from persisting after a daemon swap, which would
 * otherwise mislead the UI and the inbox-drain decisions.
 *
 * ## Why no event emission
 *
 * Cindy `KMJFmcS4hf_tJ5hj` boundary 3: the cache is passive. Push
 * happens in `RuntimeEventHandler` because the same event needs to
 * fan out to SSE, DB, inbox, and activity log — and that fan-out wants
 * a single owner, not "every consumer subscribes to the cache and
 * separately to the daemon." Keeping the cache pure also makes its
 * tests trivial (no async, no mocks, no event-loop coordination).
 */
import type { RuntimeStateDto } from '@silverhand/host';
import type {
  AgentRunState,
  AgentRunStatus,
  AgentRunTerminalReason,
} from '@silverhand/shared';

/**
 * Project a terminal status from an `AgentRunTerminalReason`. Mapping
 * inherited verbatim from the original `ConversationManager` runtime's
 * `publishTerminalRunState` / `terminalStatus` helper; lifted here so
 * `resolveRun` projects identically. (The CM runtime itself was
 * removed in #task:512 cleanup Commit B; this helper survived as the
 * shared projection.)
 */
function terminalStatusForReason(
  reason: AgentRunTerminalReason,
): AgentRunStatus {
  return reason === 'replied' || reason === 'turn_ended' || reason === 'replaced'
    ? 'idle'
    : 'failed';
}

/**
 * Daemon lifecycle phase, mirroring `RuntimeStateDto.phase` from the
 * host protocol. Re-exported here as a local type alias so backend
 * callers don't have to reach into `@silverhand/host` for it; the
 * underlying enum lives in the protocol and is the source of truth.
 */
export type RuntimePhase = RuntimeStateDto['phase'];

/**
 * One cache entry per (conversationId, agentId). Fields are a strict
 * subset of `RuntimeStateDto` plus a cache-local `updatedAt` for
 * ordering. We do NOT inline conversation/agent into the entry to
 * minimize allocations — they're already encoded in the map key.
 */
export interface CachedRuntimeEntry {
  conversationId: string;
  agentId: string;
  phase: RuntimePhase;
  pid: number | null;
  startedAt: number | null;
  runState: AgentRunState | null;
  /** Daemon instance key (see `makeDaemonInstanceKey()`) that owns
   *  this entry. Lets callers detect stale data on hydrate. */
  daemonInstanceKey: string;
  /** Wall-clock ms of last cache mutation; cache-local, not from daemon. */
  updatedAt: number;
}

function key(conversationId: string, agentId: string): string {
  return `${conversationId}|${agentId}`;
}

export class RunStateCache {
  private readonly entries = new Map<string, CachedRuntimeEntry>();
  /** Last daemon instance we accepted updates from. `null` until the
   *  first apply lands. Tracked separately from per-entry keys so a
   *  daemon swap can wipe even (conv,agent) pairs that the new daemon
   *  hasn't reported on yet. */
  private currentDaemonInstanceKey: string | null = null;

  /**
   * Apply the full set of runtimes from a `runtime_status` response.
   * This is the hydrate path — used on subscribe and on reconnect.
   *
   * Semantics:
   *   1. If `daemonInstanceKey` differs from the previously seen one,
   *      EVERY existing entry is wiped before applying. This is the
   *      daemon-swap case — old data is by definition stale.
   *   2. After the wipe, entries present in `dtos` are upserted.
   *   3. Entries the cache held but `dtos` does NOT mention are
   *      removed — they're either exited-and-collected or unknown to
   *      the new daemon, neither of which backend should keep showing.
   *
   * The third behavior is conservative on purpose: a `runtime_status`
   * snapshot is the daemon's authoritative "everything I currently
   * track" answer; anything missing is gone.
   */
  applyRuntimeStatus(
    daemonInstanceKey: string,
    dtos: readonly RuntimeStateDto[],
    now: number = Date.now(),
  ): void {
    if (this.currentDaemonInstanceKey !== daemonInstanceKey) {
      this.entries.clear();
      this.currentDaemonInstanceKey = daemonInstanceKey;
    }
    const seen = new Set<string>();
    for (const dto of dtos) {
      const k = key(dto.conversation_id, dto.agent_id);
      seen.add(k);
      this.entries.set(k, {
        conversationId: dto.conversation_id,
        agentId: dto.agent_id,
        phase: dto.phase,
        pid: dto.pid,
        startedAt: dto.started_at,
        runState: dto.run_state,
        daemonInstanceKey,
        updatedAt: now,
      });
    }
    // Drop entries the snapshot omitted — daemon doesn't track them
    // anymore, so neither should we.
    for (const k of this.entries.keys()) {
      if (!seen.has(k)) this.entries.delete(k);
    }
  }

  /**
   * Apply a single `runtime_state` event. The daemon emits one of
   * these after every state-machine transition; the cache just stores
   * it. We DO NOT merge — daemon ships the full state, so a partial
   * patch would risk dropping a field the daemon meant to clear (e.g.
   * `compactionStale` reset after `compaction_finished`).
   *
   * If we have no entry yet for this (conv, agent) — i.e. the
   * `runtime_state` event arrived before any `runtime_status` hydrate
   * — we create one with `phase='ready'` as a best-effort default,
   * since daemon only emits `runtime_state` for runtimes past spawn.
   * A subsequent `runtime_status` will correct the phase.
   *
   * If the event's `daemonInstanceKey` does not match the cache's
   * current key, the event is dropped — it came from a stale daemon
   * subscription that the caller hasn't reconciled yet.
   */
  applyRuntimeState(
    daemonInstanceKey: string,
    conversationId: string,
    agentId: string,
    state: AgentRunState,
    now: number = Date.now(),
  ): void {
    if (!this.acceptDaemonKey(daemonInstanceKey)) return;
    const k = key(conversationId, agentId);
    const prev = this.entries.get(k);
    this.entries.set(k, {
      conversationId,
      agentId,
      phase: prev?.phase ?? 'ready',
      pid: prev?.pid ?? null,
      startedAt: prev?.startedAt ?? null,
      runState: state,
      daemonInstanceKey,
      updatedAt: now,
    });
  }

  /**
   * Phase patch — for events that imply a phase transition without
   * a full state update. Examples:
   *   - `runtime_ready_for_drain` ⇒ `phase = 'ready'`
   *   - `runtime_exit` ⇒ `phase = 'exited'` (paired with `applyRuntimeExit`)
   *   - `runtime_stop` reply with `stopped=true` and `mode='hard'`
   *     ⇒ `phase = 'draining'` until the exit event lands
   *
   * Phase-only updates are safe to merge because `phase` is the only
   * field touched — unlike `runtime_state`'s full snapshot, we cannot
   * accidentally drop another field.
   */
  applyPhase(
    daemonInstanceKey: string,
    conversationId: string,
    agentId: string,
    phase: RuntimePhase,
    now: number = Date.now(),
  ): void {
    if (!this.acceptDaemonKey(daemonInstanceKey)) return;
    const k = key(conversationId, agentId);
    const prev = this.entries.get(k);
    if (!prev) {
      // No prior entry: create a skeleton so consumers can at least
      // see "this runtime exists and is in this phase." The runState
      // stays null until the daemon emits one.
      this.entries.set(k, {
        conversationId,
        agentId,
        phase,
        pid: null,
        startedAt: null,
        runState: null,
        daemonInstanceKey,
        updatedAt: now,
      });
      return;
    }
    this.entries.set(k, { ...prev, phase, daemonInstanceKey, updatedAt: now });
  }

  /**
   * Convenience for `runtime_exit`: forces `phase = 'exited'` and
   * leaves `runState` untouched (daemon's last `runtime_state` before
   * exit already carries the terminal `status` / `terminalReason`).
   *
   * Returns the post-update entry, or `null` if the event was
   * dropped (stale daemon key) or no prior entry existed AND the
   * caller didn't want a skeleton. We DO create a skeleton here
   * because backend's `RuntimeEventHandler` always needs an entry to
   * read from when it broadcasts the final SSE.
   */
  applyRuntimeExit(
    daemonInstanceKey: string,
    conversationId: string,
    agentId: string,
    now: number = Date.now(),
  ): CachedRuntimeEntry | null {
    if (!this.acceptDaemonKey(daemonInstanceKey)) return null;
    const k = key(conversationId, agentId);
    const prev = this.entries.get(k);
    const next: CachedRuntimeEntry = prev
      ? { ...prev, phase: 'exited', daemonInstanceKey, updatedAt: now }
      : {
          conversationId,
          agentId,
          phase: 'exited',
          pid: null,
          startedAt: null,
          runState: null,
          daemonInstanceKey,
          updatedAt: now,
        };
    this.entries.set(k, next);
    return next;
  }

  /**
   * Metadata-only projection for `runtime_parsed_event_dropped`.
   *
   * We deliberately do NOT synthesize a fake ParsedEvent. The daemon told us
   * the parsed payload exceeded the wire cap, so the only safe cache mutation
   * is to annotate the existing run state with a lossy diagnostic in fields
   * already present on `AgentRunState`.
   */
  applyParsedEventDropped(
    daemonInstanceKey: string,
    conversationId: string,
    agentId: string,
    meta: {
      parsedKind: string;
      encodedBytes: number;
      reason: string;
      ts: number;
    },
  ): AgentRunState | null {
    if (!this.acceptDaemonKey(daemonInstanceKey)) return null;
    const k = key(conversationId, agentId);
    const prev = this.entries.get(k);
    if (!prev?.runState) return null;
    const nextState: AgentRunState = {
      ...prev.runState,
      updatedAt: meta.ts,
      lastActivityAt: Math.max(prev.runState.lastActivityAt, meta.ts),
      detail: `parsed_event_dropped:${meta.parsedKind}:${meta.reason}:${meta.encodedBytes}`,
    };
    this.entries.set(k, {
      ...prev,
      runState: nextState,
      daemonInstanceKey,
      updatedAt: meta.ts,
    });
    return nextState;
  }

  /**
   * Drop an entry entirely — used by `RuntimeBridge.clearRuntimeSession`
   * after backend cleared the user-level session (DB tx, audit, etc.)
   * and the daemon acknowledged its `runtime_clear_session`.
   *
   * Distinct from `applyRuntimeExit` which preserves the entry with
   * `phase='exited'`; clear-session is the "we're done with this
   * (conv, agent) entirely" signal.
   */
  clear(conversationId: string, agentId: string): void {
    this.entries.delete(key(conversationId, agentId));
  }

  /**
   * Wipe everything — used on daemon shutdown and on transport
   * failure when caller wants to clear before reconnect rehydrates.
   * Also resets `currentDaemonInstanceKey` so the next `applyRuntimeStatus`
   * unconditionally accepts whatever daemon answers.
   */
  clearAll(): void {
    this.entries.clear();
    this.currentDaemonInstanceKey = null;
  }

  get(
    conversationId: string,
    agentId: string,
  ): CachedRuntimeEntry | undefined {
    return this.entries.get(key(conversationId, agentId));
  }

  list(): CachedRuntimeEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Read-only view of the daemon instance the cache is currently
   * synced with. `null` before the first apply. Exposed for tests
   * and for `RuntimeEventHandler` to detect daemon swap.
   */
  get daemonInstanceKey(): string | null {
    return this.currentDaemonInstanceKey;
  }

  // ── run resolution helpers (Cindy `SG1-ZTOUKLvs1A6G` revision 5) ──
  //
  // CM's `resolveRun` / `resolveConversationRuns` need a daemon-mode
  // equivalent. The split: cache owns the snapshot transition (clear
  // runState, project terminalReason); DaemonHost owns the SSE
  // publish off the returned snapshot. Doing the publish inside the
  // cache would re-couple the projection (`RunStateCache`) to the
  // event surface (`EventPublisher`), breaking the boundary
  // (`KMJFmcS4hf_tJ5hj` 3).
  //
  // The returned `AgentRunState` carries `status: 'failed'` (matching
  // CM's terminal projection — `idle` runs that turn-end naturally
  // also end up failed/replied etc., but the cache wrapper here
  // always stamps `failed` because anything DaemonHost would
  // explicitly "resolve" was not a natural turn_end). Caller picks
  // the right SSE payload.

  /**
   * Resolve the active run for (conv, agent). Returns the terminal
   * snapshot (with `terminalReason` and cleared `compacting` /
   * `compactionStale`) so the caller can broadcast the final state,
   * then clears `runState` from the cache entry.
   *
   * No-op + returns `null` when there is no entry, no active runState,
   * or (when supplied) the `expectedRunId` doesn't match the active
   * run's `runId` — matches CM's idempotency contract (`resolveRun`
   * fired against a stale runId is silently dropped to avoid clobbering
   * the next run's state).
   */
  resolveRun(
    conversationId: string,
    agentId: string,
    reason: AgentRunTerminalReason,
    expectedRunId?: string,
    now: number = Date.now(),
  ): AgentRunState | null {
    const k = key(conversationId, agentId);
    const prev = this.entries.get(k);
    if (!prev?.runState) return null;
    if (expectedRunId !== undefined && prev.runState.runId !== expectedRunId) {
      return null;
    }
    const terminalStatus: AgentRunStatus = terminalStatusForReason(reason);
    const terminal: AgentRunState = {
      ...prev.runState,
      status: terminalStatus,
      terminalReason: reason,
      updatedAt: now,
      // Compaction flags are run-scoped; a resolved run should not
      // carry "we're still compacting" into the terminal snapshot.
      compacting: false,
      compactingSince: undefined,
      compactionStale: false,
    };
    this.entries.set(k, {
      ...prev,
      runState: null,
      updatedAt: now,
    });
    return terminal;
  }

  /**
   * Bulk-resolve every (conv, *) entry's active run. Returns the list
   * of terminal snapshots so the caller can publish each on the SSE
   * bus. Order: insertion order of the underlying map (stable across
   * Node versions for non-Symbol keys).
   *
   * Matches CM `resolveConversationRuns(conv, reason='conversation_closed')`
   * semantics: every agent in the conversation that still had an
   * active run state gets a terminal snapshot.
   */
  resolveConversationRuns(
    conversationId: string,
    reason: AgentRunTerminalReason,
    now: number = Date.now(),
  ): AgentRunState[] {
    const resolved: AgentRunState[] = [];
    for (const entry of this.entries.values()) {
      if (entry.conversationId !== conversationId) continue;
      const terminal = this.resolveRun(
        conversationId,
        entry.agentId,
        reason,
        undefined,
        now,
      );
      if (terminal) resolved.push(terminal);
    }
    return resolved;
  }

  /**
   * Internal helper: decide whether to accept an event from a given
   * daemon. If the cache hasn't seen any daemon yet (first event
   * after subscribe), latch onto this one. If the keys disagree, drop
   * the event — caller is responsible for issuing a fresh hydrate
   * before further events flow.
   */
  private acceptDaemonKey(daemonInstanceKey: string): boolean {
    if (this.currentDaemonInstanceKey === null) {
      this.currentDaemonInstanceKey = daemonInstanceKey;
      return true;
    }
    return this.currentDaemonInstanceKey === daemonInstanceKey;
  }
}
