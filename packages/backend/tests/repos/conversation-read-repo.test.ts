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
    const { workspace, db, messages, reads, channel } = bootstrap();

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

    // Roll-up only counts FOLLOWED threads (#task:1226 §3.5). The viewer must
    // follow this cluster for its reply to appear in the conversation-level
    // unread pointer; thread_followers is the (human) follow contract.
    db.prepare(
      `INSERT INTO thread_followers
         (thread_root_id, conversation_id, principal_kind, principal_id, followed_at, source)
       VALUES (?, ?, 'human', ?, ?, 'manual')`,
    ).run(root.id, channel.id, 'local', Date.now());

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

  it('advances the mainline cursor monotonically and never moves it backward', () => {
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

    // The repo persists an already-resolved per-stream seq (the route resolves
    // the open-time snapshot / fallback); threadRootId NULL = mainline.
    expect(
      reads.markRead({
        viewerUserId: 'local',
        conversationId: channel.id,
        threadRootId: null,
        seq: latest.seq,
      }).last_read_seq,
    ).toBe(latest.seq);
    expect(reads.unreadCountForConversation(channel.id, 'local')).toBe(0);

    const next = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: '4',
    });
    expect(
      reads.markRead({
        viewerUserId: 'local',
        conversationId: channel.id,
        threadRootId: null,
        seq: m1.seq,
      }).last_read_seq,
    ).toBe(latest.seq);
    expect(reads.unreadCountForConversation(channel.id, 'local')).toBe(1);

    expect(
      reads.markRead({
        viewerUserId: 'local',
        conversationId: channel.id,
        threadRootId: null,
        seq: next.seq,
      }).last_read_seq,
    ).toBe(next.seq);
    expect(reads.unreadCountForConversation(channel.id, 'local')).toBe(0);
  });

  it('tracks per-stream cursors independently (mainline vs thread)', () => {
    const { db, messages, reads, channel } = bootstrap();

    const mainline = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: 'mainline',
    });
    const root = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: 'root',
    });
    const reply1 = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      threadRootId: root.id,
      content: 'r1',
    });
    const reply2 = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      threadRootId: root.id,
      content: 'r2',
    });

    // Per-stream unread is independent and follow-agnostic at the stream grain.
    expect(reads.unreadCountForStream(channel.id, null, 'local')).toBe(2); // mainline + root
    expect(reads.unreadCountForStream(channel.id, root.id, 'local')).toBe(2); // r1, r2

    // Reading the mainline must NOT touch the thread cursor.
    reads.markRead({
      viewerUserId: 'local',
      conversationId: channel.id,
      threadRootId: null,
      seq: root.seq,
    });
    expect(reads.unreadCountForStream(channel.id, null, 'local')).toBe(0);
    expect(reads.unreadCountForStream(channel.id, root.id, 'local')).toBe(2);

    // First-unread for the thread points at the earliest unread reply (id + seq).
    expect(reads.firstUnreadForStream(channel.id, root.id, 'local')).toEqual({
      message_id: reply1.id,
      seq: reply1.seq,
    });

    // Reading the thread to a snapshot advances only the thread cursor.
    reads.markRead({
      viewerUserId: 'local',
      conversationId: channel.id,
      threadRootId: root.id,
      seq: reply1.seq,
    });
    expect(reads.unreadCountForStream(channel.id, root.id, 'local')).toBe(1);
    expect(reads.firstUnreadForStream(channel.id, root.id, 'local')).toEqual({
      message_id: reply2.id,
      seq: reply2.seq,
    });

    // Roll-up excludes the non-followed thread; only mainline counts (now 0).
    expect(reads.unreadCountForConversation(channel.id, 'local')).toBe(0);

    // Following the thread brings its remaining unread into the roll-up.
    db.prepare(
      `INSERT INTO thread_followers
         (thread_root_id, conversation_id, principal_kind, principal_id, followed_at, source)
       VALUES (?, ?, 'human', ?, ?, 'manual')`,
    ).run(root.id, channel.id, 'local', Date.now());
    expect(reads.unreadCountForConversation(channel.id, 'local')).toBe(1);
    void mainline;
  });

  it('streamUnreadForConversation returns mainline + sparse per-thread unread, follow-agnostic', () => {
    const { messages, reads, channel } = bootstrap();

    const root = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: 'root',
    });
    const reply1 = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      threadRootId: root.id,
      content: 'r1',
    });
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      threadRootId: root.id,
      content: 'r2',
    });
    // System + own messages never count (same WHERE as the per-stream helpers).
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      threadRootId: root.id,
      content: 'system in thread',
    });
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'mine on mainline',
    });
    const mainlineUnread = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: 'mainline unread',
    });

    // A second, never-replied root is not a stream with unread → absent.
    const quietRoot = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: 'quiet root',
    });

    const unread = reads.streamUnreadForConversation(channel.id, 'local');
    // Mainline: the root message + the explicit mainline-unread agent message
    // (own + system excluded); quietRoot is itself a mainline message too.
    expect(unread.mainline.unread_count).toBe(3); // root + quietRoot + mainlineUnread
    expect(unread.mainline.first_unread_message_id).toBe(root.id);
    // Thread is follow-AGNOSTIC: it appears though the viewer doesn't follow it.
    expect(unread.threads[root.id]).toEqual({
      unread_count: 2,
      first_unread_message_id: reply1.id,
      first_unread_seq: reply1.seq,
    });
    // Sparse: a root with no replies has no thread stream entry.
    expect(unread.threads[quietRoot.id]).toBeUndefined();
    void mainlineUnread;

    // Reading the thread to r1 drops its count to 1 and advances first-unread;
    // reading the mainline to head removes it from the map entirely.
    reads.markRead({
      viewerUserId: 'local',
      conversationId: channel.id,
      threadRootId: root.id,
      seq: reply1.seq,
    });
    reads.markRead({
      viewerUserId: 'local',
      conversationId: channel.id,
      threadRootId: null,
      seq: quietRoot.seq, // mainline head (latest mainline message)
    });
    const after = reads.streamUnreadForConversation(channel.id, 'local');
    expect(after.mainline).toEqual({
      unread_count: 0,
      first_unread_message_id: null,
      first_unread_seq: null,
    });
    expect(after.threads[root.id]?.unread_count).toBe(1);
  });
});
