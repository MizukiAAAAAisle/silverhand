import Sqlite from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeFanoutDbDeps } from '../../src/adapters/runtime-fanout.js';
import type { BackendLogger } from '../../src/context.js';
import { openDatabase } from '../../src/db.js';
import type { EventPublisher } from '../../src/runtime/event-handler.js';

const SILENT_LOGGER: BackendLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const NOOP_PUBLISHER: EventPublisher = {
  publish: () => {},
  publishSide: () => {},
};

describe('RuntimeSessionUnitOfWork SQLite isolation', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => cleanup?.());

  it('owns the writer reservation before the callback performs authorization reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-runtime-session-uow-'));
    const path = join(dir, 'silverhand.db');
    const db = openDatabase(path);
    const rival = new Sqlite(path);
    rival.pragma('journal_mode = WAL');
    rival.pragma('busy_timeout = 0');
    cleanup = () => {
      rival.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    };
    const persistence = createRuntimeFanoutDbDeps({
      db,
      events: NOOP_PUBLISHER,
      logger: SILENT_LOGGER,
    }).persistence;

    // The rival already owns SQLite's writer reservation. BEGIN IMMEDIATE on
    // the production adapter must fail before entering the callback; a deferred
    // transaction would enter, read an authorization snapshot, and only fail
    // later when it tried to upgrade to a writer.
    rival.exec('BEGIN IMMEDIATE');
    let entered = false;
    expect(() => persistence.session.atomically(() => {
      entered = true;
      return null;
    })).toThrow(/database is locked/);
    expect(entered).toBe(false);
    rival.exec('ROLLBACK');

    expect(persistence.session.atomically(() => {
      entered = true;
      return 'owned';
    })).toBe('owned');
    expect(entered).toBe(true);

    // Nested `.immediate()` is only a SAVEPOINT in better-sqlite3. Prove the
    // production guard refuses before callback entry even when an unknown
    // outer deferred transaction exists and a rival writer already owns the
    // reservation — the exact shape that otherwise makes the callback's
    // authorization SELECT run without the promised lock.
    let nestedEntered = false;
    db.transaction(() => {
      rival.exec('BEGIN IMMEDIATE');
      try {
        expect(() => persistence.session.atomically(() => {
          nestedEntered = true;
          return 'must-not-enter';
        })).toThrow(/immediate transactions are root-only/);
        expect(nestedEntered).toBe(false);
      } finally {
        rival.exec('ROLLBACK');
      }
    })();
  });
});
