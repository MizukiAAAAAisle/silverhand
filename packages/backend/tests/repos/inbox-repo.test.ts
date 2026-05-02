import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ChannelRepo } from '../../src/repos/channel-repo.js';
import { InboxRepo } from '../../src/repos/inbox-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { SessionRepo } from '../../src/repos/session-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const channels = new ChannelRepo(db, {
    workspacesRoot: join(tmpdir(), 'silverhand-inbox-test'),
  });
  const ch = channels.insert({
    name: 'inbox-ch',
    description: null,
    kind: 'regular',
    workspace_path: channels.workspacePathFor('inbox-ch'),
    workspace_host_id: localHostId,
    dm_agent_id: null,
  });
  const sessions = new SessionRepo(db);
  const sess = sessions.insert({ channelId: ch.id, title: 's' });
  const messages = new MessageRepo(db);
  const inbox = new InboxRepo(db);
  const agents = new AgentRepo(db);
  const a = agents.create({ name: 'a', runtime: 'claude' }, localHostId);
  const b = agents.create({ name: 'b', runtime: 'claude' }, localHostId);
  return { db, sess, messages, inbox, agentA: a.id, agentB: b.id };
}

describe('InboxRepo', () => {
  it('listPending joins messages and returns them in enqueue (id ASC) order', () => {
    const { sess, messages, inbox, agentA } = bootstrap();
    const m1 = messages.insert({ sessionId: sess.id, fromKind: 'user', content: 'first' });
    const m2 = messages.insert({ sessionId: sess.id, fromKind: 'user', content: 'second' });

    inbox.enqueue(sess.id, agentA, m1.id);
    inbox.enqueue(sess.id, agentA, m2.id);

    const pending = inbox.listPending(sess.id, agentA);
    expect(pending.map(p => p.message.content)).toEqual(['first', 'second']);
    // joined fields available
    expect(pending[0]!.message.session_id).toBe(sess.id);
    expect(typeof pending[0]!.inboxId).toBe('number');
  });

  it('isolates inboxes per (session, agent) pair', () => {
    const { sess, messages, inbox, agentA, agentB } = bootstrap();
    const m = messages.insert({ sessionId: sess.id, fromKind: 'user', content: 'x' });
    inbox.enqueue(sess.id, agentA, m.id);

    expect(inbox.listPending(sess.id, agentA)).toHaveLength(1);
    expect(inbox.listPending(sess.id, agentB)).toHaveLength(0);
  });

  it('markDelivered removes items from listPending; empty input is a no-op', () => {
    const { sess, messages, inbox, agentA } = bootstrap();
    const m1 = messages.insert({ sessionId: sess.id, fromKind: 'user', content: '1' });
    const m2 = messages.insert({ sessionId: sess.id, fromKind: 'user', content: '2' });
    inbox.enqueue(sess.id, agentA, m1.id);
    inbox.enqueue(sess.id, agentA, m2.id);

    inbox.markDelivered([]); // no-op should not throw
    expect(inbox.listPending(sess.id, agentA)).toHaveLength(2);

    const ids = inbox.listPending(sess.id, agentA).map(p => p.inboxId);
    inbox.markDelivered([ids[0]!]);
    const remaining = inbox.listPending(sess.id, agentA);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.message.content).toBe('2');
  });
});
