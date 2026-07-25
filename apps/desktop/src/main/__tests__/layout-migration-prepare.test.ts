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
import { prepareDesktopDataLayout } from '../layout-migration/prepare.js';
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
