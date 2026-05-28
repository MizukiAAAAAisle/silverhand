/**
 * D4.d §5 — boot-time materialization reconciler.
 *
 * **Purpose.** When the backend crashes between L1 reserve and
 * L3a/L3b flip (route lifecycle in §6.3), it leaves an `agents` row
 * stuck at `materialization_status = 'pending_materialization'`.
 * The per-request flip happens inside one HTTP lifecycle and times
 * out at `commandTimeoutMs` (default 30s, §3.4); any row that has
 * been pending past the threshold has, by definition, outlived its
 * owning request. On the next backend boot — synchronously, before
 * the HTTP listener binds — we mark every such row `failed` with
 * the canonical code `backend_crash_during_materialize`.
 *
 * **Scope: mark-failed-only.** This is NOT a compensating executor.
 * We do NOT re-issue `agent_materialize` for the orphaned rows. The
 * design choice is intentional:
 *
 *   - The daemon may have completed its half (sentinel written) or
 *     not — we can't tell from server state alone, and a compensating
 *     retry would either double-materialize (if the daemon completed)
 *     or reissue an intent the operator already abandoned.
 *   - The backend has no in-process context to resume from — the
 *     request that owned the L1 row is long gone.
 *   - The user's recovery path is `?retry=true` on the failed row via
 *     the management UI (§7.3 / D5). That's a fresh attempt with a
 *     new wire intent, not a continuation.
 *
 * If a future product surface ever wants "auto-retry orphans on
 * boot", that's a new feature with its own design pass — NOT a
 * silent expansion of this reconciler. Keeping the boundary explicit
 * is the load-bearing contract: operators / on-call engineers should
 * be able to read "reconciler reported N rows marked failed" and
 * know exactly what happened, with no implicit retries on their
 * disk.
 *
 * **Sequencing contract.** Must run BEFORE the HTTP listener binds
 * (`ctx.readiness.listenReady = true`). The wiring in
 * `packages/backend/src/index.ts` calls `runBootMaterializeReconciler`
 * after migrations are applied + AgentRepo is available, before
 * `serve()`. The reconciler is fully synchronous (single
 * `UPDATE ... RETURNING` against an already-open WAL connection);
 * no awaits, no IO besides SQLite, no chance of partial completion.
 *
 * **R4 carveout (D4.d series boundary):** this module touches only
 * the server's own DB. It does NOT speak the outbound WS to a
 * daemon, does NOT issue any `agent_materialize` intent, and does
 * NOT cross the formal server↔daemon semantics boundary that the
 * `agent_materialize` intent (D1/D2) does. The boot reconciler is
 * pure server-internal bookkeeping.
 */
import type { AgentRepo } from '../repos/agent-repo.js';
import type { BackendLogger } from '../context.js';

/**
 * Default reconcile threshold: 60s. Any row that has been
 * `pending_materialization` for more than a minute is, by
 * definition, orphaned — the per-request flip happens inside one
 * HTTP lifecycle and times out at `commandTimeoutMs` (default 30s,
 * §3.4); 60s is a comfortable margin that also tolerates clock
 * skew and brief request bursts.
 *
 * Override via env: `SILVERHAND_MATERIALIZE_RECONCILE_THRESHOLD_MS`.
 */
export const DEFAULT_MATERIALIZE_RECONCILE_THRESHOLD_MS = 60_000;

const ENV_VAR_NAME = 'SILVERHAND_MATERIALIZE_RECONCILE_THRESHOLD_MS';

/**
 * Parse the reconciler threshold from `process.env`-like input.
 *
 * Contract:
 *   - Unset / empty                   → return default (60_000).
 *   - Valid positive integer string   → return that integer.
 *   - Anything else (negative, zero,  → return default + log a
 *     non-integer, NaN, overflow)       structured warn so the
 *                                       operator notices their
 *                                       misconfiguration on next
 *                                       boot.
 *
 * Returning the default on invalid input (rather than throwing) is
 * the deliberate fail-soft posture for a knob whose only purpose is
 * operator override. A non-fatal warning + default behavior keeps
 * the backend bootable even if `.env` has a typo, which is the
 * right tradeoff for a single-process desktop app and for
 * unattended server boots.
 */
export function resolveReconcileThresholdMs(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  logger?: BackendLogger,
): number {
  const raw = env[ENV_VAR_NAME];
  if (raw === undefined || raw === '') {
    return DEFAULT_MATERIALIZE_RECONCILE_THRESHOLD_MS;
  }
  if (!/^\d+$/.test(raw)) {
    logger?.warn(
      { envVar: ENV_VAR_NAME, value: raw },
      `${ENV_VAR_NAME} is not a positive integer; using default ${DEFAULT_MATERIALIZE_RECONCILE_THRESHOLD_MS}ms`,
    );
    return DEFAULT_MATERIALIZE_RECONCILE_THRESHOLD_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    logger?.warn(
      { envVar: ENV_VAR_NAME, value: raw },
      `${ENV_VAR_NAME} must be a positive safe integer; using default ${DEFAULT_MATERIALIZE_RECONCILE_THRESHOLD_MS}ms`,
    );
    return DEFAULT_MATERIALIZE_RECONCILE_THRESHOLD_MS;
  }
  return parsed;
}

export interface BootMaterializeReconcilerResult {
  /** Number of `pending_materialization` rows flipped to `failed`. */
  affected: number;
  /** The flipped agent IDs, in DB row order. */
  ids: string[];
  /** The threshold (ms) the reconciler ran with — useful for log audit. */
  thresholdMs: number;
}

/**
 * Run the §5 boot pass. Called once from `startBackend` between
 * migration completion and HTTP `serve()`. See module header for
 * the sequencing contract.
 */
export function runBootMaterializeReconciler(deps: {
  agents: AgentRepo;
  logger: BackendLogger;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable threshold for tests; defaults to env-resolved value. */
  thresholdMs?: number;
  /** Injectable env for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): BootMaterializeReconcilerResult {
  const now = deps.now ?? Date.now;
  const thresholdMs =
    deps.thresholdMs
    ?? resolveReconcileThresholdMs(deps.env ?? process.env, deps.logger);
  const { affected, ids } = deps.agents.markStaleMaterializationsFailed({
    now: now(),
    olderThanMs: thresholdMs,
  });
  if (affected > 0) {
    // Log at info: this is a routine bookkeeping event, but operators
    // benefit from a visible per-boot line ("we flipped 3 rows to
    // failed because they were orphaned from a previous crash").
    // Listing the IDs in the structured payload makes the audit
    // trail searchable in the rolling log files.
    deps.logger.info(
      {
        affected,
        ids,
        thresholdMs,
        failedCode: 'backend_crash_during_materialize',
      },
      `D4.d boot reconciler: marked ${affected} stale pending_materialization row(s) as failed`,
    );
  }
  return { affected, ids, thresholdMs };
}
