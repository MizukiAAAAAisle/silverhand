/**
 * #task:1664 — the report side of the migration-failure breadcrumb.
 *
 * The ONE judgment under test is the breadcrumb's lifetime, because that is the
 * entire delivery state machine — and by contract (§5) it is at-most-once:
 *   1. nothing pending → no request at all.
 *   2. 204 accepted → breadcrumb gone, `delivered`.
 *   3. 4xx / 5xx / a transport throw → breadcrumb ALSO gone, `undelivered`:
 *      the sample is dropped rather than kept for another start, so there is no
 *      pending state and no cross-start retry to distinguish "refused" from
 *      "unreachable" for.
 *   4. The breadcrumb is consumed BEFORE the network is touched, so a failure
 *      recorded while the request is in flight survives for the next start.
 *   5. The request carries the bearer and exactly the bytes on disk — the wire
 *      payload and the file are one contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readLayoutMigrationFailures,
  recordLayoutMigrationFailure,
} from '@silverhand/host';
import { parseLayoutMigrationDiagnosticsReport } from '@silverhand/shared';
import { resolveDiagnosticsPaths } from '@silverhand/shared/app-data-layout';
import { reportLayoutMigrationFailures } from '../layout-migration/report-failures.js';

const ENDPOINT = 'http://127.0.0.1:1/api/client-diagnostics/layout-migration';

const FACT = {
  component: 'desktop',
  app_version: '0.2.0',
  stage: 'engine',
  code: 'layout_conflict',
  layout_version: 2,
} as const;

interface Call {
  input: string;
  init: RequestInit;
}

function fetchReturning(status: number): {
  calls: Call[];
  fetchImpl: (input: string, init: RequestInit) => Promise<{ status: number }>;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: async (input, init) => {
      calls.push({ input, init });
      return { status };
    },
  };
}

let appRoot: string;

beforeEach(() => {
  appRoot = mkdtempSync(join(tmpdir(), 'sh-layout-report-'));
});

afterEach(() => {
  rmSync(appRoot, { recursive: true, force: true });
});

describe('reportLayoutMigrationFailures', () => {
  it('does not call the server when there is nothing pending', async () => {
    const { calls, fetchImpl } = fetchReturning(204);
    const outcome = await reportLayoutMigrationFailures({
      appRoot,
      endpoint: ENDPOINT,
      token: 'tok',
      fetchImpl,
    });
    expect(outcome).toBe('nothing_pending');
    expect(calls).toHaveLength(0);
  });

  it('sends the bearer plus exactly the on-disk payload, then it is gone', async () => {
    recordLayoutMigrationFailure({ appRoot, fact: FACT });
    const onDisk = readLayoutMigrationFailures({ appRoot });
    const { calls, fetchImpl } = fetchReturning(204);

    const outcome = await reportLayoutMigrationFailures({
      appRoot,
      endpoint: ENDPOINT,
      token: 'tok-abc',
      fetchImpl,
    });

    expect(outcome).toBe('delivered');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(ENDPOINT);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toMatchObject({
      authorization: 'Bearer tok-abc',
      'content-type': 'application/json',
    });
    const sent = parseLayoutMigrationDiagnosticsReport(
      calls[0]!.init.body as string,
    );
    expect(sent).toEqual({ status: 'valid', value: onDisk });
    expect(readLayoutMigrationFailures({ appRoot })).toBeNull();
  });

  it.each([
    ['a 4xx refusal', 400],
    ['a 5xx', 503],
  ])(
    'drops the sample on %s — one attempt, no pending state',
    async (_label, status) => {
      recordLayoutMigrationFailure({ appRoot, fact: FACT });
      const { calls, fetchImpl } = fetchReturning(status);
      const outcome = await reportLayoutMigrationFailures({
        appRoot,
        endpoint: ENDPOINT,
        token: 'tok',
        fetchImpl,
      });
      expect(outcome).toBe('undelivered');
      expect(calls).toHaveLength(1);
      expect(readLayoutMigrationFailures({ appRoot })).toBeNull();
    },
  );

  it('drops the sample when the request throws, and never throws itself', async () => {
    recordLayoutMigrationFailure({ appRoot, fact: FACT });
    const warnings: Record<string, unknown>[] = [];
    const outcome = await reportLayoutMigrationFailures({
      appRoot,
      endpoint: ENDPOINT,
      token: 'tok',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
      logger: {
        info: () => {},
        warn: fields => {
          warnings.push(fields);
        },
      },
    });
    expect(outcome).toBe('undelivered');
    expect(warnings[0]!.action).toBe('layout_v2_migration_report_undelivered');
    expect(readLayoutMigrationFailures({ appRoot })).toBeNull();
  });

  it('keeps a failure recorded while the request is in flight', async () => {
    recordLayoutMigrationFailure({ appRoot, fact: FACT });
    const outcome = await reportLayoutMigrationFailures({
      appRoot,
      endpoint: ENDPOINT,
      token: 'tok',
      fetchImpl: async () => {
        // The claim already happened, so this write lands on a fresh breadcrumb
        // that the in-flight report can no longer delete.
        recordLayoutMigrationFailure({
          appRoot,
          fact: { ...FACT, stage: 'quiesce' },
        });
        return { status: 204 };
      },
    });

    expect(outcome).toBe('delivered');
    const pending = readLayoutMigrationFailures({ appRoot });
    expect(pending?.reports).toEqual([
      { ...FACT, stage: 'quiesce', count: 1 },
    ]);
  });

  it('discards an unparseable breadcrumb instead of sending it', async () => {
    const paths = resolveDiagnosticsPaths(appRoot);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(
      paths.layoutMigrationFailures,
      '{"reports":[{"message":"/Users/someone/private"}]}',
    );
    const { calls, fetchImpl } = fetchReturning(204);
    const outcome = await reportLayoutMigrationFailures({
      appRoot,
      endpoint: ENDPOINT,
      token: 'tok',
      fetchImpl,
    });
    expect(outcome).toBe('nothing_pending');
    expect(calls).toHaveLength(0);
    expect(readLayoutMigrationFailures({ appRoot })).toBeNull();
  });
});
