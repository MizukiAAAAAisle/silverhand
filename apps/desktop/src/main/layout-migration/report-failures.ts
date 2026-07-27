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
 * Delivery is AT-MOST-ONCE: the breadcrumb is consumed before the request is
 * made, and its outcome — accepted, refused, or never delivered — does not
 * change that. There is no pending state, no retry queue, and no cross-start
 * lifetime for the payload. That is a bound on delivery ATTEMPTS per claim, not
 * a fact-level guarantee: the counts inside a report are a best-effort histogram
 * (see `takeLayoutMigrationFailures` for the record/claim race it does not lock
 * against).
 *
 * That is a pricing decision, not an oversight. Distinguishing "the server said
 * no" from "could not reach the server" (the rule `auth-hydrate.ts` applies to a
 * session token) buys nothing here: a session token is user-recoverable
 * authority whose loss is visible to the user, whereas this is a best-effort
 * diagnostic sample whose distribution is structurally incomplete anyway —
 * machines still stuck in the failure never report at all. Keeping it for a
 * later start would trade a near-zero gain in sample completeness for a
 * failure-describing payload that can sit on disk indefinitely (a permanently
 * unreachable or 5xx-ing server keeps it forever). One attempt, then gone.
 *
 * It never throws and never blocks startup: a diagnostics path must not become
 * a second failure mode for the boot it is reporting on.
 */
import { takeLayoutMigrationFailures } from '@silverhand/host';
import { serializeLayoutMigrationDiagnosticsReport } from '@silverhand/shared';

export type LayoutMigrationReportOutcome =
  /** No breadcrumb (the overwhelmingly common case); nothing was sent. */
  | 'nothing_pending'
  /** The server accepted the report. */
  | 'delivered'
  /** Refused (4xx), a server error (5xx), or unreachable — sample dropped. */
  | 'undelivered';

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
  // Consume first: the file is gone before the network is touched, so this
  // cannot send twice, cannot leave the payload behind, and cannot delete a
  // failure recorded while the request was in flight.
  const report = takeLayoutMigrationFailures({
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
      { err, action: 'layout_v2_migration_report_undelivered' },
      'could not deliver the layout-v2 migration diagnostics; sample dropped',
    );
    return 'undelivered';
  }

  const entries = report.reports.length;
  if (status < 200 || status >= 300) {
    opts.logger?.warn(
      { status, entries, action: 'layout_v2_migration_report_undelivered' },
      'the server did not accept the layout-v2 migration diagnostics; sample dropped',
    );
    return 'undelivered';
  }
  opts.logger?.info(
    { status, entries, action: 'layout_v2_migration_reported' },
    'delivered the layout-v2 migration diagnostics breadcrumb',
  );
  return 'delivered';
}
