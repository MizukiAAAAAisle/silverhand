/**
 * Booting the REAL server in a test, with the driver handle the boot opened.
 *
 * #task:1983 W5 removed `db` from `BackendContext`, which is what makes
 * "production code reaches for the handle" a compile error rather than a ledger
 * row. End-to-end tests still need SQL: they boot a real backend against a
 * fresh disk database and then seed a row no production writer creates (the
 * fixture user), or assert on a row no repository projects (materialization
 * state, credential rows, host sessions).
 *
 * They get it through the labelled `testHooks.onDatabaseOpened` seam and keep
 * using the SAME connection the server runs on — deliberately, not for
 * convenience. A second connection to the same file would put a live extra
 * reader/writer into precisely the scenarios these suites exercise (restart,
 * crash recovery, hard stop, WAL contention), so the harness would be testing a
 * topology production never has.
 *
 * The handle is pinned onto the returned context, so a test writes `ctx.db` as
 * before while production cannot: the field exists only on
 * {@link TestBackendContext}, which lives under `tests/`. Ownership does not
 * move — `close()` still closes it, and a test must not.
 */
import type { Database as Db } from 'better-sqlite3';
import {
  startBackend,
  type CreateBackendOptions,
  type RunningBackend,
} from '../../src/index.js';
import type { TestBackendContext } from './app.js';

/** A booted backend whose context still exposes the driver handle. */
export type TestRunningBackend = Omit<RunningBackend, 'context'> & {
  context: TestBackendContext;
};

/**
 * `startBackend` for tests that need SQL against the running server's database.
 * Fails loud if boot never called the hook: silently returning a context with no
 * handle would surface much later as an unrelated `undefined.prepare` deep
 * inside a test body.
 */
export async function startTestBackend(
  opts: CreateBackendOptions,
): Promise<TestRunningBackend> {
  let handle: Db | undefined;
  const running = await startBackend({
    ...opts,
    testHooks: {
      ...opts.testHooks,
      onDatabaseOpened: db => {
        handle = db;
        opts.testHooks?.onDatabaseOpened?.(db);
      },
    },
  } as CreateBackendOptions);
  if (!handle) {
    throw new Error(
      'startTestBackend: boot did not invoke testHooks.onDatabaseOpened — the seam this harness depends on is gone',
    );
  }
  const context: TestBackendContext = Object.assign(running.context, {
    db: handle,
  });
  return { ...running, context };
}
