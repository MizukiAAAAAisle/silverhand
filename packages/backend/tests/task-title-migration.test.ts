import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';
import { TaskTitleSchema } from '@silverhand/shared';

const cases = JSON.parse(
  readFileSync(new URL('./fixtures/task-title-migration/cases.json', import.meta.url), 'utf8'),
) as { name: string; raw: string; canonical: string | null }[];
const step = migrations.find((m) => m.version === 96)!;

describe('task title forward migration', () => {
  it('uses the writer contract for all ECMAScript whitespace and preserves other fields', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        'CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, closed_at INTEGER)',
      );
      const valid = cases.filter((c) => c.canonical !== null);
      for (const c of valid) {
        db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)').run(
          c.name,
          c.raw,
          'untouched\nbody',
          123,
        );
      }
      const apply = db.transaction(() => {
        step.precondition!(db);
        db.exec(step.up);
      });
      apply();
      const first = db.prepare('SELECT * FROM tasks ORDER BY id').all();
      for (const c of valid) {
        expect(TaskTitleSchema.parse(c.raw)).toBe(c.canonical);
        expect(
          db.prepare('SELECT title, content, closed_at FROM tasks WHERE id=?').get(c.name),
        ).toEqual({ title: c.canonical, content: 'untouched\nbody', closed_at: 123 });
      }
      apply();
      expect(db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(first);
    } finally {
      db.close();
    }
  });

  it.each(cases.filter((c) => c.canonical === null))(
    'rolls back unrepairable title: $name',
    (c) => {
      const db = new Database(':memory:');
      try {
        db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL)');
        db.prepare('INSERT INTO tasks VALUES (?, ?)').run('repairable', 'a  b');
        db.prepare('INSERT INTO tasks VALUES (?, ?)').run('invalid', c.raw);
        expect(
          db.transaction(() => {
            step.precondition!(db);
            db.exec(step.up);
          }),
        ).toThrow('tasks.title');
        expect(db.prepare('SELECT title FROM tasks WHERE id=?').get('repairable')).toEqual({
          title: 'a  b',
        });
        expect(
          db.prepare("SELECT name FROM sqlite_temp_master WHERE name='task_title_backfill'").all(),
        ).toEqual([]);
      } finally {
        db.close();
      }
    },
  );
});
