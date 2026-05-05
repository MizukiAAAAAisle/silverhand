import { describe, expect, it, afterEach } from 'vitest';
import { openTestDb, makeTempSilverhandDir } from './utils/db.js';

describe('test infrastructure smoke', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('opens an in-memory DB with migrations applied + bootstrapped local host', () => {
    const { db, localHostId } = openTestDb();
    const tables = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all()
      .map(r => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'hosts',
        'agents',
        'workspaces',
        'workspace_members',
        'conversations',
        'conversation_agents',
        'messages',
        'conversation_inboxes',
        'conversation_events',
      ]),
    );

    const local = db
      .prepare<[string], { id: string; kind: string }>(
        `SELECT id, kind FROM hosts WHERE id = ?`,
      )
      .get(localHostId);
    expect(local?.kind).toBe('local');
  });

  it('creates and removes a temp silverhand dir', () => {
    const t = makeTempSilverhandDir();
    cleanup = t.cleanup;
    expect(t.silverhandDir).toMatch(/silverhand-test-/);
  });
});
