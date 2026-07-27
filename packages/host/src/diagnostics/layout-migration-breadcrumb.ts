import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  aggregateLayoutMigrationFailure,
  parseLayoutMigrationDiagnosticsReport,
  serializeLayoutMigrationDiagnosticsReport,
  type LayoutMigrationDiagnosticsReport,
  type LayoutMigrationFailureFact,
} from '@silverhand/shared';
import { resolveDiagnosticsPaths } from '@silverhand/shared/app-data-layout';

/**
 * #task:1664 — the local breadcrumb store for layout-v2 migration failures.
 *
 * A failed migration blocks startup and the daemon never connects, so the
 * failure cannot be observed from the server at the time it happens. Both
 * failing processes (the desktop's pre-connection preparation and the daemon's
 * workspace-data convergence) drop an aggregated breadcrumb here; the desktop
 * reports it on the next authenticated start and clears it.
 *
 * Contract this module is responsible for:
 *
 * - The file's content IS the wire payload — `LayoutMigrationDiagnosticsReport`
 *   and nothing more (no local-only field, ever). See
 *   `@silverhand/shared/layout-migration-diagnostics`.
 * - Every entry point is fail-open and NEVER throws: it runs on a path that is
 *   already failing a startup, and diagnostics must not add a second failure
 *   mode to it. A caller does not need a try/catch.
 * - The file lives at an app-scoped, layout-version-independent coordinate
 *   (`<app-root>/diagnostics/`) resolved by the ONE path authority — it records
 *   a failure OF the migration, so it must not live where the migration moves
 *   bytes.
 *
 * It lives in `@silverhand/host` because host owns local-filesystem authority
 * (CLAUDE.md invariant 3); the desktop main process already consumes host for
 * its other local-machine layout work (quiesce, engine).
 */

export interface LayoutMigrationBreadcrumbLogger {
  warn(fields: Record<string, unknown>, msg: string): void;
}

/**
 * There is NO reporting gate: shiki approved automatic reporting (2026-07-27)
 * and the payload is a closed set of enums, versions, and counts, so there is
 * nothing to decide per failure. A `shouldReport()` seam is deliberately absent
 * — a constant-true predicate consulted at the write site and again at the send
 * site is two read points, which is exactly the shape that can disagree (a file
 * holding bytes the sender will never send). If a user-visible switch is ever
 * added, the product first has to say WHICH question it answers — "don't record"
 * or "don't send" — and that answer decides where the single read point goes.
 */

/**
 * Fold one failure into the breadcrumb file (read → aggregate → atomic write).
 *
 * Aggregation and the saturating count live in the shared contract; this only
 * does the IO. Concurrent writers (a desktop preparation and a same-machine
 * user-managed daemon failing in the same instant) race on last-writer-wins and
 * one increment can be lost — acceptable for a best-effort failure histogram,
 * and the reason the write is a whole-file rename rather than the
 * exclusive-create `link()` pattern used where a collision must fail closed.
 */
export function recordLayoutMigrationFailure(opts: {
  appRoot: string;
  fact: LayoutMigrationFailureFact;
  logger?: LayoutMigrationBreadcrumbLogger | null;
}): void {
  try {
    const paths = resolveDiagnosticsPaths(opts.appRoot);
    const existing = readReport(paths.layoutMigrationFailures);
    const reports = aggregateLayoutMigrationFailure(
      existing?.reports ?? [],
      opts.fact,
    );
    mkdirSync(paths.root, { recursive: true });
    writeFileAtomicOverwrite(
      paths.layoutMigrationFailures,
      serializeLayoutMigrationDiagnosticsReport({ reports }),
    );
  } catch (err) {
    opts.logger?.warn(
      { err, action: 'layout_v2_migration_breadcrumb_write_failed' },
      'could not record the layout-v2 migration failure breadcrumb',
    );
  }
}

/**
 * Read the pending report, or `null` when there is nothing to send.
 *
 * The file is untrusted input (hand-editable, or a partial write): anything the
 * bounded parse rejects is deleted and reported as nothing pending. We never log
 * or forward the rejected bytes — only that a reject happened.
 */
export function readLayoutMigrationFailures(opts: {
  appRoot: string;
  logger?: LayoutMigrationBreadcrumbLogger | null;
}): LayoutMigrationDiagnosticsReport | null {
  try {
    const path = resolveDiagnosticsPaths(opts.appRoot).layoutMigrationFailures;
    const report = readReport(path, () => {
      opts.logger?.warn(
        { action: 'layout_v2_migration_breadcrumb_invalid', path },
        'discarding an unparseable layout-v2 migration breadcrumb file',
      );
      removeQuietly(path);
    });
    return report;
  } catch {
    return null;
  }
}

/**
 * CONSUME the pending report: the breadcrumb is gone before this returns, and
 * `null` means there was nothing pending.
 *
 * Reporting is at-most-once by contract — a sample that cannot be delivered is
 * dropped rather than kept for another start. Consuming here, before the caller
 * touches the network, is what makes that true structurally: the sample's
 * lifetime on disk is bounded by "one authenticated start", never by the
 * server's availability.
 *
 * The claim is a rename, not a read-then-unlink, and what that buys is exactly
 * ONE guarantee: a breadcrumb that exists after the claim cannot be deleted by
 * an in-flight attempt that claimed before it. It does NOT make the histogram
 * exact. `recordLayoutMigrationFailure` is read → aggregate → write-rename, not
 * an atomic transaction, so a cross-process interleaving (a writer reads the old
 * report, this claim renames it away, the writer then writes `old + new` back)
 * can report an old fact twice, and the writer-vs-writer race is plain
 * last-writer-wins. Both are accepted: this is a best-effort failure histogram
 * whose distribution is structurally incomplete anyway (a machine still stuck in
 * the failure never reports at all), and a lock or a state machine costs more
 * than count precision is worth here. "At-most-once" is a statement about
 * DELIVERY ATTEMPTS per claim, never about facts.
 *
 * Crash-safety: a crash between the claim and the delivery drops that sample by
 * design, but the claim file must not survive it — a payload describing a
 * failure may not sit on disk indefinitely, which is the same reason the sample
 * is not kept for a retry. So each call first sweeps any leftover claim file
 * (bytes unread, never sent) before claiming the current breadcrumb. The sweep
 * is unconditional rather than pid- or age-qualified: pid liveness is not a
 * cleanup contract, and reporting runs once per launch in a single process, so
 * a claim file that is still live is already outside the design — losing that
 * one concurrent sample is the crash case again, whereas the alternative is
 * unbounded residency.
 */
export function takeLayoutMigrationFailures(opts: {
  appRoot: string;
  logger?: LayoutMigrationBreadcrumbLogger | null;
}): LayoutMigrationDiagnosticsReport | null {
  try {
    const paths = resolveDiagnosticsPaths(opts.appRoot);
    const path = paths.layoutMigrationFailures;
    sweepStaleClaims(paths.root, path, opts.logger ?? null);
    const claimPath = `${path}${CLAIM_SUFFIX}${process.pid}`;
    try {
      renameSync(path, claimPath);
    } catch {
      // Absent (the common case) or unclaimable — nothing pending either way.
      return null;
    }
    const report = readReport(claimPath, () => {
      opts.logger?.warn(
        { action: 'layout_v2_migration_breadcrumb_invalid', path },
        'discarding an unparseable layout-v2 migration breadcrumb file',
      );
    });
    removeQuietly(claimPath);
    return report;
  } catch {
    return null;
  }
}

const CLAIM_SUFFIX = '.claim.';

/**
 * Delete leftover claim files from an earlier start that crashed between the
 * claim and the delivery. Their bytes are never read and never sent: a stale
 * claim is a dropped sample, not a pending one, so there is nothing to recover —
 * only residency to end.
 */
function sweepStaleClaims(
  root: string,
  breadcrumbPath: string,
  logger: LayoutMigrationBreadcrumbLogger | null,
): void {
  const prefix = `${basename(breadcrumbPath)}${CLAIM_SUFFIX}`;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    // No diagnostics dir yet — nothing to sweep.
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const removal = removeQuietly(join(root, name));
    if (removal.gone) {
      logger?.warn(
        { action: 'layout_v2_migration_breadcrumb_claim_swept', name },
        'removed a layout-v2 migration breadcrumb claim left by an earlier start',
      );
    } else {
      // Still on disk: say so rather than logging a sweep that did not happen.
      // Fail-open as everywhere else — the claim below can still proceed.
      logger?.warn(
        { err: removal.err, action: 'layout_v2_migration_breadcrumb_claim_sweep_failed', name },
        'could not remove a stale layout-v2 migration breadcrumb claim',
      );
    }
  }
}

function readReport(
  path: string,
  onInvalid?: () => void,
): LayoutMigrationDiagnosticsReport | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Missing (the common case) or unreadable — both mean "nothing pending".
    return null;
  }
  const parsed = parseLayoutMigrationDiagnosticsReport(raw);
  if (parsed.status === 'valid') return parsed.value;
  if (parsed.status === 'invalid') onInvalid?.();
  return null;
}

/**
 * Delete a path without throwing, reporting whether it is GONE afterwards.
 *
 * `{ gone: true }` covers both "unlinked" and "was already absent" — the caller
 * only ever cares about the end state. A real failure (EACCES on the directory,
 * a read-only volume) returns the error so a caller that logs the removal can
 * say which of the two happened instead of claiming a cleanup it did not do.
 */
function removeQuietly(path: string): { gone: true } | { gone: false; err: unknown } {
  try {
    unlinkSync(path);
    return { gone: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { gone: true };
    return { gone: false, err };
  }
}

function writeFileAtomicOverwrite(path: string, content: string): void {
  const tmpPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tmpPath, content, { mode: 0o600 });
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup; a leaked tmp file is harmless.
    }
    throw err;
  }
}
