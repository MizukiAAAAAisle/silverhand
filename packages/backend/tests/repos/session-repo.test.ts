import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildSessionLimits } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ChannelRepo } from '../../src/repos/channel-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import {
  SessionRepo,
  type SpawnLimitContext,
} from '../../src/repos/session-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const channels = new ChannelRepo(db, {
    workspacesRoot: join(tmpdir(), 'silverhand-sess-test'),
  });
  const ch = channels.insert({
    name: 'sess-ch',
    description: null,
    kind: 'regular',
    workspace_path: channels.workspacePathFor('sess-ch'),
    workspace_host_id: localHostId,
    dm_agent_id: null,
  });
  const sessions = new SessionRepo(db);
  const agents = new AgentRepo(db);
  // create a few real agents so FK-constrained tests can reference them by id
  const agentA = agents.create({ name: 'a', runtime: 'claude' }, localHostId);
  const agentB = agents.create({ name: 'b', runtime: 'claude' }, localHostId);
  const agentC = agents.create({ name: 'c', runtime: 'claude' }, localHostId);
  return { db, ch, sessions, agents: { a: agentA.id, b: agentB.id, c: agentC.id } };
}

function makeSpawnCtx(limits: Partial<ChildSessionLimits> = {}): SpawnLimitContext {
  return {
    limits: {
      max_concurrent_per_parent: null,
      spawn_cooldown_seconds: null,
      max_depth: 1,
      ...limits,
    },
    lastSpawnAtByAgent: new Map(),
  };
}

describe('SessionRepo: basic CRUD', () => {
  it('insert + get + list orders by updated_at DESC', () => {
    const { ch, sessions, db } = bootstrap();
    const a = sessions.insert({ channelId: ch.id, title: 'a' });
    db.prepare(`UPDATE sessions SET updated_at = updated_at - 1000 WHERE id = ?`).run(
      a.id,
    );
    const b = sessions.insert({ channelId: ch.id, title: 'b' });

    expect(sessions.get(a.id)?.title).toBe('a');
    expect(sessions.list().map(s => s.id)).toEqual([b.id, a.id]);
  });

  it('listForChannel orders parents first, then children grouped by parent', () => {
    const { ch, sessions } = bootstrap();
    const p1 = sessions.insert({ channelId: ch.id, title: 'p1' });
    const p2 = sessions.insert({ channelId: ch.id, title: 'p2' });
    const c1 = sessions.insert({
      channelId: ch.id,
      title: 'c1',
      parentSessionId: p1.id,
    });
    const c2 = sessions.insert({
      channelId: ch.id,
      title: 'c2',
      parentSessionId: p2.id,
    });

    const list = sessions.listForChannel(ch.id);
    // parents come first, in created_at order
    expect(list.slice(0, 2).map(s => s.id)).toEqual([p1.id, p2.id]);
    // children come after — both present, and each parent's index < its child's
    const idx = (id: string) => list.findIndex(s => s.id === id);
    expect(idx(c1.id)).toBeGreaterThan(idx(p1.id));
    expect(idx(c2.id)).toBeGreaterThan(idx(p2.id));
    expect(idx(c1.id)).toBeGreaterThanOrEqual(2);
    expect(idx(c2.id)).toBeGreaterThanOrEqual(2);
  });

  it('close marks status=archived + sets close_summary, listChildren works', () => {
    const { ch, sessions } = bootstrap();
    const p = sessions.insert({ channelId: ch.id, title: 'p' });
    const c = sessions.insert({
      channelId: ch.id,
      title: 'c',
      parentSessionId: p.id,
    });

    expect(sessions.listChildren(p.id).map(s => s.id)).toEqual([c.id]);

    const closed = sessions.close(c.id, 'done');
    expect(closed?.status).toBe('archived');
    expect(closed?.close_summary).toBe('done');
    expect(closed?.closed_at).not.toBeNull();
  });
});

describe('SessionRepo: child session validation', () => {
  it('rejects child of unknown parent', () => {
    const { ch, sessions } = bootstrap();
    expect(() =>
      sessions.insert({
        channelId: ch.id,
        title: 'child',
        parentSessionId: 'nonexistent',
      }),
    ).toThrowError(/parent session not found/);
  });

  it('rejects nesting beyond depth 1 (no grandchildren)', () => {
    const { ch, sessions } = bootstrap();
    const p = sessions.insert({ channelId: ch.id, title: 'p' });
    const c = sessions.insert({
      channelId: ch.id,
      title: 'c',
      parentSessionId: p.id,
    });
    expect(() =>
      sessions.insert({
        channelId: ch.id,
        title: 'grand',
        parentSessionId: c.id,
      }),
    ).toThrowError(/max_depth = 1/);
  });

  it('rejects child of a closed parent', () => {
    const { ch, sessions } = bootstrap();
    const p = sessions.insert({ channelId: ch.id, title: 'p' });
    sessions.close(p.id, 'wrap');
    expect(() =>
      sessions.insert({
        channelId: ch.id,
        title: 'late',
        parentSessionId: p.id,
      }),
    ).toThrowError(/parent session is closed/);
  });

  it('rejects child whose channel differs from parent channel', () => {
    const { db, ch, sessions } = bootstrap();
    // create a second channel
    const channels = new ChannelRepo(db, {
      workspacesRoot: join(tmpdir(), 'silverhand-sess-test'),
    });
    const ch2 = channels.insert({
      name: 'other',
      description: null,
      kind: 'regular',
      workspace_path: channels.workspacePathFor('other'),
      workspace_host_id: ch.workspace_host_id,
      dm_agent_id: null,
    });
    const p = sessions.insert({ channelId: ch.id, title: 'p' });

    expect(() =>
      sessions.insert({
        channelId: ch2.id,
        title: 'cross',
        parentSessionId: p.id,
      }),
    ).toThrowError(/same channel as its parent/);
  });
});

describe('SessionRepo: spawn limits', () => {
  it('enforces max_concurrent_per_parent (closed children do not count)', () => {
    const { ch, sessions, agents } = bootstrap();
    const p = sessions.insert({ channelId: ch.id, title: 'p' });
    const ctx = makeSpawnCtx({ max_concurrent_per_parent: 2 });

    const c1 = sessions.insert({
      channelId: ch.id,
      title: 'c1',
      parentSessionId: p.id,
      spawnedByAgentId: agents.a,
      spawnCtx: ctx,
    });
    sessions.insert({
      channelId: ch.id,
      title: 'c2',
      parentSessionId: p.id,
      spawnedByAgentId: agents.a,
      spawnCtx: ctx,
    });
    expect(() =>
      sessions.insert({
        channelId: ch.id,
        title: 'c3',
        parentSessionId: p.id,
        spawnedByAgentId: agents.a,
        spawnCtx: ctx,
      }),
    ).toThrowError(/child session limit reached: 2\/2/);

    // closing one child must free up a slot
    sessions.close(c1.id, 'done');
    const c3 = sessions.insert({
      channelId: ch.id,
      title: 'c3',
      parentSessionId: p.id,
      spawnedByAgentId: agents.a,
      spawnCtx: ctx,
    });
    expect(c3.title).toBe('c3');
  });

  it('enforces spawn cooldown per spawning agent and updates last-spawn timestamp', () => {
    const { ch, sessions, agents } = bootstrap();
    const p = sessions.insert({ channelId: ch.id, title: 'p' });
    const ctx = makeSpawnCtx({ spawn_cooldown_seconds: 60 });

    sessions.insert({
      channelId: ch.id,
      title: 'c1',
      parentSessionId: p.id,
      spawnedByAgentId: agents.a,
      spawnCtx: ctx,
    });
    expect(ctx.lastSpawnAtByAgent.has(agents.a)).toBe(true);

    expect(() =>
      sessions.insert({
        channelId: ch.id,
        title: 'c2',
        parentSessionId: p.id,
        spawnedByAgentId: agents.a,
        spawnCtx: ctx,
      }),
    ).toThrowError(/spawn cooldown active/);

    // a different agent should not be blocked by agent-a's cooldown
    const c3 = sessions.insert({
      channelId: ch.id,
      title: 'c3',
      parentSessionId: p.id,
      spawnedByAgentId: agents.b,
      spawnCtx: ctx,
    });
    expect(c3.title).toBe('c3');
  });

  it('skips cooldown check when spawnedByAgentId is missing', () => {
    const { ch, sessions } = bootstrap();
    const p = sessions.insert({ channelId: ch.id, title: 'p' });
    const ctx = makeSpawnCtx({ spawn_cooldown_seconds: 60 });

    sessions.insert({
      channelId: ch.id,
      title: 'c1',
      parentSessionId: p.id,
      spawnCtx: ctx,
    });
    sessions.insert({
      channelId: ch.id,
      title: 'c2',
      parentSessionId: p.id,
      spawnCtx: ctx,
    });
    // no throw
  });
});

describe('SessionRepo: session_agents', () => {
  it('addAgent is idempotent (INSERT OR IGNORE)', () => {
    const { ch, sessions, agents } = bootstrap();
    const s = sessions.insert({ channelId: ch.id, title: 's' });
    sessions.addAgent(s.id, agents.a);
    sessions.addAgent(s.id, agents.a);
    expect(sessions.listAgents(s.id)).toHaveLength(1);
  });

  it('updateAgentRuntime patches only specified fields, returns updated row', () => {
    const { ch, sessions, agents } = bootstrap();
    const s = sessions.insert({ channelId: ch.id, title: 's' });
    sessions.addAgent(s.id, agents.a);

    const updated = sessions.updateAgentRuntime(s.id, agents.a, {
      status: 'starting',
      pid: 1234,
      cliSessionId: 'cli-xyz',
    });
    expect(updated?.status).toBe('starting');
    expect(updated?.pid).toBe(1234);
    expect(updated?.cli_session_id).toBe('cli-xyz');

    const partial = sessions.updateAgentRuntime(s.id, agents.a, {
      status: 'active',
    });
    expect(partial?.status).toBe('active');
    expect(partial?.pid).toBe(1234);
    expect(partial?.cli_session_id).toBe('cli-xyz');
  });

  it('updateAgentRuntime with no fields returns the current row unchanged', () => {
    const { ch, sessions, agents } = bootstrap();
    const s = sessions.insert({ channelId: ch.id, title: 's' });
    sessions.addAgent(s.id, agents.a);
    const before = sessions.getAgent(s.id, agents.a);
    const after = sessions.updateAgentRuntime(s.id, agents.a, {});
    expect(after).toEqual(before);
  });

  it('listLiveStatusAgents returns only starting/active rows across sessions', () => {
    const { ch, sessions, agents } = bootstrap();
    const s1 = sessions.insert({ channelId: ch.id, title: 's1' });
    const s2 = sessions.insert({ channelId: ch.id, title: 's2' });

    sessions.addAgent(s1.id, agents.a);
    sessions.addAgent(s1.id, agents.b);
    sessions.addAgent(s2.id, agents.c);

    sessions.updateAgentRuntime(s1.id, agents.a, { status: 'starting' });
    sessions.updateAgentRuntime(s1.id, agents.b, { status: 'crashed' });
    sessions.updateAgentRuntime(s2.id, agents.c, { status: 'active' });

    const live = sessions.listLiveStatusAgents();
    expect(live.map(r => r.agent_id).sort()).toEqual([agents.a, agents.c].sort());
  });

  it('removeAgent deletes only the targeted row', () => {
    const { ch, sessions, agents } = bootstrap();
    const s = sessions.insert({ channelId: ch.id, title: 's' });
    sessions.addAgent(s.id, agents.a);
    sessions.addAgent(s.id, agents.b);
    sessions.removeAgent(s.id, agents.a);
    expect(sessions.listAgents(s.id).map(r => r.agent_id)).toEqual([agents.b]);
  });
});

describe('SessionRepo: listOpenThreadsForParent', () => {
  function makeThreadChild(
    sessions: SessionRepo,
    messages: MessageRepo,
    parentId: string,
    channelId: string,
    anchorMessageId: string,
  ) {
    const child = sessions.insert({
      channelId,
      title: 'thread',
      parentSessionId: parentId,
    });
    messages.insert({
      sessionId: child.id,
      fromKind: 'system',
      content: 'anchor',
      metadata: { subtype: 'thread_anchor', quoted_message_id: anchorMessageId },
    });
    messages.insert({
      sessionId: child.id,
      fromKind: 'system',
      content: 'onboarding',
      metadata: { subtype: 'onboarding' },
    });
    return child;
  }

  it('returns one row per open thread with reply_count = non-system messages', () => {
    const { db, ch, sessions } = bootstrap();
    const messages = new MessageRepo(db);
    const parent = sessions.insert({ channelId: ch.id, title: 'parent' });
    const anchor1 = messages.insert({
      sessionId: parent.id,
      fromKind: 'user',
      content: 'topic A',
    });
    const anchor2 = messages.insert({
      sessionId: parent.id,
      fromKind: 'user',
      content: 'topic B',
    });
    const t1 = makeThreadChild(sessions, messages, parent.id, ch.id, anchor1.id);
    const t2 = makeThreadChild(sessions, messages, parent.id, ch.id, anchor2.id);
    // t1 has 2 real replies (1 user + 1 agent), t2 has 0
    messages.insert({ sessionId: t1.id, fromKind: 'user', content: 'go' });
    messages.insert({ sessionId: t1.id, fromKind: 'agent', content: 'ack' });

    const summaries = sessions.listOpenThreadsForParent(parent.id);
    const byAnchor = new Map(summaries.map(s => [s.anchor_message_id, s]));

    expect(summaries).toHaveLength(2);
    expect(byAnchor.get(anchor1.id)).toMatchObject({
      child_session_id: t1.id,
      reply_count: 2,
    });
    expect(byAnchor.get(anchor2.id)).toMatchObject({
      child_session_id: t2.id,
      reply_count: 0,
    });
  });

  it('excludes closed threads (so the badge clears once the thread closes)', () => {
    const { db, ch, sessions } = bootstrap();
    const messages = new MessageRepo(db);
    const parent = sessions.insert({ channelId: ch.id, title: 'parent' });
    const anchor = messages.insert({
      sessionId: parent.id,
      fromKind: 'user',
      content: 'q',
    });
    const t = makeThreadChild(sessions, messages, parent.id, ch.id, anchor.id);
    messages.insert({ sessionId: t.id, fromKind: 'user', content: 'r' });
    sessions.close(t.id, 'wrap');

    expect(sessions.listOpenThreadsForParent(parent.id)).toEqual([]);
  });

  it('ignores agent-spawned child sessions (no thread_anchor)', () => {
    const { ch, sessions, agents } = bootstrap();
    const parent = sessions.insert({ channelId: ch.id, title: 'parent' });
    // Agent-spawned child via spawn_child_session has no thread_anchor —
    // it's a child session but not a Thread. Should not appear.
    sessions.insert({
      channelId: ch.id,
      title: 'agent-child',
      parentSessionId: parent.id,
      spawnedByAgentId: agents.a,
    });
    expect(sessions.listOpenThreadsForParent(parent.id)).toEqual([]);
  });

  it('returns empty for parents with no children', () => {
    const { ch, sessions } = bootstrap();
    const parent = sessions.insert({ channelId: ch.id, title: 'lonely' });
    expect(sessions.listOpenThreadsForParent(parent.id)).toEqual([]);
  });
});

describe('SessionRepo: pin / unpin', () => {
  it('pin sets pinned_at, unpin clears it', () => {
    const { ch, sessions } = bootstrap();
    const s = sessions.insert({ channelId: ch.id, title: 'top' });
    expect(s.pinned_at).toBeNull();

    const pinned = sessions.pin(s.id);
    expect(pinned?.pinned_at).toBeTypeOf('number');

    const unpinned = sessions.unpin(s.id);
    expect(unpinned?.pinned_at).toBeNull();
  });

  it('pin returns null for unknown session', () => {
    const { sessions } = bootstrap();
    expect(sessions.pin('nonexistent')).toBeNull();
  });

  it('rejects pin on a child session', () => {
    const { ch, sessions } = bootstrap();
    const parent = sessions.insert({ channelId: ch.id, title: 'parent' });
    const child = sessions.insert({
      channelId: ch.id,
      title: 'child',
      parentSessionId: parent.id,
    });
    expect(() => sessions.pin(child.id)).toThrowError(/only top-level sessions/);
  });

  it('listForChannel returns pinned sessions before unpinned', () => {
    const { ch, sessions } = bootstrap();
    const a = sessions.insert({ channelId: ch.id, title: 'a' });
    const b = sessions.insert({ channelId: ch.id, title: 'b' });
    const c = sessions.insert({ channelId: ch.id, title: 'c' });

    // pin b — it should now appear first
    sessions.pin(b.id);

    const list = sessions.listForChannel(ch.id);
    const ids = list.map(s => s.id);
    expect(ids[0]).toBe(b.id);
    // a and c follow in creation order
    expect(ids.slice(1)).toEqual([a.id, c.id]);
  });

  it('multiple pins ordered by pinned_at ASC (earlier pin appears first)', async () => {
    const { ch, sessions, db } = bootstrap();
    const a = sessions.insert({ channelId: ch.id, title: 'a' });
    const b = sessions.insert({ channelId: ch.id, title: 'b' });

    sessions.pin(a.id);
    // Force a's pinned_at to be earlier than b's by backdating
    db.prepare(`UPDATE sessions SET pinned_at = pinned_at - 1000 WHERE id = ?`).run(a.id);
    sessions.pin(b.id);

    const list = sessions.listForChannel(ch.id);
    const ids = list.map(s => s.id);
    expect(ids[0]).toBe(a.id);
    expect(ids[1]).toBe(b.id);
  });
});
