import { fixedWorkspaceName } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import { fixedConversationTitle } from '@silverhand/shared';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { ThreadFollowerRepo } from '../../src/repos/thread-follower-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db);
  const workspace = workspaces.insert({
    name: fixedWorkspaceName('read-ws'),
    description: null,
  });
  const conversations = new ConversationRepo(db);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    title: fixedConversationTitle('s1'),
  });
  const otherChannel = conversations.insertChannel({
    workspaceId: workspace.id,
    title: fixedConversationTitle('s2'),
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

  // #task:1283 B4: the single-workspace rollup used to enrich the
  // `unread_updated` frame MUST equal the two existing all-workspaces rollups
  // (and the by-conversation `total`) for the same (viewer, workspace) —
  // otherwise the emitted `workspace_unread_count` would drift from what the
  // summary route and favorites row serve.
  it('unreadCountForWorkspace == all-workspaces rollups == by-conversation total', () => {
    const { workspace, messages, reads, channel, otherChannel } = bootstrap();
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'alice',
      content: 'a',
    });
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: 'b',
    });
    messages.insertForConversation({
      conversationId: otherChannel.id,
      fromKind: 'user',
      fromUserId: 'bob',
      content: 'c',
    });

    const single = reads.unreadCountForWorkspace(workspace.id, 'local');
    expect(single).toBe(3);
    expect(single).toBe(reads.unreadCountsByWorkspace('local')[workspace.id]);
    expect(single).toBe(
      reads.unreadCountsByWorkspaceSidebar('local')[workspace.id],
    );
    expect(single).toBe(
      reads.unreadCountsByConversationForWorkspace(workspace.id, 'local').total,
    );
  });

  it('unreadCountForWorkspace is 0 when caught up (absent-key ⟺ 0 parity)', () => {
    const { workspace, reads } = bootstrap();
    // No unread: the single-ws helper returns 0; the sparse all-ws rollup omits
    // the key. Both express "0 unread" — the doc §6 sparse-map invariant the
    // renderer patch depends on (absent key == 0, not "not loaded").
    expect(reads.unreadCountForWorkspace(workspace.id, 'local')).toBe(0);
    expect(reads.unreadCountsByWorkspace('local')[workspace.id]).toBeUndefined();
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

  it('excludes archived conversations from every unread rollup, symmetric on unarchive (#task:1403)', () => {
    const { workspace, db, messages, reads, channel, otherChannel } = bootstrap();
    const conversations = new ConversationRepo(db);

    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: 'a',
    });
    messages.insertForConversation({
      conversationId: otherChannel.id,
      fromKind: 'agent',
      content: 'b',
    });

    // Baseline: both channels' unread counts everywhere.
    expect(reads.unreadCountForConversation(channel.id, 'local')).toBe(1);
    expect(reads.unreadCountForWorkspace(workspace.id, 'local')).toBe(2);

    // Archiving ends the channel's lifecycle → its unread leaves the
    // per-conversation count, the workspace rollups, and the by-conversation map.
    conversations.setArchived(channel.id, true);
    expect(reads.unreadCountForConversation(channel.id, 'local')).toBe(0);
    expect(reads.latestUnreadForConversation(channel.id, 'local')).toBeNull();
    expect(reads.unreadCountForWorkspace(workspace.id, 'local')).toBe(1);
    expect(
      reads.unreadCountsByConversationForWorkspace(workspace.id, 'local')
        .by_conversation,
    ).toEqual({ [otherChannel.id]: 1 });
    expect(reads.unreadCountsByWorkspace('local')).toEqual({ [workspace.id]: 1 });
    expect(reads.unreadCountsByWorkspaceSidebar('local')).toEqual({
      [workspace.id]: 1,
    });

    // Unarchiving restores it — the predicate re-includes the channel, so the
    // emission on unarchive can rebuild the badge from the same authoritative
    // rollup.
    conversations.setArchived(channel.id, false);
    expect(reads.unreadCountForConversation(channel.id, 'local')).toBe(1);
    expect(reads.unreadCountForWorkspace(workspace.id, 'local')).toBe(2);
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

  it('hasFollowedThreadUnread lights ONLY on followed ∩ unread (mainline / unfollowed excluded)', () => {
    const { db, messages, reads, channel } = bootstrap();
    const followers = new ThreadFollowerRepo(db);

    // Cell 1 — mainline-only unread: an agent message on the mainline does NOT
    // light the Threads dot (mainline is deliberately excluded here).
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: 'mainline unread',
    });
    expect(reads.hasFollowedThreadUnread(channel.id, 'local')).toBe(false);
    expect(
      reads.streamUnreadForConversation(channel.id, 'local').followed_thread_unread,
    ).toBe(false);

    // Cell 2 — unfollowed thread with unread: a reply in a thread the viewer does
    // NOT follow stays out of the header dot (it surfaces only as the in-list soft
    // dot). The follow-agnostic per-thread map still carries it.
    const root = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      content: 'thread root',
    });
    const reply = messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      threadRootId: root.id,
      content: 'unread reply',
    });
    expect(reads.hasFollowedThreadUnread(channel.id, 'local')).toBe(false);
    expect(reads.streamUnreadForConversation(channel.id, 'local').threads[root.id])
      .toBeDefined();

    // Cell 3 — followed thread with unread: following the root flips the dot on.
    followers.upsert({
      threadRootId: root.id,
      conversationId: channel.id,
      principalKind: 'human',
      principalId: 'local',
      source: 'manual',
    });
    expect(reads.hasFollowedThreadUnread(channel.id, 'local')).toBe(true);
    expect(
      reads.streamUnreadForConversation(channel.id, 'local').followed_thread_unread,
    ).toBe(true);

    // Reading the followed thread to its head clears the dot — it is gated on the
    // per-thread cursor, not merely on following.
    reads.markRead({
      viewerUserId: 'local',
      conversationId: channel.id,
      threadRootId: root.id,
      seq: reply.seq,
    });
    expect(reads.hasFollowedThreadUnread(channel.id, 'local')).toBe(false);

    // Guards apply to the followed branch too: neither a system reply nor the
    // viewer's OWN reply relights the dot; a fresh agent reply does.
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      threadRootId: root.id,
      content: 'system reply',
    });
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      threadRootId: root.id,
      content: 'my own reply',
    });
    expect(reads.hasFollowedThreadUnread(channel.id, 'local')).toBe(false);
    messages.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      threadRootId: root.id,
      content: 'fresh unread reply',
    });
    expect(reads.hasFollowedThreadUnread(channel.id, 'local')).toBe(true);
  });
});
