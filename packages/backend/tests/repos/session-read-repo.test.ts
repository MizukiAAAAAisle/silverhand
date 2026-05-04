import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations } from '@silverhand/shared';
import { ChannelRepo } from '../../src/repos/channel-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { SessionReadRepo } from '../../src/repos/session-read-repo.js';
import { SessionRepo } from '../../src/repos/session-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const channels = new ChannelRepo(db, {
    workspacesRoot: join(tmpdir(), 'silverhand-session-read-test'),
  });
  const sessions = new SessionRepo(db);
  const messages = new MessageRepo(db);
  const reads = new SessionReadRepo(db);
  const channel = channels.insert({
    name: 'read-ch',
    description: null,
    kind: 'regular',
    workspace_path: channels.workspacePathFor('read-ch'),
    workspace_host_id: localHostId,
    dm_agent_id: null,
  });
  const session = sessions.insert({ channelId: channel.id, title: 's1' });
  const otherSession = sessions.insert({ channelId: channel.id, title: 's2' });
  return { channel, db, messages, reads, session, otherSession };
}

describe('SessionReadRepo', () => {
  it('v10 migration backfills existing v1 history as read for the local viewer', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      for (const migration of migrations.filter(m => m.version < 10)) {
        db.exec(migration.up);
      }
      db.prepare(
        `INSERT INTO hosts (id, name, kind, created_at)
         VALUES ('host', 'local', 'local', 1)`,
      ).run();
      db.prepare(
        `INSERT INTO channels
         (id, name, kind, workspace_path, workspace_host_id, created_at, updated_at)
         VALUES ('channel', 'c', 'regular', '/tmp/c', 'host', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO sessions
         (id, channel_id, title, status, created_at, updated_at)
         VALUES ('session', 'channel', 's', 'active', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO messages
         (id, session_id, from_kind, content, seq, created_at)
         VALUES
           ('m1', 'session', 'agent', 'old agent', 1, 1),
           ('m2', 'session', 'system', 'old system', 2, 2)`,
      ).run();

      db.exec(migrations.find(m => m.version === 10)!.up);

      const row = db
        .prepare(
          `SELECT user_id, session_id, last_read_seq
             FROM session_reads
            WHERE user_id = 'local'
              AND session_id = 'session'`,
        )
        .get() as { user_id: string; session_id: string; last_read_seq: number };
      expect(row).toEqual({
        user_id: 'local',
        session_id: 'session',
        last_read_seq: 2,
      });
      expect(new SessionReadRepo(db).unreadCountsByChannel('local')).toEqual({});
    } finally {
      db.close();
    }
  });

  it('counts messages authored by anyone except the current viewer', () => {
    const { channel, messages, reads, session, otherSession } = bootstrap();

    messages.insert({
      sessionId: session.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'mine',
    });
    messages.insert({
      sessionId: session.id,
      fromKind: 'user',
      content: 'legacy mine',
    });
    messages.insert({
      sessionId: session.id,
      fromKind: 'user',
      fromUserId: 'alice',
      content: 'other human',
    });
    messages.insert({ sessionId: session.id, fromKind: 'agent', content: 'agent' });
    messages.insert({ sessionId: session.id, fromKind: 'system', content: 'system' });
    messages.insert({
      sessionId: otherSession.id,
      fromKind: 'user',
      fromUserId: 'alice',
      content: 'other session',
    });

    const bySession = reads.unreadCountsBySessionForChannel(channel.id, 'local');
    expect(bySession.by_session).toEqual({
      [session.id]: 3,
      [otherSession.id]: 1,
    });
    expect(bySession.total).toBe(4);
    expect(reads.unreadCountsByChannel('local')).toEqual({ [channel.id]: 4 });
  });

  it('advances the cursor to latest seq and never moves it backward', () => {
    const { channel, messages, reads, session } = bootstrap();
    const m1 = messages.insert({ sessionId: session.id, fromKind: 'agent', content: '1' });
    messages.insert({ sessionId: session.id, fromKind: 'agent', content: '2' });
    const latest = messages.insert({
      sessionId: session.id,
      fromKind: 'agent',
      content: '3',
    });

    expect(reads.markRead({ viewerUserId: 'local', sessionId: session.id }).last_read_seq).toBe(
      latest.seq,
    );
    expect(reads.unreadCountsBySessionForChannel(channel.id, 'local').total).toBe(0);

    const next = messages.insert({
      sessionId: session.id,
      fromKind: 'agent',
      content: '4',
    });
    expect(reads.markRead({
      viewerUserId: 'local',
      sessionId: session.id,
      seq: m1.seq,
    }).last_read_seq).toBe(latest.seq);
    expect(reads.unreadCountsBySessionForChannel(channel.id, 'local')).toMatchObject({
      by_session: { [session.id]: 1 },
      total: 1,
    });

    expect(reads.markRead({
      viewerUserId: 'local',
      sessionId: session.id,
      seq: next.seq,
    }).last_read_seq).toBe(next.seq);
    expect(reads.unreadCountsBySessionForChannel(channel.id, 'local').total).toBe(0);
  });
});
