import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ChannelRepo } from '../../src/repos/channel-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { SessionRepo } from '../../src/repos/session-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrapSession() {
  const { db, localHostId } = openTestDb();
  const channels = new ChannelRepo(db, {
    workspacesRoot: join(tmpdir(), 'silverhand-msg-test'),
  });
  const sessions = new SessionRepo(db);
  const ch = channels.insert({
    name: 'msg-ch',
    description: null,
    kind: 'regular',
    workspace_path: channels.workspacePathFor('msg-ch'),
    workspace_host_id: localHostId,
    dm_agent_id: null,
  });
  const sess = sessions.insert({ channelId: ch.id, title: 't' });
  const agent = new AgentRepo(db).create({ name: 'a', runtime: 'claude' }, localHostId);
  return { db, sess, agentId: agent.id };
}

describe('MessageRepo', () => {
  it('insert assigns monotonically increasing seq within a session', () => {
    const { db, sess, agentId } = bootstrapSession();
    const repo = new MessageRepo(db);

    const m1 = repo.insert({
      sessionId: sess.id,
      fromKind: 'user',
      content: 'hello',
    });
    const m2 = repo.insert({
      sessionId: sess.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'hi',
    });
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
  });

  it('seq counters are independent per session', () => {
    const { db, sess } = bootstrapSession();
    const sessions = new SessionRepo(db);
    const sess2 = sessions.insert({ channelId: sess.channel_id, title: 't2' });
    const repo = new MessageRepo(db);

    const a = repo.insert({ sessionId: sess.id, fromKind: 'user', content: '1' });
    const b = repo.insert({ sessionId: sess2.id, fromKind: 'user', content: '1' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
  });

  it('round-trips JSON metadata', () => {
    const { db, sess } = bootstrapSession();
    const repo = new MessageRepo(db);
    const m = repo.insert({
      sessionId: sess.id,
      fromKind: 'system',
      content: 'event',
      metadata: { tool: 'spawn_child_session', ok: true, count: 3 },
    });
    expect(m.metadata).toEqual({
      tool: 'spawn_child_session',
      ok: true,
      count: 3,
    });
    expect(repo.getById(m.id)?.metadata).toEqual(m.metadata);
  });

  it('listForSession returns the latest limited window in seq ASC', () => {
    const { db, sess } = bootstrapSession();
    const repo = new MessageRepo(db);
    for (let i = 0; i < 5; i++) {
      repo.insert({ sessionId: sess.id, fromKind: 'user', content: `m${i}` });
    }
    const all = repo.listForSession(sess.id);
    expect(all.map(m => m.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);

    const tail = repo.listForSession(sess.id, 2);
    expect(tail.map(m => m.content)).toEqual(['m3', 'm4']);
  });

  it('listWindowForSession pages earlier messages and reports has_more_before', () => {
    const { db, sess } = bootstrapSession();
    const repo = new MessageRepo(db);
    for (let i = 0; i < 5; i++) {
      repo.insert({ sessionId: sess.id, fromKind: 'user', content: `m${i}` });
    }

    const latest = repo.listWindowForSession(sess.id, { limit: 2 });
    expect(latest.messages.map(m => m.content)).toEqual(['m3', 'm4']);
    expect(latest.has_more_before).toBe(true);

    const earlier = repo.listWindowForSession(sess.id, {
      limit: 2,
      beforeSeq: latest.messages[0]!.seq,
    });
    expect(earlier.messages.map(m => m.content)).toEqual(['m1', 'm2']);
    expect(earlier.has_more_before).toBe(true);

    const oldest = repo.listWindowForSession(sess.id, {
      limit: 2,
      beforeSeq: earlier.messages[0]!.seq,
    });
    expect(oldest.messages.map(m => m.content)).toEqual(['m0']);
    expect(oldest.has_more_before).toBe(false);
  });

  it('null metadata round-trips as null, not as the string "null"', () => {
    const { db, sess } = bootstrapSession();
    const repo = new MessageRepo(db);
    const m = repo.insert({
      sessionId: sess.id,
      fromKind: 'user',
      content: 'no meta',
    });
    expect(m.metadata).toBeNull();
  });
});
