import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
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
  const agent = new AgentRepo(db).create({ name: 'a', runtime: 'claude' }, localHostId);
  workspaces.addMember(workspace.id, agent.id);
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

    const earlier = repo.listWindowForConversation(channel.id, {
      limit: 2,
      beforeSeq: latest.messages[0]!.seq,
    });
    expect(earlier.messages.map(m => m.content)).toEqual(['m1', 'm2']);
    expect(earlier.has_more_before).toBe(true);

    const oldest = repo.listWindowForConversation(channel.id, {
      limit: 2,
      beforeSeq: earlier.messages[0]!.seq,
    });
    expect(oldest.messages.map(m => m.content)).toEqual(['m0']);
    expect(oldest.has_more_before).toBe(false);
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
