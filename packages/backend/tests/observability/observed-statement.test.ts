import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackendLogger } from '../../src/context.js';
import { BackendMetrics } from '../../src/observability/metrics.js';
import {
  configureDatabaseObservation,
  prepareObserved,
} from '../../src/observability/observed-statement.js';

describe('ObservedStatement', () => {
  let db: Database.Database | null = null;
  let metrics: BackendMetrics | null = null;

  afterEach(() => {
    db?.close();
    metrics?.close();
    db = null;
    metrics = null;
  });

  it('preserves the statement surface and emits one named observation', async () => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    db.prepare('INSERT INTO items (name) VALUES (?)').run('secret-value');
    metrics = new BackendMetrics('standalone');
    const warnings: Array<Record<string, unknown>> = [];
    const logger: BackendLogger = {
      info: () => undefined,
      error: () => undefined,
      warn: obj => warnings.push(obj as Record<string, unknown>),
    };
    configureDatabaseObservation(db, {
      metrics,
      logger,
      slowStatementMs: 0,
    });

    const stmt = prepareObserved<[number], { name: string }>(
      db,
      'items.get_by_id',
      'SELECT name FROM items WHERE id = ?',
    );
    expect(stmt.pluck(false)).toBe(stmt);
    expect(stmt.raw(false)).toBe(stmt);
    expect(stmt.expand(false)).toBe(stmt);
    expect(stmt.safeIntegers(false)).toBe(stmt);
    expect(stmt.get(1)).toEqual({ name: 'secret-value' });
    expect(stmt.database).toBe(db);
    expect(stmt.reader).toBe(true);
    expect(stmt.readonly).toBe(true);
    expect(stmt.columns()).toHaveLength(1);

    const body = await metrics.render();
    expect(body).toContain('query_name="items.get_by_id"');
    expect(body).toContain('operation="get"');
    expect(body).toContain('outcome="ok"');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      queryName: 'items.get_by_id',
      operation: 'get',
      outcome: 'ok',
    });
    expect(JSON.stringify(warnings)).not.toContain('secret-value');
    expect(JSON.stringify(warnings)).not.toContain('SELECT name');
  });

  it('times iterator work without counting time between next calls', async () => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
    db.exec('INSERT INTO items (id) VALUES (1), (2), (3)');
    metrics = new BackendMetrics('standalone');
    configureDatabaseObservation(db, { metrics });
    const stmt = prepareObserved<[], { id: number }>(
      db,
      'items.iterate_all',
      'SELECT id FROM items ORDER BY id',
    );

    for (const row of stmt.iterate()) {
      expect(row.id).toBe(1);
      break;
    }

    const body = await metrics.render();
    expect(body).toContain('operation="iterate"');
    expect(body).toContain('silverhand_db_statement_duration_seconds_count{');
    expect(body).toContain('query_name="items.iterate_all"');
  });

  it('rejects missing or unstable query identities', () => {
    const database = new Database(':memory:');
    db = database;
    expect(() => prepareObserved(database, '', 'SELECT 1')).toThrow('invalid observed query name');
    expect(() => prepareObserved(database, 'Items by user 123', 'SELECT 1')).toThrow(
      'invalid observed query name',
    );
  });
});
