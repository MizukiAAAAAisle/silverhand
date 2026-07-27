/**
 * #task:1664 — report the layout-v2 migration failure breadcrumb, once, on the
 * next authenticated start.
 *
 * The failure it reports happened on a boot that never reached a server: the
 * migration blocks startup and the daemon never connects, so there is no
 * handshake to carry it. This module closes that loop from the ONLY process that
 * can: Electron main holds the user-session token and the local app root, and
 * the breadcrumb file is local-machine state (`@silverhand/host` owns it).
 *
 * Delivery is at-most-once and best-effort — no retry queue, no persisted send
 * state. The whole state machine is the file's existence, and the ONE judgment
 * that matters is when to delete it:
 *
 *   - a DELIVERED verdict (2xx, or a 4xx refusal) → delete. The server has seen
 *     the bytes, or has told us it will never accept them; either way keeping
 *     them would resend them on every launch forever.
 *   - transport failure or 5xx → keep. "Could not reach the server" must never
 *     be folded into "the server said no" (the same rule `auth-hydrate.ts`
 *     applies to a session token), and a kept breadcrumb costs one retry on the
 *     next start.
 *
 * It never throws and never blocks startup: a diagnostics path must not become
 * a second failure mode for the boot it is reporting on.
 */
import {
  clearLayoutMigrationFailures,
  readLayoutMigrationFailures,
  shouldReportLayoutMigrationDiagnostics,
} from '@silverhand/host';
import { serializeLayoutMigrationDiagnosticsReport } from '@silverhand/shared';

export type LayoutMigrationReportOutcome =
  /** Reporting is switched off for this machine — the file is left alone. */
  | 'skipped'
  /** No breadcrumb (the overwhelmingly common case). */
  | 'nothing_pending'
  /** The server accepted it; the breadcrumb is gone. */
  | 'reported'
  /** The server refused it permanently (4xx); the breadcrumb is gone. */
  | 'rejected'
  /** Unreachable or a server-side error; the breadcrumb is kept for next start. */
  | 'deferred';

export interface LayoutMigrationReportLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
}

export async function reportLayoutMigrationFailures(opts: {
  appRoot: string;
  /** Absolute URL of `apiPaths.clientLayoutMigrationDiagnostics`. */
  endpoint: string;
  /** The user-session bearer this launch authenticated with. */
  token: string;
  /**
   * The backend fetch (production passes `fetchBackendWithNetworkPolicy`). Typed
   * down to `status` on purpose: the response body is never read, so a 204 with
   * no body and a 4xx with an error JSON take the same path.
   */
  fetchImpl: (input: string, init: RequestInit) => Promise<{ status: number }>;
  logger?: LayoutMigrationReportLogger | null;
}): Promise<LayoutMigrationReportOutcome> {
  if (!shouldReportLayoutMigrationDiagnostics()) return 'skipped';
  const report = readLayoutMigrationFailures({
    appRoot: opts.appRoot,
    logger: opts.logger ?? null,
  });
  if (!report) return 'nothing_pending';

  let status: number;
  try {
    const res = await opts.fetchImpl(opts.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.token}`,
      },
      body: serializeLayoutMigrationDiagnosticsReport(report),
    });
    status = res.status;
  } catch (err) {
    opts.logger?.warn(
      { err, action: 'layout_v2_migration_report_deferred' },
      'could not deliver the layout-v2 migration diagnostics; keeping the breadcrumb',
    );
    return 'deferred';
  }

  if (status >= 500) {
    opts.logger?.warn(
      { status, action: 'layout_v2_migration_report_deferred' },
      'server error delivering the layout-v2 migration diagnostics; keeping the breadcrumb',
    );
    return 'deferred';
  }

  // Delivered — 2xx accepted, 4xx permanently refused. Both consume the
  // breadcrumb; only the log line distinguishes them.
  clearLayoutMigrationFailures({ appRoot: opts.appRoot });
  const delivered: LayoutMigrationReportOutcome =
    status >= 200 && status < 300 ? 'reported' : 'rejected';
  opts.logger?.info(
    {
      status,
      action: 'layout_v2_migration_reported',
      outcome: delivered,
      entries: report.reports.length,
    },
    'delivered the layout-v2 migration diagnostics breadcrumb',
  );
  return delivered;
}
