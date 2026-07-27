/**
 * #task:1613 — the desktop composition entry's layout preparation as one
 * observable unit: outcome derivation for the daemon's ready token, and
 * the daemon-local structured failure evidence
 * (`layout_v2_migration_failed` with stage + typed code + versions).
 * A failed preparation never starts the daemon, so this local line is
 * the ONLY failure evidence — pinned here per composition entry.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLayoutMigrationFailures } from '@silverhand/host';
import type { DesktopLayoutMigrationCode } from '@silverhand/shared';
import { prepareDesktopDataLayout } from '../layout-migration/prepare.js';
import { LayoutMigrationError } from '../layout-migration/engine.js';
import { writeDataLayoutMarker } from '../layout-migration/marker.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sh-layout-prepare-'));
}

function collectingLogger() {
  const errors: { fields: Record<string, unknown>; msg: string }[] = [];
  return {
    errors,
    logger: {
      info: () => {},
      warn: () => {},
      error: (fields: Record<string, unknown>, msg: string) => {
        errors.push({ fields, msg });
      },
    },
  };
}

/** Real quiesce needs no legacy pid state on a fresh root; keep it out of
 *  the failure tests via the seam so each test drives exactly one stage. */
const quiesceNoop = async () => {};

describe('prepareDesktopDataLayout (#task:1613)', () => {
  it('fresh root: first-time initialization stamps the marker and reports migrated', async () => {
    const root = makeRoot();
    const { errors, logger } = collectingLogger();
    try {
      const outcome = await prepareDesktopDataLayout({
        appRoot: root,
        logsDir: join(root, 'logs'),
        logger,
        appVersion: '9.9.9-test',
        deps: { quiesce: quiesceNoop },
      });
      expect(outcome).toBe('migrated');
      expect(errors).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('complete marker present before boot: reports already_current', async () => {
    const root = makeRoot();
    const { errors, logger } = collectingLogger();
    try {
      writeDataLayoutMarker(
        join(root, 'desktop', 'data-layout.json'),
        1,
        2,
        3,
        4,
      );
      const outcome = await prepareDesktopDataLayout({
        appRoot: root,
        logsDir: join(root, 'logs'),
        logger,
        appVersion: '9.9.9-test',
        deps: { quiesce: quiesceNoop },
      });
      expect(outcome).toBe('already_current');
      expect(errors).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('engine failure (REAL corrupt marker): rethrows and logs stage=engine with the typed code', async () => {
    const root = makeRoot();
    const { errors, logger } = collectingLogger();
    try {
      mkdirSync(join(root, 'desktop'), { recursive: true });
      writeFileSync(join(root, 'desktop', 'data-layout.json'), 'not json');
      await expect(
        prepareDesktopDataLayout({
          appRoot: root,
          logsDir: join(root, 'logs'),
          logger,
          appVersion: '9.9.9-test',
          deps: { quiesce: quiesceNoop },
        }),
      ).rejects.toThrow(/marker/);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.fields).toMatchObject({
        action: 'layout_v2_migration_failed',
        stage: 'engine',
        code: 'layout_marker_corrupt',
        layoutVersion: 2,
        appVersion: '9.9.9-test',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('quiesce failure: rethrows and logs stage=quiesce (untyped error → code=unknown)', async () => {
    const root = makeRoot();
    const { errors, logger } = collectingLogger();
    try {
      await expect(
        prepareDesktopDataLayout({
          appRoot: root,
          logsDir: join(root, 'logs'),
          logger,
          appVersion: '9.9.9-test',
          deps: {
            quiesce: async () => {
              throw new Error('legacy daemon still owns the roots');
            },
          },
        }),
      ).rejects.toThrow(/legacy daemon/);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.fields).toMatchObject({
        action: 'layout_v2_migration_failed',
        stage: 'quiesce',
        code: 'unknown',
        layoutVersion: 2,
        appVersion: '9.9.9-test',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * #task:1664 — the same failure ALSO leaves the breadcrumb the next
 * authenticated start reports. Pinned here, at the write site, because the one
 * thing that could leak is the code: the log line and the breadcrumb must carry
 * the same MAPPED value, never a raw `err.code`.
 */
describe('prepareDesktopDataLayout breadcrumb (#task:1664)', () => {
  it('records the typed code, aggregating across boots', async () => {
    const root = makeRoot();
    const { logger } = collectingLogger();
    try {
      mkdirSync(join(root, 'desktop'), { recursive: true });
      writeFileSync(join(root, 'desktop', 'data-layout.json'), 'not json');
      const boot = () =>
        prepareDesktopDataLayout({
          appRoot: root,
          logsDir: join(root, 'logs'),
          logger,
          appVersion: '9.9.9-test',
          deps: { quiesce: quiesceNoop },
        });
      await expect(boot()).rejects.toThrow(/marker/);
      expect(readLayoutMigrationFailures({ appRoot: root })).toEqual({
        reports: [
          {
            component: 'desktop',
            app_version: '9.9.9-test',
            stage: 'engine',
            code: 'layout_marker_corrupt',
            layout_version: 2,
            count: 1,
          },
        ],
      });
      // A crash loop folds into the same entry instead of growing the file.
      await expect(boot()).rejects.toThrow(/marker/);
      expect(
        readLayoutMigrationFailures({ appRoot: root })?.reports[0]!.count,
      ).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never lets an arbitrary err.code reach the payload', async () => {
    const root = makeRoot();
    const { errors, logger } = collectingLogger();
    try {
      await expect(
        prepareDesktopDataLayout({
          appRoot: root,
          logsDir: join(root, 'logs'),
          logger,
          appVersion: '9.9.9-test',
          deps: {
            quiesce: async () => {
              // A real errno error: `code` is a string, but not one of ours.
              throw Object.assign(new Error('EACCES: /Users/someone/.silverhand'), {
                code: 'EACCES',
              });
            },
          },
        }),
      ).rejects.toThrow(/EACCES/);
      const report = readLayoutMigrationFailures({ appRoot: root });
      expect(report?.reports).toEqual([
        {
          component: 'desktop',
          app_version: '9.9.9-test',
          stage: 'quiesce',
          code: 'unknown',
          layout_version: 2,
          count: 1,
        },
      ]);
      // Same mapped value in the local log line — one code, two sinks.
      expect(errors[0]!.fields.code).toBe('unknown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Compile-time coverage of the desktop code table: a new `LayoutMigrationError`
 * code that is not in `DesktopLayoutMigrationCodeSchema` fails to typecheck
 * here, instead of silently degrading to `'unknown'` in production.
 */
type Assert<T extends true> = T;
export type _DesktopCodesCovered = Assert<
  LayoutMigrationError['code'] extends DesktopLayoutMigrationCode ? true : false
>;
