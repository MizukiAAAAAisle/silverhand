import { describe, expect, it } from 'vitest';
import { testWorkspacePath } from '../utils/db.js';
import type { Database as Db } from 'better-sqlite3';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import {
  InvalidThreadsCursorError,
  MessageRepo,
} from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

// Local bootstrap (mirrors message-repo.test.ts) — one channel + one agent.
function bootstrap() {
  const { db, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db);
  const workspacePath = testWorkspacePath('threads-ws');
  const workspace = workspaces.insert({
    name: 'threads-ws',
    description: null,
    workspacePath,
    workspaceHostId: localHostId,
  });
  const agent = new AgentRepo(db).create(
    { name: 'a', runtime: 'claude' },
    localHostId,
    'local',
  );
  workspaces.insertMembership(workspace.id, agent.id);
  const conversations = new ConversationRepo(db);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath,
    title: 't',
  });
  conversations.addAgent(channel.id, agent.id);
  return { db, channel, agentId: agent.id, repo: new MessageRepo(db) };
}

function setCreatedAt(db: Db, id: string, ts: number): void {
  db.prepare(`UPDATE messages SET created_at = ? WHERE id = ?`).run(ts, id);
}

describe('MessageRepo.listChannelThreads', () => {
  it('aggregates reply-clusters, sorts newest-activity-first, excludes non-threads', () => {
    const { db, channel, agentId, repo } = bootstrap();

    const rootA = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'A'.repeat(200),
    });
    const rootB = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'root B',
    });
    // Root with only a system "reply" → reply_count 0 → excluded.
    const rootC = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'C',
    });
    // Plain main-line message with no replies → excluded.
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'lonely',
    });

    // Replies to A: human u2, agent, and a system message (excluded).
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'alice',
      content: 'a1',
      threadRootId: rootA.id,
    });
    const a2 = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'a2',
      threadRootId: rootA.id,
    });
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      content: 'sys',
      threadRootId: rootA.id,
    });
    // Reply to B: human u3.
    const b1 = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'bob',
      content: 'b1',
      threadRootId: rootB.id,
    });
    // System-only reply to C → still not a thread.
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      content: 'sysC',
      threadRootId: rootC.id,
    });

    // A's last reply newer than B's → A sorts first.
    setCreatedAt(db, a2.id, 5000);
    setCreatedAt(db, b1.id, 3000);

    const page = repo.listChannelThreads(channel.id, 'local', {});
    expect(page.threads.map(t => t.root_message_id)).toEqual([
      rootA.id,
      rootB.id,
    ]);
    expect(page.next_cursor).toBeNull();

    const tA = page.threads[0]!;
    expect(tA.reply_count).toBe(2); // a1 + a2, system excluded
    expect(tA.last_reply_message_id).toBe(a2.id);
    expect(tA.last_reply_at).toBe(5000);
    expect(tA.root_author).toEqual({ kind: 'human', id: 'local' });
    expect(tA.root_preview).toHaveLength(160);
    // Most-recent first: a2 (agent) then a1 (human u2).
    expect(tA.repliers).toEqual([
      { kind: 'agent', id: agentId },
      { kind: 'human', id: 'alice' },
    ]);
    expect(tA.replier_total).toBe(2);
    // P2 (§6): root_seq is exposed as the keyset tie-break half.
    expect(tA.root_seq).toBe(rootA.seq);

    const tB = page.threads[1]!;
    expect(tB.reply_count).toBe(1);
    expect(tB.root_author).toEqual({ kind: 'agent', id: agentId });
    expect(tB.repliers).toEqual([{ kind: 'human', id: 'bob' }]);
  });

  it('fills viewer_following (read-only follow projection) (#task:1226)', () => {
    const { db, channel, agentId, repo } = bootstrap();
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'root',
    });
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'reply',
      threadRootId: root.id,
    });

    // Per-thread unread no longer rides on ThreadSummary — it's served by the
    // dedicated conversation-unread read-model (see conversation-read-repo /
    // conversation-unread route tests). The Threads list only projects follow
    // state here: not followed → false.
    const t = repo.listChannelThreads(channel.id, 'local', {}).threads[0]!;
    expect(t.viewer_following).toBe(false);

    // Following the cluster flips viewer_following (read-only projection of the
    // human follow contract — the list never writes it).
    db.prepare(
      `INSERT INTO thread_followers
         (thread_root_id, conversation_id, principal_kind, principal_id, followed_at, source)
       VALUES (?, ?, 'human', ?, ?, 'manual')`,
    ).run(root.id, channel.id, 'local', Date.now());
    const t2 = repo.listChannelThreads(channel.id, 'local', {}).threads[0]!;
    expect(t2.viewer_following).toBe(true);
  });

  it('filter=followed-unread narrows to followed ∩ unread roots, sharing the header predicate (#task:1774)', () => {
    const { db, channel, agentId, repo } = bootstrap();
    const reads = new ConversationReadRepo(db);

    const mkRootWithReply = (label: string) => {
      const root = repo.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: `${label} root`,
      });
      const reply = repo.insertForConversation({
        conversationId: channel.id,
        fromKind: 'agent',
        fromAgentId: agentId,
        threadRootId: root.id,
        content: `${label} reply`,
      });
      return { root, reply };
    };
    const follow = (rootId: string) =>
      db
        .prepare(
          `INSERT INTO thread_followers
             (thread_root_id, conversation_id, principal_kind, principal_id, followed_at, source)
           VALUES (?, ?, 'human', ?, ?, 'manual')`,
        )
        .run(rootId, channel.id, 'local', Date.now());

    const followedUnread = mkRootWithReply('followed-unread');
    const unfollowedUnread = mkRootWithReply('unfollowed-unread');
    const followedCaughtUp = mkRootWithReply('followed-caughtup');

    follow(followedUnread.root.id);
    follow(followedCaughtUp.root.id);
    // Caught up on the third followed thread → excluded despite following, so the
    // list filter is gated on the SAME per-thread cursor as the header dot.
    reads.markRead({
      viewerUserId: 'local',
      conversationId: channel.id,
      threadRootId: followedCaughtUp.root.id,
      seq: followedCaughtUp.reply.seq,
    });

    // "All" is unchanged — every reply-cluster, regardless of follow / unread.
    const all = repo.listChannelThreads(channel.id, 'local', {});
    expect(all.threads.map(t => t.root_message_id).sort()).toEqual(
      [
        followedUnread.root.id,
        unfollowedUnread.root.id,
        followedCaughtUp.root.id,
      ].sort(),
    );

    // "Unread" = only the followed thread with unread replies; unfollowed-unread
    // and followed-but-caught-up are both excluded. Rows are viewer_following.
    const unread = repo.listChannelThreads(channel.id, 'local', {
      filter: 'followed-unread',
    });
    expect(unread.threads.map(t => t.root_message_id)).toEqual([
      followedUnread.root.id,
    ]);
    expect(unread.threads[0]!.viewer_following).toBe(true);
    expect(unread.next_cursor).toBeNull();

    // Explicit `filter: 'all'` is identical to the default.
    const allExplicit = repo.listChannelThreads(channel.id, 'local', {
      filter: 'all',
    });
    expect(allExplicit.threads.map(t => t.root_message_id)).toEqual(
      all.threads.map(t => t.root_message_id),
    );
  });

  it('filter=followed-unread keyset-paginates its OWN dataset across same-timestamp neighbours (#task:1774)', () => {
    const { db, channel, agentId, repo } = bootstrap();

    // The whole point of the filter is that a followed-unread cluster may sit
    // BELOW the All first page, so the filtered dataset must page through by
    // itself — never skip a same-timestamp neighbour, never leak an unfollowed
    // cluster interleaved between the followed ones, and carry the filter onto
    // the next page. Interleave noise so the followed roots are non-contiguous
    // in root seq, and give every reply an IDENTICAL last_reply_at so ordering
    // falls back to root seq DESC and the cursor is exercised on the tie-break.
    const mk = (label: string) => {
      const root = repo.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: `${label} root`,
      });
      const reply = repo.insertForConversation({
        conversationId: channel.id,
        fromKind: 'agent',
        fromAgentId: agentId,
        threadRootId: root.id,
        content: `${label} reply`,
      });
      setCreatedAt(db, reply.id, 1000);
      return root;
    };
    const follow = (rootId: string) =>
      db
        .prepare(
          `INSERT INTO thread_followers
             (thread_root_id, conversation_id, principal_kind, principal_id, followed_at, source)
           VALUES (?, ?, 'human', 'local', ?, 'manual')`,
        )
        .run(rootId, channel.id, Date.now());

    const fu0 = mk('fu0');
    mk('noise0'); // unfollowed → must never appear on either page
    const fu1 = mk('fu1');
    mk('noise1');
    const fu2 = mk('fu2');
    [fu0, fu1, fu2].forEach(r => follow(r.id));

    // root seq DESC over the FILTERED set: fu2, fu1, fu0 (noise excluded).
    const p1 = repo.listChannelThreads(channel.id, 'local', {
      filter: 'followed-unread',
      limit: 2,
    });
    expect(p1.threads.map(t => t.root_message_id)).toEqual([fu2.id, fu1.id]);
    expect(p1.next_cursor).not.toBeNull();

    // Second page MUST keep the same filter, resume exactly at fu0 (no repeat of
    // fu1, no dropped neighbour), and close out.
    const p2 = repo.listChannelThreads(channel.id, 'local', {
      filter: 'followed-unread',
      limit: 2,
      cursor: p1.next_cursor,
    });
    expect(p2.threads.map(t => t.root_message_id)).toEqual([fu0.id]);
    expect(p2.next_cursor).toBeNull();

    // Union of the two pages = the whole filtered set, in order, no dup/gap.
    expect([...p1.threads, ...p2.threads].map(t => t.root_message_id)).toEqual([
      fu2.id,
      fu1.id,
      fu0.id,
    ]);
  });

  it('keyset-paginates without dropping same-timestamp clusters', () => {
    const { db, channel, agentId, repo } = bootstrap();
    const roots = [0, 1, 2].map(i =>
      repo.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: `r${i}`,
      }),
    );
    // One reply each, all with an IDENTICAL last_reply_at → ordering must
    // fall back to root seq DESC, and the cursor must not skip the
    // same-timestamp neighbour.
    for (const r of roots) {
      const re = repo.insertForConversation({
        conversationId: channel.id,
        fromKind: 'agent',
        fromAgentId: agentId,
        content: `re`,
        threadRootId: r.id,
      });
      setCreatedAt(db, re.id, 1000);
    }

    const p1 = repo.listChannelThreads(channel.id, 'local', { limit: 2 });
    expect(p1.threads.map(t => t.root_message_id)).toEqual([
      roots[2]!.id,
      roots[1]!.id,
    ]);
    expect(p1.next_cursor).not.toBeNull();

    const p2 = repo.listChannelThreads(channel.id, 'local', {
      limit: 2,
      cursor: p1.next_cursor,
    });
    expect(p2.threads.map(t => t.root_message_id)).toEqual([roots[0]!.id]);
    expect(p2.next_cursor).toBeNull();
  });

  it('caps repliers at 3 distinct, most-recent first, with full replier_total', () => {
    const { channel, repo } = bootstrap();
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'root',
    });
    for (const u of ['local', 'alice', 'bob', 'teammate', 'local']) {
      repo.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        fromUserId: u,
        content: `from ${u}`,
        threadRootId: root.id,
      });
    }
    const tr = repo.listChannelThreads(channel.id, 'local', {}).threads[0]!;
    expect(tr.replier_total).toBe(4); // u1..u4 distinct
    expect(tr.repliers).toHaveLength(3);
    // u1's most-recent reply was last → u1 first, then u4, u3.
    expect(tr.repliers.map(r => r.id)).toEqual(['local', 'teammate', 'bob']);
  });

  it('returns an empty page for a channel with no threads', () => {
    const { channel, repo } = bootstrap();
    expect(repo.listChannelThreads(channel.id, 'local', {})).toEqual({
      threads: [],
      next_cursor: null,
    });
  });

  it('rejects a malformed cursor', () => {
    const { channel, repo } = bootstrap();
    expect(() =>
      repo.listChannelThreads(channel.id, 'local', { cursor: '!!!not-base64-json' }),
    ).toThrow(InvalidThreadsCursorError);
    // Valid base64url but wrong JSON shape.
    const badShape = Buffer.from('{"x":1}', 'utf8').toString('base64url');
    expect(() =>
      repo.listChannelThreads(channel.id, 'local', { cursor: badShape }),
    ).toThrow(InvalidThreadsCursorError);
  });
});

describe('MessageRepo.replyBadgeSummariesByRoot (P1)', () => {
  it('enriches only roots with non-system replies, mirroring reply_count', () => {
    const { db, channel, agentId, repo } = bootstrap();

    const rootA = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'root A',
    });
    const rootB = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'root B',
    });
    // A main-line message with no replies — present in counts (as 0) but must
    // be absent from the summaries.
    const lonely = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'lonely',
    });

    // Replies to A: human alice, agent, plus a system message (excluded).
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'alice',
      content: 'a1',
      threadRootId: rootA.id,
    });
    const a2 = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'a2',
      threadRootId: rootA.id,
    });
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      content: 'sys',
      threadRootId: rootA.id,
    });
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'bob',
      content: 'b1',
      threadRootId: rootB.id,
    });
    setCreatedAt(db, a2.id, 7000);

    const rootIds = [rootA.id, rootB.id, lonely.id];
    const counts = repo.replyCountsByRoot(channel.id, rootIds);
    const sums = repo.replyBadgeSummariesByRoot(channel.id, rootIds);

    // Only roots with >= 1 non-system reply appear (lonely excluded).
    expect(Object.keys(sums).sort()).toEqual([rootA.id, rootB.id].sort());
    // reply_count mirrors reply_counts_by_root exactly.
    expect(sums[rootA.id]!.reply_count).toBe(counts[rootA.id]);
    expect(sums[rootA.id]!.reply_count).toBe(2); // system excluded
    expect(sums[rootA.id]!.last_reply_at).toBe(7000); // max-seq reply (a2)
    expect(sums[rootA.id]!.repliers).toEqual([
      { kind: 'agent', id: agentId },
      { kind: 'human', id: 'alice' },
    ]);
    expect(sums[rootA.id]!.replier_total).toBe(2);
    expect(sums[rootB.id]!.repliers).toEqual([{ kind: 'human', id: 'bob' }]);
  });

  it('returns an empty record for no roots', () => {
    const { channel, repo } = bootstrap();
    expect(repo.replyBadgeSummariesByRoot(channel.id, [])).toEqual({});
  });
});

// #task:1746: the inline reply-PREVIEW sidecar. Tail-3 most-recent non-system
// replies per root, time-ASCending, eligibility mirroring reply_count. Selection
// is by seq alone (the immutable insert order), NOT edit-version arbitration.
describe('MessageRepo.replyPreviewsByRoot (#task:1746)', () => {
  it('returns the tail-3 most-recent non-system replies per root, time-ASC', () => {
    const { channel, agentId, repo } = bootstrap();

    const rootA = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'root A',
    });
    const rootB = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'root B',
    });
    // A main-line message with no replies — present in counts (as 0) but must
    // be absent from previews (the count-only chip covers a 0-reply root).
    const lonely = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'lonely',
    });

    // Four non-system replies to A (r1..r4 by ascending seq) plus a system
    // reply (excluded). Interleaved with a B reply to prove per-root
    // partitioning over the global seq.
    const a1 = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'alice',
      content: 'a1',
      threadRootId: rootA.id,
    });
    const b1 = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'bob',
      content: 'b1',
      threadRootId: rootB.id,
      attachments: [
        { id: 'att1', filename: 'first.png', size: 10, content_type: 'image/png' },
        { id: 'att2', filename: 'second.pdf', size: 20, content_type: 'application/pdf' },
      ],
    });
    const a2 = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'a2',
      threadRootId: rootA.id,
    });
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      content: 'sys',
      threadRootId: rootA.id,
    });
    const a3 = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'alice',
      content: 'C'.repeat(200),
      threadRootId: rootA.id,
    });
    const a4 = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'a4',
      threadRootId: rootA.id,
    });

    const rootIds = [rootA.id, rootB.id, lonely.id];
    const counts = repo.replyCountsByRoot(channel.id, rootIds);
    const previews = repo.replyPreviewsByRoot(channel.id, rootIds);

    // Only roots with >= 1 non-system reply appear (lonely excluded).
    expect(Object.keys(previews).sort()).toEqual([rootA.id, rootB.id].sort());

    // rootA has 4 non-system replies; the preview is the tail-3 (a2,a3,a4 —
    // a1 the oldest is dropped), presented time-ASCending. seq is the selection
    // key, and it mirrors reply_count eligibility (system excluded).
    expect(counts[rootA.id]).toBe(4);
    expect(previews[rootA.id]!.map(p => p.message_id)).toEqual([
      a2.id,
      a3.id,
      a4.id,
    ]);
    expect(previews[rootA.id]!.map(p => p.seq)).toEqual([a2.seq, a3.seq, a4.seq]);
    // Not a1 (dropped past the tail).
    expect(previews[rootA.id]!.some(p => p.message_id === a1.id)).toBe(false);

    // Author reuses the ThreadReplier shape: user→human, agent→agent, id from
    // the matching actor column.
    expect(previews[rootA.id]![0]).toMatchObject({
      author: { kind: 'agent', id: agentId },
      preview: 'a2',
      attachment_count: 0,
      first_attachment_label: null,
    });
    // Preview is server-truncated to <= 160 chars (a3 is 200 chars).
    const a3Preview = previews[rootA.id]!.find(p => p.message_id === a3.id)!;
    expect(a3Preview.preview).toBe('C'.repeat(160));
    expect(a3Preview.author).toEqual({ kind: 'human', id: 'alice' });

    // rootB's single reply carries attachments → label metadata only (count +
    // first canonical label), never bytes. Two unlabeled attachments (image +
    // pdf) → positional `Image #1` / `File #1` via resolveAttachmentLabels; the
    // FIRST is `Image #1`, the same label the body references.
    expect(previews[rootB.id]).toHaveLength(1);
    expect(previews[rootB.id]![0]).toMatchObject({
      message_id: b1.id,
      author: { kind: 'human', id: 'bob' },
      attachment_count: 2,
      first_attachment_label: 'Image #1',
    });
  });

  it('returns an empty record for no roots', () => {
    const { channel, repo } = bootstrap();
    expect(repo.replyPreviewsByRoot(channel.id, [])).toEqual({});
  });

  // Option A contract (#task:1746): `preview` is a NORMALIZED MARKDOWN SOURCE
  // excerpt — whitespace-compacted + trimmed + capped, with NO Markdown
  // stripping (there is no canonical MD→text helper and the read model must not
  // grow one). Literal syntax is preserved verbatim; the renderer owns
  // presentation. This falsifies any accidental server-side stripping.
  it('whitespace-compacts + trims but never strips Markdown syntax', () => {
    const { channel, agentId, repo } = bootstrap();
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'root',
    });
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: '  **bold**\n\n`code`\t[link](http://x)   trailing  ',
      threadRootId: root.id,
    });

    const previews = repo.replyPreviewsByRoot(channel.id, [root.id]);
    // Runs of whitespace (spaces, newlines, tabs) collapse to a single space and
    // the ends are trimmed — but every Markdown token survives literally.
    expect(previews[root.id]![0]!.preview).toBe(
      '**bold** `code` [link](http://x) trailing',
    );
  });
});

// S1 P2 (docs/projection-recovery-s1-v1.md §5/§6): the single-root, viewer-
// invariant threads-list entry the backend emits on a `message` frame. Mirrors
// listChannelThreads's per-row projection MINUS viewer_following, PLUS root_seq.
describe('MessageRepo.threadListEntryForRoot (P2)', () => {
  it('mirrors the list row minus viewer_following, plus root_seq', () => {
    const { db, channel, agentId, repo } = bootstrap();
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'R'.repeat(200),
    });
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'alice',
      content: 'a1',
      threadRootId: root.id,
    });
    const a2 = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'a2',
      threadRootId: root.id,
    });
    // A system reply must be excluded from count / last-reply, matching the list.
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      content: 'sys',
      threadRootId: root.id,
    });
    setCreatedAt(db, a2.id, 9000);

    // The viewer follows the cluster — the entry must STILL omit viewer_following
    // (it is per-viewer, barred from the broadcast frame), unlike the list row.
    db.prepare(
      `INSERT INTO thread_followers
         (thread_root_id, conversation_id, principal_kind, principal_id, followed_at, source)
       VALUES (?, ?, 'human', ?, ?, 'manual')`,
    ).run(root.id, channel.id, 'local', Date.now());

    const entry = repo.threadListEntryForRoot(channel.id, root.id);
    expect(entry).not.toBeNull();
    // Invariant fields mirror the list row.
    expect(entry).toEqual({
      root_message_id: root.id,
      root_author: { kind: 'human', id: 'local' },
      root_preview: 'R'.repeat(160),
      root_created_at: root.created_at,
      root_seq: root.seq,
      reply_count: 2, // a1 + a2, system excluded
      last_reply_at: 9000,
      last_reply_message_id: a2.id,
      repliers: [
        { kind: 'agent', id: agentId },
        { kind: 'human', id: 'alice' },
      ],
      replier_total: 2,
    });
    // Structurally viewer-invariant: no per-viewer key leaks in.
    expect('viewer_following' in (entry as object)).toBe(false);
  });

  it('returns null for a root with no non-system reply', () => {
    const { channel, repo } = bootstrap();
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'lonely',
    });
    // A system-only reply does not make it a thread.
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'system',
      content: 'sys',
      threadRootId: root.id,
    });
    expect(repo.threadListEntryForRoot(channel.id, root.id)).toBeNull();
  });

  it('exposes root_seq so same-last_reply_at roots order by root_seq DESC (tie-break)', () => {
    const { db, channel, agentId, repo } = bootstrap();
    const roots = [0, 1, 2].map(i =>
      repo.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: `r${i}`,
      }),
    );
    // One reply each, ALL with an identical last_reply_at → the ONLY discriminator
    // is root_seq. The client keyset (last_reply_at DESC, root_seq DESC) must
    // reproduce the server order using the entry's root_seq alone.
    for (const r of roots) {
      const re = repo.insertForConversation({
        conversationId: channel.id,
        fromKind: 'agent',
        fromAgentId: agentId,
        content: 're',
        threadRootId: r.id,
      });
      setCreatedAt(db, re.id, 1000);
    }

    const entries = roots.map(
      r => repo.threadListEntryForRoot(channel.id, r.id)!,
    );
    // Every entry carries the SAME last_reply_at, so ordering hinges on root_seq.
    expect(entries.map(e => e.last_reply_at)).toEqual([1000, 1000, 1000]);
    expect(entries.map(e => e.root_seq)).toEqual([
      roots[0]!.seq,
      roots[1]!.seq,
      roots[2]!.seq,
    ]);
    // Applying the documented keyset (last_reply_at DESC, root_seq DESC) to the
    // entries reproduces the server's list order EXACTLY (root_seq DESC here).
    const clientOrder = [...entries]
      .sort((a, b) => b.last_reply_at - a.last_reply_at || b.root_seq - a.root_seq)
      .map(e => e.root_message_id);
    const serverOrder = repo
      .listChannelThreads(channel.id, 'local', {})
      .threads.map(t => t.root_message_id);
    expect(clientOrder).toEqual(serverOrder);
    expect(serverOrder).toEqual([roots[2]!.id, roots[1]!.id, roots[0]!.id]);
  });

  it('stays in lock-step with listChannelThreads (shared mapper — no drift)', () => {
    // Anti-drift guard for the extracted rowToThreadSummaryInvariant mapper:
    // the single-root entry and the list row for the SAME root must agree on every
    // viewer-invariant field (they now go through one mapper). The ONLY legitimate
    // difference is viewer_following (per-viewer, on the list row, omitted here).
    const { db, channel, agentId, repo } = bootstrap();
    const root = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'R'.repeat(200),
    });
    repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'user',
      fromUserId: 'alice',
      content: 'a1',
      threadRootId: root.id,
    });
    const a2 = repo.insertForConversation({
      conversationId: channel.id,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'a2',
      threadRootId: root.id,
    });
    setCreatedAt(db, a2.id, 4242);
    // Viewer follows the cluster → the list row carries viewer_following:true; the
    // entry must omit it while every other field stays byte-identical.
    db.prepare(
      `INSERT INTO thread_followers
         (thread_root_id, conversation_id, principal_kind, principal_id, followed_at, source)
       VALUES (?, ?, 'human', ?, ?, 'manual')`,
    ).run(root.id, channel.id, 'local', Date.now());

    const listRow = repo
      .listChannelThreads(channel.id, 'local', {})
      .threads.find(t => t.root_message_id === root.id)!;
    const entry = repo.threadListEntryForRoot(channel.id, root.id)!;

    const { viewer_following, ...listInvariant } = listRow;
    expect(viewer_following).toBe(true); // list carries the per-viewer bit
    expect('viewer_following' in (entry as object)).toBe(false); // entry never does
    expect(entry).toEqual(listInvariant); // …and agrees on all invariant fields
  });
});

