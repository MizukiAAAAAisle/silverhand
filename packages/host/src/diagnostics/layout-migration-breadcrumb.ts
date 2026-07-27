import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * The ONE gate for "may this machine report migration diagnostics?", read by
 * BOTH the write side and the report side. Today it is unconditionally true:
 * shiki approved automatic reporting (2026-07-27) and the payload is a closed
 * set of enums, versions, and counts, so there is nothing to consent to per
 * failure.
 *
 * It exists as a function on purpose. If a user-visible switch is ever added,
 * its value feeds THIS function and nothing else moves — the alternative
 * (branching at the write site and again at the send site) is the shape that
 * becomes expensive to change, because the two gates can then disagree and the
 * file can hold bytes the sender will never send.
 */
export function shouldReportLayoutMigrationDiagnostics(): boolean {
  return true;
}

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
  if (!shouldReportLayoutMigrationDiagnostics()) return;
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

/** Drop the breadcrumb file. Idempotent and never throws. */
export function clearLayoutMigrationFailures(opts: { appRoot: string }): void {
  try {
    removeQuietly(resolveDiagnosticsPaths(opts.appRoot).layoutMigrationFailures);
  } catch {
    // Nothing to recover: the next write folds into whatever survived.
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

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
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
