/**
 * #task:1664 — the report side of the migration-failure breadcrumb.
 *
 * The ONE judgment under test is when the breadcrumb is deleted, because that is
 * the entire delivery state machine:
 *   1. nothing pending → no request at all.
 *   2. 204 accepted → breadcrumb gone, `reported`.
 *   3. 4xx refused (a DELIVERED verdict) → breadcrumb gone, `rejected`:
 *      re-sending bytes the server will never accept is a permanent no-op.
 *   4. 5xx or a transport throw → breadcrumb KEPT, `deferred`: "could not reach"
 *      must never be folded into "the server said no".
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

  it('sends the bearer plus exactly the on-disk payload, then clears it', async () => {
    recordLayoutMigrationFailure({ appRoot, fact: FACT });
    const onDisk = readLayoutMigrationFailures({ appRoot });
    const { calls, fetchImpl } = fetchReturning(204);

    const outcome = await reportLayoutMigrationFailures({
      appRoot,
      endpoint: ENDPOINT,
      token: 'tok-abc',
      fetchImpl,
    });

    expect(outcome).toBe('reported');
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

  it('clears the breadcrumb on a 4xx refusal (a delivered verdict)', async () => {
    recordLayoutMigrationFailure({ appRoot, fact: FACT });
    const { fetchImpl } = fetchReturning(400);
    const outcome = await reportLayoutMigrationFailures({
      appRoot,
      endpoint: ENDPOINT,
      token: 'tok',
      fetchImpl,
    });
    expect(outcome).toBe('rejected');
    expect(readLayoutMigrationFailures({ appRoot })).toBeNull();
  });

  it('keeps the breadcrumb on a 5xx', async () => {
    recordLayoutMigrationFailure({ appRoot, fact: FACT });
    const { fetchImpl } = fetchReturning(503);
    const outcome = await reportLayoutMigrationFailures({
      appRoot,
      endpoint: ENDPOINT,
      token: 'tok',
      fetchImpl,
    });
    expect(outcome).toBe('deferred');
    expect(readLayoutMigrationFailures({ appRoot })?.reports).toHaveLength(1);
  });

  it('keeps the breadcrumb when the request throws, and never throws itself', async () => {
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
    expect(outcome).toBe('deferred');
    expect(warnings[0]!.action).toBe('layout_v2_migration_report_deferred');
    expect(readLayoutMigrationFailures({ appRoot })?.reports).toHaveLength(1);
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
  });
});
