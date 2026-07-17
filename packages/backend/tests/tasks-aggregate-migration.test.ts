import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';

// Migration v60 (tasks_first_class_aggregate) falsifiers.
//
// v60 lifts a task out of the `messages` row (the old "message IS task" model)
// into a first-class `tasks` aggregate. These tests drive the REAL migration
// runner over seeded v59 data and lock the properties that would silently
// corrupt or brick a production upgrade:
//   1. A task with an explicit source + a deterministic task_create event
//      backfills id (= old anchor id) / source / created-event, and the
//      task_create system message gains metadata.task_id.
//   2. A missing task_create event is NOT fabricated (created_event = NULL).
//   3. A task whose creator agent/user was deleted (both author ids NULL — a
//      supported ON DELETE SET NULL lifecycle) migrates as creator_kind
//      'system' and does NOT abort the whole migration.
//   4. closed_at is carried IFF status = 'closed'.

/** Apply every migration up to and including `maxVersion` onto a fresh
 *  in-memory DB. FK enforcement OFF so we can seed minimal rows. */
function openDbThrough(maxVersion: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, 0)',
  );
  for (const m of migrations) {
    if (m.version > maxVersion) break;
    const apply = () => {
      db.exec(m.up);
      insertMigration.run(m.version, m.name);
    };
    if (m.foreignKeyEscape) {
      db.pragma('legacy_alter_table = ON');
      try {
        db.transaction(apply)();
      } finally {
        db.pragma('legacy_alter_table = OFF');
      }
    } else {
      db.transaction(apply)();
    }
  }
  return db;
}

let seq = 1;
function insertMessage(
  db: Database.Database,
  row: Record<string, unknown> & { id: string; conversation_id: string },
): void {
  const cols = {
    from_kind: 'agent',
    from_agent_id: null,
    from_user_id: null,
    content: '',
    metadata: null,
    task_number: null,
    task_status: null,
    task_assignee_agent_id: null,
    task_assignee_user_id: null,
    task_title: null,
    task_workspace_id: null,
    task_closed_at: null,
    source_message_id: null,
    task_revision: null,
    task_last_editor_kind: null,
    task_last_editor_id: null,
    task_last_edited_at: null,
    thread_root_id: null,
    ...row,
  };
  db.prepare(
    `INSERT INTO messages (
       id, conversation_id, from_kind, from_agent_id, from_user_id, content,
       metadata, seq, created_at, task_number, task_status,
       task_assignee_agent_id, task_assignee_user_id, task_title,
       task_workspace_id, task_closed_at, source_message_id, task_revision,
       task_last_editor_kind, task_last_editor_id, task_last_edited_at,
       thread_root_id
     ) VALUES (
       @id, @conversation_id, @from_kind, @from_agent_id, @from_user_id, @content,
       @metadata, @seq, @created_at, @task_number, @task_status,
       @task_assignee_agent_id, @task_assignee_user_id, @task_title,
       @task_workspace_id, @task_closed_at, @source_message_id, @task_revision,
       @task_last_editor_kind, @task_last_editor_id, @task_last_edited_at,
       @thread_root_id
     )`,
  ).run({ seq: seq++, created_at: 1000, ...cols });
}

/** Run only the v60 step onto a DB already at v59 (mirrors openDbThrough). */
function applyV60(db: Database.Database): void {
  const v60 = migrations.find(m => m.version === 60);
  if (!v60) throw new Error('v60 migration missing');
  db.transaction(() => {
    db.exec(v60.up);
    db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, 0)').run(
      v60.version,
      v60.name,
    );
  })();
}

describe('migration v60 tasks_first_class_aggregate', () => {
  it('backfills id/source/created-event and stamps metadata.task_id', () => {
    const db = openDbThrough(59);
    try {
      // A normal source message.
      insertMessage(db, { id: 'srcA', conversation_id: 'c1', content: 'need this' });
      // The task anchor (old "message IS task" row) with an explicit source.
      insertMessage(db, {
        id: 'msgA',
        conversation_id: 'c1',
        from_kind: 'agent',
        from_agent_id: 'ag1',
        content: 'body A',
        task_number: 1,
        task_status: 'in_progress',
        task_title: 'Task A',
        task_workspace_id: 'w1',
        source_message_id: 'srcA',
      });
      // The deterministic task_create system event pointing at the anchor.
      insertMessage(db, {
        id: 'evtA',
        conversation_id: 'c1',
        from_kind: 'system',
        content: 'created task #1',
        metadata: JSON.stringify({
          subtype: 'task_create',
          task_number: 1,
          task_status: 'todo',
          task_message_id: 'msgA',
          task_title: 'Task A',
          task_assignee: null,
          actor: { kind: 'agent', id: 'ag1', name: 'Alice' },
        }),
      });

      applyV60(db);

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('msgA') as Record<string, unknown>;
      expect(task).toBeTruthy();
      expect(task.id).toBe('msgA'); // reuses the old anchor id as identity
      expect(task.workspace_id).toBe('w1');
      expect(task.task_number).toBe(1);
      expect(task.status).toBe('in_progress');
      expect(task.title).toBe('Task A');
      expect(task.content).toBe('body A');
      expect(task.source_message_id).toBe('srcA'); // explicit column copied
      expect(task.created_event_message_id).toBe('evtA'); // derived from the event
      expect(task.creator_kind).toBe('agent');
      expect(task.creator_agent_id).toBe('ag1');
      expect(task.creator_user_id).toBeNull();
      expect(task.closed_at).toBeNull();

      // The task_create system message metadata gains the canonical task_id.
      const evt = db.prepare('SELECT metadata FROM messages WHERE id = ?').get('evtA') as { metadata: string };
      expect(JSON.parse(evt.metadata).task_id).toBe('msgA');
    } finally {
      db.close();
    }
  });

  it('does not fabricate created_event and does not abort on a deleted creator', () => {
    const db = openDbThrough(59);
    try {
      // Task whose creating agent was deleted: both author ids NULL (the
      // ON DELETE SET NULL lifecycle). No task_create event exists.
      insertMessage(db, {
        id: 'msgB',
        conversation_id: 'c1',
        from_kind: 'agent',
        from_agent_id: null,
        from_user_id: null,
        content: 'orphaned task',
        task_number: 2,
        task_status: 'todo',
        task_title: 'Task B',
        task_workspace_id: 'w1',
      });

      expect(() => applyV60(db)).not.toThrow();

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('msgB') as Record<string, unknown>;
      expect(task).toBeTruthy();
      expect(task.creator_kind).toBe('system');
      expect(task.creator_agent_id).toBeNull();
      expect(task.creator_user_id).toBeNull();
      expect(task.source_message_id).toBeNull();
      expect(task.created_event_message_id).toBeNull(); // missing event not fabricated
    } finally {
      db.close();
    }
  });

  it('carries closed_at IFF status is closed, and maps a human creator', () => {
    const db = openDbThrough(59);
    try {
      insertMessage(db, {
        id: 'msgC',
        conversation_id: 'c1',
        from_kind: 'user',
        from_user_id: 'u1',
        content: 'done work',
        task_number: 3,
        task_status: 'closed',
        task_title: 'Task C',
        task_workspace_id: 'w1',
        task_closed_at: 12345,
      });
      // A 'done' task must NOT carry closed_at (mirrors the service).
      insertMessage(db, {
        id: 'msgD',
        conversation_id: 'c1',
        from_kind: 'user',
        from_user_id: 'u1',
        content: 'finished',
        task_number: 4,
        task_status: 'done',
        task_title: 'Task D',
        task_workspace_id: 'w1',
        task_closed_at: 99999, // stale value on a non-closed row — must be dropped
      });

      applyV60(db);

      const c = db.prepare('SELECT status, closed_at, creator_kind, creator_user_id FROM tasks WHERE id = ?').get('msgC') as Record<string, unknown>;
      expect(c.status).toBe('closed');
      expect(c.closed_at).toBe(12345);
      expect(c.creator_kind).toBe('user');
      expect(c.creator_user_id).toBe('u1');

      const d = db.prepare('SELECT status, closed_at FROM tasks WHERE id = ?').get('msgD') as Record<string, unknown>;
      expect(d.status).toBe('done');
      expect(d.closed_at).toBeNull(); // normalized: 'done' does not set closed_at
    } finally {
      db.close();
    }
  });
});
