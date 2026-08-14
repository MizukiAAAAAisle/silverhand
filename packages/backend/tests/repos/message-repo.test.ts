import { describe, expect, it } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import {
  AnchorMessageNotInConversationError,
  MessageRepo,
} from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrapConversation() {
  const { db, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db);
  const workspace = workspaces.insert({
    name: 'msg-ws',
    description: null,
  });
  const agent = new AgentRepo(db).create({ name: 'a', runtime: 'claude' }, localHostId, 'local');
  workspaces.insertMembership(workspace.id, agent.id);
  const conversations = new ConversationRepo(db);
  const channel = conversations.insertChannel({
    name: 'ch-1',
    workspaceId: workspace.id,
    title: 't',
  });
  conversations.addAgent(channel.id, agent.id);
  return { db, workspace, channel, agentId: agent.id, conversations };
}

describe('MessageRepo', () => {
  it('insert assigns monotonically increasing seq within a conversation', () => {
    const { db, channel, agentId } = bootstrapConversation();
    const repo = new MessageRepo(db);

    const m1 = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'hello',
    });
    const m2 = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'hi',
    });
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
    expect(
      db.prepare<[string], { latest_message_seq: number }>(
        `SELECT latest_message_seq FROM conversations WHERE id = ?`,
      ).get(channel.id)?.latest_message_seq,
    ).toBe(2);
  });

  it('conditional insert rejects stale seen seq without inserting', () => {
    const { db, channel, agentId } = bootstrapConversation();
    const repo = new MessageRepo(db);

    const observed = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'observed',
    });
    const newer = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'newer',
    });

    const stale = repo.insertForConversationIfFresh({
      conversationId: channel.id,
      seenUpToSeq: observed.seq,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'stale draft',
    });

    expect(stale).toEqual({ ok: false, currentSeq: newer.seq });
    expect(repo.listForConversation(channel.id).map(m => m.content))
      .toEqual(['observed', 'newer']);
    expect(repo.listAfterSeq(channel.id, observed.seq).map(m => m.content))
      .toEqual(['newer']);
  });

  it('conditional insert succeeds when seen seq matches latest', () => {
    const { db, channel, agentId } = bootstrapConversation();
    const repo = new MessageRepo(db);

    const observed = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'observed',
    });

    const fresh = repo.insertForConversationIfFresh({
      conversationId: channel.id,
      seenUpToSeq: observed.seq,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'fresh draft',
    });

    expect(fresh.ok).toBe(true);
    expect(fresh.ok && fresh.message.seq).toBe(2);
    expect(repo.latestSeqForConversation(channel.id)).toBe(2);
  });

  it('seq counters are independent per conversation', () => {
    const { db, workspace, channel, conversations } = bootstrapConversation();
    const channel2 = conversations.insertChannel({
      name: 'ch-2',
      workspaceId: workspace.id,
      title: 't2',
    });
    const repo = new MessageRepo(db);

    const a = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: '1',
    });
    const b = repo.insertForConversation({
      conversationId: channel2.id,
      fromKind: 'user',
      content: '1',
    });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
  });

  it('round-trips JSON metadata', () => {
    const { db, channel } = bootstrapConversation();
    const repo = new MessageRepo(db);
    const m = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      content: 'event',
      metadata: { tool: 'create_thread', ok: true, count: 3 },
    });
    expect(m.metadata).toEqual({
      tool: 'create_thread',
      ok: true,
      count: 3,
    });
    expect(repo.getById(m.id)?.metadata).toEqual(m.metadata);
  });

  it('listForConversation returns the latest limited window in seq ASC', () => {
    const { db, channel } = bootstrapConversation();
    const repo = new MessageRepo(db);
    for (let i = 0; i < 5; i++) {
      repo.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        content: `m${i}`,
      });
    }
    const all = repo.listForConversation(channel.id);
    expect(all.map(m => m.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);

    const tail = repo.listForConversation(channel.id, 2);
    expect(tail.map(m => m.content)).toEqual(['m3', 'm4']);
  });

  it('listWindowForConversation pages earlier messages and reports has_more_before', () => {
    const { db, channel } = bootstrapConversation();
    const repo = new MessageRepo(db);
    for (let i = 0; i < 5; i++) {
      repo.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        content: `m${i}`,
      });
    }

    const latest = repo.listWindowForConversation(channel.id, { limit: 2 });
    expect(latest.messages.map(m => m.content)).toEqual(['m3', 'm4']);
    expect(latest.has_more_before).toBe(true);
    // `latest` mode is by definition at the tail; no probe needed.
    expect(latest.has_more_after).toBe(false);

    const earlier = repo.listWindowForConversation(channel.id, {
      limit: 2,
      beforeSeq: latest.messages[0]!.seq,
    });
    expect(earlier.messages.map(m => m.content)).toEqual(['m1', 'm2']);
    expect(earlier.has_more_before).toBe(true);
    // before_seq window must report newer rows exist beyond it.
    expect(earlier.has_more_after).toBe(true);

    const oldest = repo.listWindowForConversation(channel.id, {
      limit: 2,
      beforeSeq: earlier.messages[0]!.seq,
    });
    expect(oldest.messages.map(m => m.content)).toEqual(['m0']);
    expect(oldest.has_more_before).toBe(false);
    expect(oldest.has_more_after).toBe(true);
  });

  it('listWindowForConversation supports after_seq for forward paging', () => {
    const { db, channel } = bootstrapConversation();
    const repo = new MessageRepo(db);
    for (let i = 0; i < 5; i++) {
      repo.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        content: `m${i}`,
      });
    }

    // Start from the oldest (seq=1) and walk forward in pages of 2.
    const first = repo.listWindowForConversation(channel.id, {
      limit: 2,
      afterSeq: 1,
    });
    expect(first.messages.map(m => m.content)).toEqual(['m1', 'm2']);
    expect(first.has_more_before).toBe(true);
    expect(first.has_more_after).toBe(true);

    const second = repo.listWindowForConversation(channel.id, {
      limit: 2,
      afterSeq: first.messages[1]!.seq,
    });
    expect(second.messages.map(m => m.content)).toEqual(['m3', 'm4']);
    expect(second.has_more_before).toBe(true);
    // Reached the tail — nothing beyond seq=5.
    expect(second.has_more_after).toBe(false);
  });

  it('listWindowForConversation centers a window around a message id', () => {
    const { db, channel } = bootstrapConversation();
    const repo = new MessageRepo(db);
    const inserted: string[] = [];
    for (let i = 0; i < 9; i++) {
      const m = repo.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        content: `m${i}`,
      });
      inserted.push(m.id);
    }
    // limit=5 around m4 → 2 before + anchor + 2 after = m2..m6.
    const around = repo.listWindowForConversation(channel.id, {
      limit: 5,
      aroundMessageId: inserted[4]!,
    });
    expect(around.messages.map(m => m.content)).toEqual([
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
    ]);
    expect(around.has_more_before).toBe(true);
    expect(around.has_more_after).toBe(true);

    // Around the very first message: no rows before, fills with after.
    const aroundFirst = repo.listWindowForConversation(channel.id, {
      limit: 5,
      aroundMessageId: inserted[0]!,
    });
    expect(aroundFirst.messages[0]!.content).toBe('m0');
    expect(aroundFirst.has_more_before).toBe(false);
    expect(aroundFirst.has_more_after).toBe(true);

    // Around the very last message: no rows after, fills with before.
    const aroundLast = repo.listWindowForConversation(channel.id, {
      limit: 5,
      aroundMessageId: inserted[8]!,
    });
    expect(aroundLast.messages.at(-1)!.content).toBe('m8');
    expect(aroundLast.has_more_before).toBe(true);
    expect(aroundLast.has_more_after).toBe(false);
  });

  it('listWindowForConversation throws when around_message_id is not in this conversation', () => {
    const { db, workspace, channel, conversations } = bootstrapConversation();
    const channel2 = conversations.insertChannel({
      name: 'ch-3',
      workspaceId: workspace.id,
      title: 't2',
    });
    const repo = new MessageRepo(db);
    const own = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'own',
    });
    const stranger = repo.insertForConversation({
      conversationId: channel2.id,
      fromKind: 'user',
      content: 'stranger',
    });

    // Anchor in the same conversation works …
    expect(
      repo.listWindowForConversation(channel.id, {
        limit: 5,
        aroundMessageId: own.id,
      }).messages.map(m => m.content),
    ).toEqual(['own']);

    // … but a sibling conversation's id throws (route maps to 404).
    expect(() =>
      repo.listWindowForConversation(channel.id, {
        limit: 5,
        aroundMessageId: stranger.id,
      }),
    ).toThrow(AnchorMessageNotInConversationError);

    // Bogus message ids also throw — same channel-not-found bucket.
    expect(() =>
      repo.listWindowForConversation(channel.id, {
        limit: 5,
        aroundMessageId: 'no-such-message',
      }),
    ).toThrow(AnchorMessageNotInConversationError);
  });

  it('listWindowForConversation rejects 2+ anchors at once', () => {
    const { db, channel } = bootstrapConversation();
    const repo = new MessageRepo(db);
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'm0',
    });

    expect(() =>
      repo.listWindowForConversation(channel.id, {
        limit: 5,
        beforeSeq: 1,
        afterSeq: 0,
      }),
    ).toThrow(/mutually exclusive/);
  });

  it('projects linked_task (with assignee display name) for a task source message', () => {
    const { db, workspace, channel, agentId } = bootstrapConversation();
    new AgentRepo(db).update(agentId, { display_name: 'Cindy' });
    const repo = new MessageRepo(db);
    const msg = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'please handle this',
    });
    // A task is a first-class `tasks` row LINKED to the message via
    // source_message_id — not flat task_* columns on the message.
    db.prepare(
      `INSERT INTO tasks (
         id, workspace_id, board_key, task_number, conversation_id, thread_root_id,
         title, content, status, assignee_agent_id, assignee_user_id,
         creator_kind, creator_agent_id, creator_user_id,
         source_message_id, created_event_message_id,
         last_editor_kind, last_editor_id, last_edited_at,
         created_at, closed_at
       ) VALUES (
         'task_1', ?, 'ws:' || ?, 1, ?, NULL,
         'please handle this', '', 'in_progress', ?, NULL,
         'agent', ?, NULL,
         ?, NULL,
         NULL, NULL, NULL,
         1, NULL
       )`,
    ).run(workspace.id, workspace.id, channel.id, agentId, agentId, msg.id);

    const listed = repo.listForConversation(channel.id);
    expect(listed[0]?.linked_task).toMatchObject({
      task_id: 'task_1',
      task_number: 1,
      status: 'in_progress',
      assignee: { type: 'agent', id: agentId, name: 'Cindy' },
    });
    expect(repo.getById(msg.id)?.linked_task?.assignee?.name).toBe('Cindy');
  });

  it('null metadata round-trips as null, not as the string "null"', () => {
    const { db, channel } = bootstrapConversation();
    const repo = new MessageRepo(db);
    const m = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'no meta',
    });
    expect(m.metadata).toBeNull();
  });
});

describe('MessageRepo per-stream freshness (v43 reply cluster)', () => {
  function latestMessageSeq(db: any, convId: string): number {
    return db
      .prepare('SELECT latest_message_seq FROM conversations WHERE id = ?')
      .get(convId).latest_message_seq as number;
  }
  function streamHead(
    db: any,
    convId: string,
    root: string | null,
  ): number | null {
    const row = db
      .prepare(
        `SELECT latest_seq FROM conversation_stream_heads
          WHERE conversation_id = ? AND thread_root_id IS ?`,
      )
      .get(convId, root);
    return row ? (row.latest_seq as number) : null;
  }

  it('a reply lands in the thread stream rooted at the target message', () => {
    const { db, channel } = bootstrapConversation();
    const repo = new MessageRepo(db);
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'root',
    });
    const reply = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'reply',
      threadRootId: root.id,
    });
    expect(root.thread_root_id).toBeNull();
    expect(reply.thread_root_id).toBe(root.id);
    // seq stays conversation-global / monotonic regardless of stream
    expect(reply.seq).toBe(2);
    // main head advanced by the root; thread head by the reply
    expect(streamHead(db, channel.id, null)).toBe(1);
    expect(streamHead(db, channel.id, root.id)).toBe(2);
  });

  it('a thread accumulates multiple replies under one root head', () => {
    const { db, channel } = bootstrapConversation();
    const repo = new MessageRepo(db);
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'root',
    });
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'r1',
      threadRootId: root.id,
    });
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'r2',
      threadRootId: root.id,
    });
    expect(streamHead(db, channel.id, root.id)).toBe(3);
    expect(streamHead(db, channel.id, null)).toBe(1);
    expect(
      repo
        .listStreamWindowMeta(channel.id, root.id, 0, streamHead(db, channel.id, root.id)!)
        .map(m => m.seq),
    ).toEqual([2, 3]);
    expect(
      repo
        .listStreamWindowMeta(channel.id, null, 0, streamHead(db, channel.id, null)!)
        .map(m => m.seq),
    ).toEqual([1]);
  });

  it('freshness-exempt rows stay out of the CAS universe; delivery past them still passes (§5.2)', () => {
    const { db, channel, agentId } = bootstrapConversation();
    const repo = new MessageRepo(db);
    const seen = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'normal head',
    });
    expect(streamHead(db, channel.id, null)).toBe(seen.seq);

    // Exempt row (e.g. schedule_fire): allocates a seq but must NOT bump
    // the head — agents that never receive it are not CAS-blocked on it.
    const exempt = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      content: 'owner self-wake',
      freshnessExempt: true,
    });
    expect(exempt.seq).toBeGreaterThan(seen.seq);
    expect(streamHead(db, channel.id, null)).toBe(seen.seq);

    // An agent that saw only the normal head passes the CAS…
    const r1 = repo.insertForConversationIfFresh({
      conversationId: channel.id,
      seenUpToSeq: seen.seq,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'send with head boundary',
    });
    expect(r1.ok).toBe(true);

    // …and the exempt row's own recipient, whose observed advanced PAST
    // the head (seen = exempt.seq > head), must also pass — the CAS is
    // `head <= seen`, not strict equality.
    const exempt2 = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      content: 'second self-wake',
      freshnessExempt: true,
    });
    const r2 = repo.insertForConversationIfFresh({
      conversationId: channel.id,
      seenUpToSeq: exempt2.seq,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'owner send after wake',
    });
    expect(r2.ok).toBe(true);

    // The guard itself stays armed: a boundary below the head still stales.
    const r3 = repo.insertForConversationIfFresh({
      conversationId: channel.id,
      seenUpToSeq: seen.seq - 1,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'stale send',
    });
    expect(r3.ok).toBe(false);

    // Cindy arm 3: once a RELEVANT row moves the head past the exempt seq
    // (r2's own send did — head is now r2.seq > exempt2.seq), a boundary
    // stuck at the exempt seq stales again — the relaxation never disarms
    // the CAS for freshness-relevant content.
    if (!r2.ok) throw new Error('unreachable');
    expect(streamHead(db, channel.id, null)).toBe(r2.message.seq);
    const r4 = repo.insertForConversationIfFresh({
      conversationId: channel.id,
      seenUpToSeq: exempt2.seq,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'stale after relevant row',
    });
    expect(r4.ok).toBe(false);
    if (r4.ok) throw new Error('unreachable');
    expect(r4.currentSeq).toBe(r2.message.seq);
  });

  it('thread first reply (seen=0) succeeds even though the main head exists', () => {
    const { db, channel, agentId } = bootstrapConversation();
    const repo = new MessageRepo(db);
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'root',
    });
    const res = repo.insertForConversationIfFresh({
      conversationId: channel.id,
      seenUpToSeq: 0,
      threadRootId: root.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'first reply',
    });
    expect(res.ok).toBe(true);
    expect(res.ok && res.message.thread_root_id).toBe(root.id);
    expect(streamHead(db, channel.id, root.id)).toBe(2);
  });

  it('a thread reply does not make a main-line CAS stale (cross-stream isolation)', () => {
    const { db, channel, agentId } = bootstrapConversation();
    const repo = new MessageRepo(db);
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'root',
    });
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'reply',
      threadRootId: root.id,
    });
    // an agent that observed the main line up to seq 1 can still post there
    const res = repo.insertForConversationIfFresh({
      conversationId: channel.id,
      seenUpToSeq: 1,
      threadRootId: null,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'main reply',
    });
    expect(res.ok).toBe(true);
    expect(res.ok && res.message.seq).toBe(3);
    expect(streamHead(db, channel.id, null)).toBe(3);
  });

  it('a CAS miss rolls back the global allocator (no burned seq)', () => {
    const { db, channel, agentId } = bootstrapConversation();
    const repo = new MessageRepo(db);
    const observed = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'observed',
    });
    const newer = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'newer',
    });
    const before = latestMessageSeq(db, channel.id);
    const res = repo.insertForConversationIfFresh({
      conversationId: channel.id,
      seenUpToSeq: observed.seq,
      threadRootId: null,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'stale',
    });
    expect(res).toEqual({ ok: false, currentSeq: newer.seq });
    expect(latestMessageSeq(db, channel.id)).toBe(before);
  });

  it('seen>0 with a missing thread head is stale, never a wrongful insert', () => {
    const { db, channel, agentId } = bootstrapConversation();
    const repo = new MessageRepo(db);
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'root',
    });
    const before = latestMessageSeq(db, channel.id);
    const res = repo.insertForConversationIfFresh({
      conversationId: channel.id,
      seenUpToSeq: 5,
      threadRootId: root.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'phantom reply',
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.currentSeq).toBe(0);
    expect(streamHead(db, channel.id, root.id)).toBeNull();
    expect(latestMessageSeq(db, channel.id)).toBe(before);
  });

  it('concurrent thread first replies: the second seen=0 loses and is stale', () => {
    const { db, channel, agentId } = bootstrapConversation();
    const repo = new MessageRepo(db);
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'root',
    });
    const first = repo.insertForConversationIfFresh({
      conversationId: channel.id,
      seenUpToSeq: 0,
      threadRootId: root.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'first',
    });
    expect(first.ok).toBe(true);
    const before = latestMessageSeq(db, channel.id);
    const second = repo.insertForConversationIfFresh({
      conversationId: channel.id,
      seenUpToSeq: 0,
      threadRootId: root.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'second',
    });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.currentSeq).toBe(2);
    expect(latestMessageSeq(db, channel.id)).toBe(before);
  });
});

describe('v43 derived-table root-valid triggers', () => {
  function twoChannels() {
    const { db, workspace, channel, conversations } = bootstrapConversation();
    const channel2 = conversations.insertChannel({
      name: 'ch-4',
      workspaceId: workspace.id,
      title: 't2',
    });
    const repo = new MessageRepo(db);
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'root',
    });
    const reply = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'reply',
      threadRootId: root.id,
    });
    return { db, channel, channel2, repo, root, reply };
  }

  function insertFollower(
    db: any,
    threadRootId: string,
    conversationId: string,
  ): void {
    db.prepare(
      `INSERT INTO thread_followers
         (thread_root_id, conversation_id, principal_kind, principal_id, followed_at, source)
       VALUES (?, ?, 'agent', 'a1', 0, 'manual')`,
    ).run(threadRootId, conversationId);
  }
  function insertHead(
    db: any,
    conversationId: string,
    threadRootId: string,
  ): void {
    db.prepare(
      `INSERT INTO conversation_stream_heads
         (conversation_id, thread_root_id, latest_seq)
       VALUES (?, ?, 1)`,
    ).run(conversationId, threadRootId);
  }

  it('thread_followers rejects a root from another conversation', () => {
    const { db, channel2, root } = twoChannels();
    expect(() => insertFollower(db, root.id, channel2.id)).toThrow(
      /same conversation/,
    );
  });

  it('thread_followers rejects a nested root (root that is itself a reply)', () => {
    const { db, channel, reply } = twoChannels();
    expect(() => insertFollower(db, reply.id, channel.id)).toThrow(
      /must not itself be a reply/,
    );
  });

  it('thread_followers accepts a valid same-conversation root', () => {
    const { db, channel, root } = twoChannels();
    expect(() => insertFollower(db, root.id, channel.id)).not.toThrow();
  });

  it('conversation_stream_heads rejects a root from another conversation', () => {
    const { db, channel2, root } = twoChannels();
    expect(() => insertHead(db, channel2.id, root.id)).toThrow(
      /same conversation/,
    );
  });

  it('conversation_stream_heads rejects a nested root', () => {
    const { db, channel, reply } = twoChannels();
    expect(() => insertHead(db, channel.id, reply.id)).toThrow(
      /must not itself be a reply/,
    );
  });

  it('messages rejects turning a root with replies into a reply', () => {
    const { db, channel, repo, root } = twoChannels();
    // a second valid root to point at — so the children-check, not the
    // root-valid checks, is what rejects the transition.
    const otherRoot = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'other root',
    });
    expect(() =>
      db
        .prepare(`UPDATE messages SET thread_root_id = ? WHERE id = ?`)
        .run(otherRoot.id, root.id),
    ).toThrow(/existing replies/);
  });
});
