import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const workspaces = new WorkspaceRepo(db, {
    workspacesRoot: join(tmpdir(), 'silverhand-msg-test'),
  });
  const workspacePath = workspaces.workspacePathFor('msg-ws');
  const workspace = workspaces.insert({
    name: 'msg-ws',
    description: null,
    workspacePath,
    workspaceHostId: localHostId,
  });
  const agent = new AgentRepo(db).create({ name: 'a', runtime: 'claude' }, localHostId, 'local');
  workspaces.insertMembership(workspace.id, agent.id);
  const conversations = new ConversationRepo(db);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath,
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
      workspaceId: workspace.id,
      workspacePath: workspace.workspace_path,
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
      workspaceId: workspace.id,
      workspacePath: workspace.workspace_path,
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

  it('hydrates task assignee display names when reading messages', () => {
    const { db, workspace, channel, agentId } = bootstrapConversation();
    new AgentRepo(db).update(agentId, { display_name: 'Cindy' });
    const repo = new MessageRepo(db);
    const msg = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'please handle this',
    });
    db.prepare(
      `UPDATE messages
          SET task_number = 1,
              task_status = 'in_progress',
              task_title = 'please handle this',
              task_workspace_id = ?,
              task_assignee_agent_id = ?
        WHERE id = ?`,
    ).run(workspace.id, agentId, msg.id);

    const listed = repo.listForConversation(channel.id);
    expect(listed[0]?.task_assignee).toMatchObject({
      type: 'agent',
      id: agentId,
      name: 'Cindy',
    });
    expect(repo.getById(msg.id)?.task_assignee?.name).toBe('Cindy');
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
