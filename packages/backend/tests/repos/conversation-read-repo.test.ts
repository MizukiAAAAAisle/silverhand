import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db, {
    workspacesRoot: join(tmpdir(), 'silverhand-conversation-read-test'),
  });
  const workspacePath = workspaces.workspacePathFor('read-ws');
  const workspace = workspaces.insert({
    name: 'read-ws',
    description: null,
    workspacePath,
    workspaceHostId: localHostId,
  });
  const conversations = new ConversationRepo(db);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath,
    title: 's1',
  });
  const otherChannel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath,
    title: 's2',
  });
  return {
    workspace,
    db,
    messages: new MessageRepo(db),
    reads: new ConversationReadRepo(db),
    channel,
    otherChannel,
  };
}

describe('ConversationReadRepo', () => {
  it('counts messages authored by anyone except the current viewer', () => {
    const { workspace, messages, reads, channel, otherChannel } = bootstrap();

    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'mine',
    });
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      content: 'legacy mine',
    });
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'alice',
      content: 'other human',
    });
    const latestChannelUnread = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: 'agent',
    });
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      content: 'system',
    });
    const otherChannelUnread = messages.insertForConversation({
      conversationId: otherChannel.id,
      fromKind: 'user',
      fromUserId: 'alice',
      content: 'other channel',
    });

    const byConversation = reads.unreadCountsByConversationForWorkspace(
      workspace.id,
      'local',
    );
    expect(byConversation.by_conversation).toEqual({
      [channel.id]: 2,
      [otherChannel.id]: 1,
    });
    expect(byConversation.latest_by_conversation[channel.id]).toMatchObject({
      conversation_id: channel.id,
      message_id: latestChannelUnread.id,
      seq: latestChannelUnread.seq,
      thread_root_id: null,
    });
    expect(byConversation.latest_by_conversation[otherChannel.id]).toMatchObject({
      conversation_id: otherChannel.id,
      message_id: otherChannelUnread.id,
      seq: otherChannelUnread.seq,
      thread_root_id: null,
    });
    expect(byConversation.total).toBe(3);
    expect(reads.unreadCountsByWorkspace('local')).toEqual({ [workspace.id]: 3 });
  });

  it('returns latest unread pointers with thread root and seq', () => {
    const { workspace, messages, reads, channel } = bootstrap();

    const root = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: 'root',
    });
    const reply = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      threadRootId: root.id,
      content: 'thread reply',
    });
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      threadRootId: root.id,
      content: 'system event',
    });
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'mine',
    });

    const byConversation = reads.unreadCountsByConversationForWorkspace(
      workspace.id,
      'local',
    );
    const expected = {
      conversation_id: channel.id,
      message_id: reply.id,
      seq: reply.seq,
      thread_root_id: root.id,
    };
    expect(byConversation.latest_by_conversation[channel.id]).toEqual(expected);
    expect(reads.latestUnreadForConversation(channel.id, 'local')).toEqual(expected);
  });

  it('excludes conversations the viewer is not a member of from aggregates', () => {
    const { workspace, db, messages, reads, channel, otherChannel } = bootstrap();

    db.prepare(
      `DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`,
    ).run(otherChannel.id, 'local');
    const unread = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: 'visible',
    });
    messages.insertForConversation({
      conversationId: otherChannel.id,
      fromKind: 'agent',
      content: 'hidden',
    });

    expect(
      reads.unreadCountsByConversationForWorkspace(workspace.id, 'local'),
    ).toEqual({
      by_conversation: { [channel.id]: 1 },
      latest_by_conversation: {
        [channel.id]: {
          conversation_id: channel.id,
          message_id: unread.id,
          seq: unread.seq,
          thread_root_id: null,
        },
      },
      total: 1,
    });
    expect(reads.unreadCountsByWorkspace('local')).toEqual({ [workspace.id]: 1 });
    expect(reads.unreadCountsByWorkspaceSidebar('local')).toEqual({
      [workspace.id]: 1,
    });
  });

  it('advances the cursor to latest seq and never moves it backward', () => {
    const { messages, reads, channel } = bootstrap();
    const m1 = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: '1',
    });
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: '2',
    });
    const latest = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: '3',
    });

    expect(reads.markRead({ viewerUserId: 'local', conversationId: channel.id }).last_read_seq)
      .toBe(latest.seq);
    expect(reads.unreadCountForConversation(channel.id, 'local')).toBe(0);

    const next = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: '4',
    });
    expect(reads.markRead({
      viewerUserId: 'local',
      conversationId: channel.id,
      seq: m1.seq,
    }).last_read_seq).toBe(latest.seq);
    expect(reads.unreadCountForConversation(channel.id, 'local')).toBe(1);

    expect(reads.markRead({
      viewerUserId: 'local',
      conversationId: channel.id,
      seq: next.seq,
    }).last_read_seq).toBe(next.seq);
    expect(reads.unreadCountForConversation(channel.id, 'local')).toBe(0);
  });
});
