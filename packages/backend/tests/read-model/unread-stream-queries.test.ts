import { DEFAULT_CHANNEL_ATTENTION_MODE, fixedConversationTitle } from '@silverhand/shared';
import type { Database as Db } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  POSITIONAL_STREAMS_SQL,
} from '../../src/read-model/activity.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { channelAmbientEntersPredicate } from '../../src/repos/attention-tier-predicates.js';
import { ChannelAttentionPreferenceRepo } from '../../src/repos/channel-attention-preference-repo.js';
import { LIVE_CONVERSATION_PREDICATE } from '../../src/repos/conversation-liveness.js';
import {
  ConversationReadRepo,
  STREAM_UNREAD_FOR_CONVERSATION_SQL,
} from '../../src/repos/conversation-read-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { ThreadFollowerRepo } from '../../src/repos/thread-follower-repo.js';
import { WorkspaceAttentionPreferenceRepo } from '../../src/repos/workspace-attention-preference-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

// #task:1967 — the two unread queries were rewritten from "walk message history,
// correlate a cursor per candidate row" to "enumerate streams, range-scan each
// one's unread tail". Both properties that rewrite has to keep are gated here:
//
//  1. SEMANTIC EQUIVALENCE, differentially. The pre-rewrite SQL is frozen below
//     verbatim and executed as an ORACLE against the same DB with the same bind
//     params; the assertion is row-for-row equality over a fixture matrix. A
//     hand-written expectation table would only encode what I believe the old
//     query did — the old query itself is the authority on that.
//  2. The ACCESS PATH, over the exported production SQL. The plan test EXPLAINs
//     the constants the production code executes; EXPLAINing a simplified copy
//     would stay green while production regressed.
//
// The frozen oracles interpolate the SAME shared predicate builders production
// uses (`LIVE_CONVERSATION_PREDICATE`, `channelAmbientEntersPredicate`), so the
// enter()/liveness halves of the copy are verbatim BY CONSTRUCTION. That is
// deliberate: if one of those shared predicates changes, both sides move
// together and this file keeps testing the rewrite rather than the predicate.

/** The pre-#1967 `reads.stream_unread_for_conversation`, frozen. */
const LEGACY_STREAM_UNREAD_SQL = `WITH unread AS (
   SELECT m.id   AS message_id,
          m.seq  AS seq,
          m.thread_root_id AS root,
          ROW_NUMBER() OVER (
            PARTITION BY m.thread_root_id ORDER BY m.seq ASC
          ) AS rn,
          COUNT(*) OVER (PARTITION BY m.thread_root_id) AS cnt
     FROM messages m
    WHERE m.conversation_id = @conv
      AND m.from_kind != 'system'
      AND NOT (m.from_kind = 'user'
               AND (m.from_user_id = @viewer OR m.from_user_id IS NULL))
      AND m.seq > COALESCE(
        (SELECT cr.last_read_seq FROM conversation_reads cr
          WHERE cr.user_id = @viewer
            AND cr.conversation_id = @conv
            AND cr.thread_root_id IS m.thread_root_id),
        0
      )
 )
 SELECT root,
        message_id AS first_unread_message_id,
        seq        AS first_unread_seq,
        cnt        AS unread_count
   FROM unread
  WHERE rn = 1`;

/** The pre-#1967 `activity.positional_streams`, frozen. */
const LEGACY_POSITIONAL_STREAMS_SQL = `WITH viewer_unread AS (
     SELECT
       m.conversation_id AS conversation_id,
       m.thread_root_id  AS root,
       m.id              AS message_id,
       m.seq             AS seq,
       m.content         AS content,
       m.created_at      AS created_at,
       m.from_kind       AS from_kind,
       m.from_user_id    AS from_user_id,
       m.from_agent_id   AS from_agent_id,
       m.author_id       AS author_id,
       m.author_name     AS author_name,
       m.author_display_name AS author_display_name,
       ROW_NUMBER() OVER (
         PARTITION BY m.conversation_id, m.thread_root_id ORDER BY m.seq ASC
       ) AS rn,
       COUNT(*) OVER (
         PARTITION BY m.conversation_id, m.thread_root_id
       ) AS cnt
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     JOIN conversation_users cu
       ON cu.conversation_id = c.id AND cu.user_id = @viewer
    WHERE c.kind IN ('channel', 'dm_channel')
      AND ${LIVE_CONVERSATION_PREDICATE}
      AND (@ws IS NULL OR c.workspace_id = @ws)
      AND m.from_kind != 'system'
      AND NOT (m.from_kind = 'user'
               AND (m.from_user_id = @viewer OR m.from_user_id IS NULL))
      AND m.id NOT IN (SELECT value FROM json_each(@excluded))
      AND m.seq > COALESCE(
        (SELECT cr.last_read_seq FROM conversation_reads cr
          WHERE cr.user_id = @viewer
            AND cr.conversation_id = m.conversation_id
            AND cr.thread_root_id IS m.thread_root_id),
        0
      )
   )
   SELECT
     vu.conversation_id              AS conversation_id,
     vu.root                         AS root,
     root.content                    AS root_content,
     c.kind                          AS conversation_kind,
     c.title                         AS conversation_title,
     c.workspace_id                  AS workspace_id,
     vu.message_id                   AS first_unread_message_id,
     vu.seq                          AS first_unread_seq,
     vu.content                      AS first_unread_content,
     vu.created_at                   AS first_unread_created_at,
     vu.cnt                          AS unread_count,
     vu.from_kind                                                  AS from_kind,
     vu.from_user_id                                               AS from_user_id,
     vu.from_agent_id                                              AS from_agent_id,
     vu.author_id                                                  AS author_id,
     vu.author_name                                                AS author_name,
     vu.author_display_name                                        AS author_display_name,
     CASE vu.from_kind WHEN 'user' THEN su.name
                       WHEN 'agent' THEN sa.name END                AS live_name,
     CASE vu.from_kind WHEN 'user' THEN su.display_name
                       WHEN 'agent' THEN sa.display_name END        AS live_display_name,
     CASE vu.from_kind WHEN 'user' THEN su.avatar_storage_key
                       WHEN 'agent' THEN sa.avatar_storage_key END  AS live_avatar_key,
     CASE vu.from_kind WHEN 'user' THEN su.updated_at
                       WHEN 'agent' THEN sa.updated_at END          AS live_updated_at,
     CASE vu.from_kind WHEN 'agent' THEN sa.runtime END             AS live_runtime
   FROM viewer_unread vu
   JOIN conversations c ON c.id = vu.conversation_id
   LEFT JOIN messages root ON root.id = vu.root
   LEFT JOIN users su ON su.id = vu.from_user_id
   LEFT JOIN agents sa ON sa.id = vu.from_agent_id
  WHERE vu.rn = 1
    AND (
      (vu.root IS NULL AND c.kind = 'dm_channel')
      OR (vu.root IS NULL AND c.kind = 'channel'
          AND ${channelAmbientEntersPredicate('vu.conversation_id', 'c.workspace_id')})
      OR (vu.root IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM thread_followers tf
             WHERE tf.thread_root_id = vu.root
               AND tf.principal_kind = 'human'
               AND tf.principal_id = @viewer
          )
          AND ${channelAmbientEntersPredicate('vu.conversation_id', 'c.workspace_id')})
    )`;

type Row = Record<string, unknown>;

/** Stable order for a set comparison: neither query has an ORDER BY (the
 *  read-model sorts in TS), so equality is over the ROW SET. */
function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) =>
    `${String(a.conversation_id ?? '')}|${String(a.root ?? '')}`.localeCompare(
      `${String(b.conversation_id ?? '')}|${String(b.root ?? '')}`,
    ),
  );
}

function run(db: Db, sql: string, binds: Record<string, unknown>): Row[] {
  return db.prepare(sql).all(binds) as Row[];
}

/** Differential assertion: production SQL and the frozen oracle must return the
 *  same row set for the same binds. `expectRows` guards against a VACUOUS pass —
 *  two queries that both return nothing prove nothing about equivalence. */
function expectSameRows(
  db: Db,
  production: string,
  legacy: string,
  binds: Record<string, unknown>,
  expectRows: number,
): Row[] {
  const actual = run(db, production, binds);
  const oracle = run(db, legacy, binds);
  expect(sortRows(actual)).toEqual(sortRows(oracle));
  expect(actual.length).toBe(expectRows);
  return sortRows(actual);
}

interface Fixture {
  db: Db;
  reads: ConversationReadRepo;
  messages: MessageRepo;
  /** Every conversation the fixture created, in a stable order. */
  conversationIds: string[];
  wsA: string;
  wsMuted: string;
  chAll: string;
  chMentions: string;
  chMute: string;
  chArchived: string;
  chNoMember: string;
  chExemptOnly: string;
  chCursorPastHead: string;
  chInMutedWs: string;
  dm: string;
  /** chAll mainline: cursor far behind; unread = [byDeleted, latest]. */
  chAllByDeletedId: string;
  chAllLatestId: string;
  /** chAll: followed thread (cursor ABSENT) and read-to-head unfollowed thread. */
  followedRoot: string;
  readThreadRoot: string;
  followedFirstReplyId: string;
}

/**
 * The acceptance matrix as one DB: mainline + thread streams, cursors
 * absent / mid-history / at head, every excluded author class, both attention
 * tiers plus the workspace suppressor, archived / non-member / freshness-exempt
 * conversations, a DM, a deleted message author, and a second viewer with no
 * cursors at all.
 */
function buildFixture(): Fixture {
  const { db, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const reads = new ConversationReadRepo(db);
  const followers = new ThreadFollowerRepo(db);
  const channelPrefs = new ChannelAttentionPreferenceRepo(db);
  const workspacePrefs = new WorkspaceAttentionPreferenceRepo(db);
  const agents = new AgentRepo(db);

  const speaker = agents.create({ name: 'speaker', runtime: 'claude' }, localHostId, 'local');
  const doomed = agents.create({ name: 'doomed', runtime: 'codex' }, localHostId, 'local');
  const dmAgent = agents.create({ name: 'dm-agent', runtime: 'claude' }, localHostId, 'local');

  const wsA = workspaces.insert({ name: 'ws-a', description: null }).id;
  const wsMuted = workspaces.insert({ name: 'ws-muted', description: null }).id;
  const wsHome = workspaces.insertAgentHome({ agent: dmAgent }).id;

  const channel = (workspaceId: string, title: string): string =>
    conversations.insertChannel({ workspaceId, title: fixedConversationTitle(title) }).id;

  const chAll = channel(wsA, 'all-tier');
  const chMentions = channel(wsA, 'mentions-tier');
  const chMute = channel(wsA, 'muted-channel');
  const chArchived = channel(wsA, 'archived');
  const chNoMember = channel(wsA, 'not-a-member');
  const chExemptOnly = channel(wsA, 'exempt-only');
  const chCursorPastHead = channel(wsA, 'cursor-past-head');
  const chInMutedWs = channel(wsMuted, 'loud-channel-in-muted-ws');
  const dm = conversations.insertDmChannel({
    workspaceId: wsHome,
    title: fixedConversationTitle('dm-agent'),
    agentId: dmAgent.id,
  }).id;

  channelPrefs.upsert({ viewerUserId: 'local', conversationId: chMentions, mode: 'mentions' });
  channelPrefs.upsert({ viewerUserId: 'local', conversationId: chMute, mode: 'mute' });
  workspacePrefs.upsert({ viewerUserId: 'local', workspaceId: wsMuted, muted: true });

  // ── chAll: the anchor conversation ────────────────────────────────────────
  // Mainline eligibility exercised in one stream: agent + other-human count;
  // the viewer's own message, a legacy anonymous `user` row and a system row
  // are all excluded.
  const followedRootMsg = messages.insertForConversation({
    conversationId: chAll,
    fromKind: 'agent',
    fromAgentId: speaker.id,
    content: 'thread root (followed)',
  });
  const readThreadRootMsg = messages.insertForConversation({
    conversationId: chAll,
    fromKind: 'user',
    fromUserId: 'bob',
    content: 'thread root (read to head)',
  });
  const followedFirstReply = messages.insertForConversation({
    conversationId: chAll,
    fromKind: 'agent',
    fromAgentId: speaker.id,
    threadRootId: followedRootMsg.id,
    content: 'followed reply 1',
  });
  messages.insertForConversation({
    conversationId: chAll,
    fromKind: 'user',
    fromUserId: 'local',
    content: 'my own message',
  });
  messages.insertForConversation({
    conversationId: chAll,
    fromKind: 'user',
    content: 'legacy anonymous author',
  });
  messages.insertForConversation({
    conversationId: chAll,
    fromKind: 'system',
    content: 'system notice',
  });
  messages.insertForConversation({
    conversationId: chAll,
    fromKind: 'user',
    fromUserId: 'bob',
    threadRootId: followedRootMsg.id,
    content: 'followed reply 2',
  });
  // The mainline first-unread anchor is authored by an agent that is then
  // hard-deleted: the anchor projection must resolve the send-time snapshot
  // (from_agent_id nulled by ON DELETE SET NULL), which is only exercised if
  // the ANCHOR — not just some counted row — is the deleted author's message.
  const byDeleted = messages.insertForConversation({
    conversationId: chAll,
    fromKind: 'agent',
    fromAgentId: doomed.id,
    content: 'authored by a since-deleted agent',
  });
  const readThreadReply = messages.insertForConversation({
    conversationId: chAll,
    fromKind: 'agent',
    fromAgentId: speaker.id,
    threadRootId: readThreadRootMsg.id,
    content: 'reply in the read thread',
  });
  const chAllLatest = messages.insertForConversation({
    conversationId: chAll,
    fromKind: 'agent',
    fromAgentId: speaker.id,
    content: 'latest mainline',
  });
  db.prepare(`DELETE FROM agents WHERE id = ?`).run(doomed.id);

  followers.upsert({
    threadRootId: followedRootMsg.id,
    conversationId: chAll,
    principalKind: 'human',
    principalId: 'local',
    source: 'manual',
  });

  // Cursor matrix inside ONE conversation: mainline far behind, followed thread
  // has NO cursor row at all, the other thread is read to its head (so it must
  // be absent from the sparse output).
  reads.markRead({
    viewerUserId: 'local',
    conversationId: chAll,
    threadRootId: null,
    seq: readThreadRootMsg.seq,
  });
  reads.markRead({
    viewerUserId: 'local',
    conversationId: chAll,
    threadRootId: readThreadRootMsg.id,
    seq: readThreadReply.seq,
  });

  // ── the enter()-excluded conversations, each with real unread ─────────────
  // Every one of these MUST still appear in the per-conversation read-model
  // (that query is tier-agnostic and follow-agnostic) and MUST NOT appear in
  // Activity — which is exactly what the differential comparison pins.
  for (const conversationId of [chMentions, chMute, chArchived, chNoMember, chInMutedWs]) {
    const root = messages.insertForConversation({
      conversationId,
      fromKind: 'agent',
      fromAgentId: speaker.id,
      content: 'mainline unread',
    });
    messages.insertForConversation({
      conversationId,
      fromKind: 'agent',
      fromAgentId: speaker.id,
      threadRootId: root.id,
      content: 'thread unread',
    });
    followers.upsert({
      threadRootId: root.id,
      conversationId,
      principalKind: 'human',
      principalId: 'local',
      source: 'manual',
    });
  }
  conversations.setArchived(chArchived, true);
  db.prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`).run(
    chNoMember,
    'local',
  );

  // ── DM: mainline is directed-grade and enters regardless of any tier ──────
  const dmRoot = messages.insertForConversation({
    conversationId: dm,
    fromKind: 'agent',
    fromAgentId: dmAgent.id,
    content: 'dm mainline unread',
  });
  messages.insertForConversation({
    conversationId: dm,
    fromKind: 'agent',
    fromAgentId: dmAgent.id,
    threadRootId: dmRoot.id,
    content: 'dm thread unread',
  });
  followers.upsert({
    threadRootId: dmRoot.id,
    conversationId: dm,
    principalKind: 'human',
    principalId: 'local',
    source: 'reply',
  });

  // ── freshness-exempt only: no stream head row exists at all ───────────────
  // The rewrite enumerates streams from `conversation_stream_heads`, so the one
  // writer that deliberately leaves the head behind (§5.2, schedule_fire) is
  // the equivalence hazard. It inserts `from_kind = 'system'` rows, which both
  // queries exclude — this conversation pins that.
  messages.insertForConversation({
    conversationId: chExemptOnly,
    fromKind: 'system',
    content: 'schedule fire (freshness-exempt)',
    freshnessExempt: true,
  });

  // ── a cursor sitting PAST the stream's freshness head ─────────────────────
  const headMsg = messages.insertForConversation({
    conversationId: chCursorPastHead,
    fromKind: 'agent',
    fromAgentId: speaker.id,
    content: 'real mainline message',
  });
  const exempt = messages.insertForConversation({
    conversationId: chCursorPastHead,
    fromKind: 'system',
    content: 'exempt row past the head',
    freshnessExempt: true,
  });
  reads.markRead({
    viewerUserId: 'local',
    conversationId: chCursorPastHead,
    threadRootId: null,
    seq: exempt.seq,
  });
  expect(exempt.seq).toBeGreaterThan(headMsg.seq);

  return {
    db,
    reads,
    messages,
    conversationIds: [
      chAll,
      chMentions,
      chMute,
      chArchived,
      chNoMember,
      chExemptOnly,
      chCursorPastHead,
      chInMutedWs,
      dm,
    ],
    wsA,
    wsMuted,
    chAll,
    chMentions,
    chMute,
    chArchived,
    chNoMember,
    chExemptOnly,
    chCursorPastHead,
    chInMutedWs,
    dm,
    chAllByDeletedId: byDeleted.id,
    chAllLatestId: chAllLatest.id,
    followedRoot: followedRootMsg.id,
    readThreadRoot: readThreadRootMsg.id,
    followedFirstReplyId: followedFirstReply.id,
  };
}

const activityBinds = (
  viewer: string,
  ws: string | null,
  excluded: string[],
): Record<string, unknown> => ({
  viewer,
  ws,
  excluded: JSON.stringify(excluded),
  channelDefaultMode: DEFAULT_CHANNEL_ATTENTION_MODE,
});

describe('#task:1967 unread rewrite — semantic equivalence vs the frozen pre-rewrite SQL', () => {
  it('reads.stream_unread_for_conversation matches the oracle for every conversation × viewer', () => {
    const f = buildFixture();
    // Row counts per (conversation, viewer) are asserted individually so the
    // differential can never pass by both sides being empty everywhere.
    const expected: Record<string, [number, number]> = {
      // conversation: [rows for 'local', rows for 'alice' (no cursors at all)]
      [f.chAll]: [2, 3],
      [f.chMentions]: [2, 2],
      [f.chMute]: [2, 2],
      [f.chArchived]: [2, 2],
      [f.chNoMember]: [2, 2],
      [f.chExemptOnly]: [0, 0],
      [f.chCursorPastHead]: [0, 1],
      [f.chInMutedWs]: [2, 2],
      [f.dm]: [2, 2],
    };
    for (const conv of f.conversationIds) {
      for (const [i, viewer] of ['local', 'alice'].entries()) {
        expectSameRows(
          f.db,
          STREAM_UNREAD_FOR_CONVERSATION_SQL,
          LEGACY_STREAM_UNREAD_SQL,
          { conv, viewer },
          expected[conv]![i]!,
        );
      }
    }
  });

  it('activity.positional_streams matches the oracle across viewer × workspace filter', () => {
    const f = buildFixture();
    const cases: Array<{ viewer: string; ws: string | null; rows: number }> = [
      // 'local': chAll mainline + its followed thread + DM mainline + DM thread.
      // Everything else is filtered by tier / mute / archive / membership.
      { viewer: 'local', ws: null, rows: 4 },
      { viewer: 'local', ws: f.wsA, rows: 2 },
      { viewer: 'local', ws: f.wsMuted, rows: 0 },
      // 'alice' has no cursors, no follows and no attention prefs: every live
      // channel she is a member of enters at the default 'all' tier, mainline
      // only (thread ambient needs a follow) — including the workspace whose
      // mute belongs to 'local', which is what makes the suppressor per-viewer.
      { viewer: 'alice', ws: null, rows: 7 },
      { viewer: 'alice', ws: f.wsA, rows: 5 },
    ];
    for (const c of cases) {
      expectSameRows(
        f.db,
        POSITIONAL_STREAMS_SQL,
        LEGACY_POSITIONAL_STREAMS_SQL,
        activityBinds(c.viewer, c.ws, []),
        c.rows,
      );
    }
  });

  it('directed subtraction moves the count AND the anchor, identically in both queries', () => {
    const f = buildFixture();
    const before = expectSameRows(
      f.db,
      POSITIONAL_STREAMS_SQL,
      LEGACY_POSITIONAL_STREAMS_SQL,
      activityBinds('local', f.wsA, []),
      2,
    );
    const mainlineBefore = before.find(r => r.conversation_id === f.chAll && r.root === null)!;
    expect(mainlineBefore.first_unread_message_id).toBe(f.chAllByDeletedId);
    expect(mainlineBefore.unread_count).toBe(2);
    // The anchor itself is claimed as directed: §8 subtraction has to re-anchor,
    // not just decrement.
    const after = expectSameRows(
      f.db,
      POSITIONAL_STREAMS_SQL,
      LEGACY_POSITIONAL_STREAMS_SQL,
      activityBinds('local', f.wsA, [f.chAllByDeletedId]),
      2,
    );
    const mainlineAfter = after.find(r => r.conversation_id === f.chAll && r.root === null)!;
    expect(mainlineAfter.first_unread_message_id).toBe(f.chAllLatestId);
    expect(mainlineAfter.unread_count).toBe(1);
    // Subtracting every unread message in a stream removes the stream entirely.
    const gone = expectSameRows(
      f.db,
      POSITIONAL_STREAMS_SQL,
      LEGACY_POSITIONAL_STREAMS_SQL,
      activityBinds('local', f.wsA, [f.chAllByDeletedId, f.chAllLatestId]),
      1,
    );
    expect(gone.every(r => r.root !== null)).toBe(true);
  });

  it('the per-conversation DTO keeps its shape: sparse threads, decoded anchors, deleted author', () => {
    const f = buildFixture();
    const dto = f.reads.streamUnreadForConversation(f.chAll, 'local');
    expect(dto.mainline).toEqual({
      unread_count: 2,
      first_unread_message_id: f.chAllByDeletedId,
      first_unread_seq: expect.any(Number),
    });
    // Sparse: the followed thread (no cursor row) is present, the read-to-head
    // thread is ABSENT rather than a zero entry.
    expect(Object.keys(dto.threads)).toEqual([f.followedRoot]);
    expect(dto.threads[f.followedRoot]).toEqual({
      unread_count: 2,
      first_unread_message_id: f.followedFirstReplyId,
      first_unread_seq: expect.any(Number),
    });
    expect(dto.followed_thread_unread).toBe(true);

    // The Activity anchor for that same mainline is the deleted agent's message:
    // its send-time snapshot survives while the live join misses.
    const row = run(f.db, POSITIONAL_STREAMS_SQL, activityBinds('local', f.wsA, [])).find(
      r => r.conversation_id === f.chAll && r.root === null,
    )!;
    expect(row.from_kind).toBe('agent');
    expect(row.from_agent_id).toBe(null);
    expect(row.author_name).toBe('doomed');
    expect(row.live_name).toBe(null);
    expect(row.root_content).toBe(null);
  });

  it('a thread root id resolves only inside its own conversation', () => {
    const f = buildFixture();
    // Same-root-id-in-another-conversation is impossible to seed (a root id is a
    // message id, and the DB triggers pin a reply to its root's conversation),
    // so the falsifiable claim is the join scope: a stream enumerated for one
    // conversation must never pick up another conversation's messages. Reading
    // chAll while every other conversation also has unread proves it.
    const rows = run(f.db, STREAM_UNREAD_FOR_CONVERSATION_SQL, {
      conv: f.chAll,
      viewer: 'alice',
    });
    const roots = rows.map(r => r.root);
    expect(new Set(roots)).toEqual(new Set([null, f.followedRoot, f.readThreadRoot]));
    for (const r of rows) {
      const conv = f.db
        .prepare(`SELECT conversation_id FROM messages WHERE id = ?`)
        .get(r.first_unread_message_id as string) as { conversation_id: string };
      expect(conv.conversation_id).toBe(f.chAll);
    }
  });

  it('never bounds unread by the freshness head', () => {
    const f = buildFixture();
    // `conversation_stream_heads.latest_seq` may legitimately sit BELOW a
    // viewer's cursor (freshness-exempt rows advance `messages.seq` without
    // bumping it, §5.2), so it must only ENUMERATE streams. No data state can
    // falsify that today — every non-exempt insert bumps its head, and the one
    // exempt writer inserts system rows, which unread excludes — so the guard is
    // mechanical: the queries must not read the column at all.
    expect(STREAM_UNREAD_FOR_CONVERSATION_SQL).not.toContain('latest_seq');
    expect(POSITIONAL_STREAMS_SQL).not.toContain('latest_seq');
    // And the exempt-only conversation really has no head row to enumerate,
    // which is why "enumerate from heads" is safe only for system rows.
    const heads = f.db
      .prepare(`SELECT COUNT(*) AS n FROM conversation_stream_heads WHERE conversation_id = ?`)
      .get(f.chExemptOnly) as { n: number };
    expect(heads.n).toBe(0);
    expect(run(f.db, STREAM_UNREAD_FOR_CONVERSATION_SQL, {
      conv: f.chExemptOnly,
      viewer: 'local',
    })).toEqual([]);
  });
});

describe('#task:1967 query-plan contract', () => {
  const planOf = (db: Db, sql: string, binds: Record<string, unknown>): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(binds) as Array<{ detail: string }>)
      .map(r => r.detail)
      .join('\n');

  // The access path IS the deliverable of #1967, so it is asserted structurally
  // rather than by wall-clock: absolute ms would encode this machine, and a
  // sublinearity ratio would encode CI noise. Every assertion below is
  // falsifiable — the two `not` forms are the exact signatures of the two ways
  // this can regress:
  //   - `idx_conversation_reads_conversation` = the pre-#1967 cursor path (probe
  //     by conversation, then filter rows), which is what the new full index and
  //     the per-stream shape exist to replace;
  //   - `idx_messages_thread_root (conversation_id=?)` with NO `seq>?` term = the
  //     inverted loop, i.e. walking a conversation's whole history and testing
  //     each row against the stream set. The `seq>?` constraint is the range
  //     SEEK, and is the difference between "cost tracks the unread tail" and
  //     "cost tracks all history ever written".
  const INVERTED_LOOP = 'idx_messages_thread_root (conversation_id=?)';
  const LEGACY_CURSOR_PATH = 'idx_conversation_reads_conversation';
  const CURSOR_PROBE =
    'idx_conversation_reads_user_conversation_stream (user_id=? AND conversation_id=? AND thread_root_id=?)';
  const TAIL_SEEK =
    'idx_messages_thread_root (conversation_id=? AND thread_root_id=? AND seq>?)';
  const ANCHOR_LOOKUP = 'uniq_messages_conversation_seq (conversation_id=? AND seq=?)';

  /** A production-shaped history: one long-lived channel whose unread tail is a
   *  handful of rows at the end of thousands. The point of #1967 is that cost
   *  tracks the TAIL, so the plan must reach it by index seeks. */
  function buildScaleFixture(): Fixture {
    const f = buildFixture();
    for (let i = 0; i < 1200; i += 1) {
      f.messages.insertForConversation({
        conversationId: f.chAll,
        fromKind: 'user',
        fromUserId: 'bob',
        content: `history ${i}`,
      });
    }
    const tail = f.messages.insertForConversation({
      conversationId: f.chAll,
      fromKind: 'user',
      fromUserId: 'bob',
      content: 'tail',
    });
    f.reads.markRead({
      viewerUserId: 'local',
      conversationId: f.chAll,
      threadRootId: null,
      seq: tail.seq - 1,
    });
    return f;
  }

  it('reads.stream_unread_for_conversation: enumerate heads → seek cursor → range-scan the tail', () => {
    const f = buildScaleFixture();
    const plan = planOf(f.db, STREAM_UNREAD_FOR_CONVERSATION_SQL, {
      conv: f.chAll,
      viewer: 'local',
    });
    expect(plan).toContain(
      'idx_conversation_stream_heads_conversation (conversation_id=?)',
    );
    expect(plan).toContain(CURSOR_PROBE);
    expect(plan).toContain(TAIL_SEEK);
    expect(plan).toContain(ANCHOR_LOOKUP);
    expect(plan).not.toContain(LEGACY_CURSOR_PATH);
    expect(plan).not.toContain(INVERTED_LOOP);
    expect(plan).not.toMatch(/\bSCAN m\b/);
    // The one temp b-tree is the per-stream GROUP BY over the unread TAIL (a
    // handful of rows), not a sort of history: an ORDER BY / DISTINCT b-tree here
    // would mean something upstream is materializing more than the tail.
    expect(plan.match(/USE TEMP B-TREE/g)).toEqual(['USE TEMP B-TREE']);
    expect(plan).toContain('USE TEMP B-TREE FOR GROUP BY');
  });

  it('activity.positional_streams: enumerate entering streams → range-scan each tail', () => {
    const f = buildScaleFixture();
    const plan = planOf(f.db, POSITIONAL_STREAMS_SQL, activityBinds('local', null, []));
    // Enumeration starts from the viewer's memberships — the smallest set that
    // can bound the work — never from a message scan.
    expect(plan).toContain('idx_conversation_users_user (user_id=?)');
    expect(plan).toContain(
      'idx_conversation_stream_heads_conversation (conversation_id=?)',
    );
    expect(plan).toContain(CURSOR_PROBE);
    expect(plan).toContain(TAIL_SEEK);
    expect(plan).toContain(ANCHOR_LOOKUP);
    expect(plan).not.toContain(LEGACY_CURSOR_PATH);
    expect(plan).not.toContain(INVERTED_LOOP);
    expect(plan).not.toMatch(/\bSCAN m\b/);
    expect(plan.match(/USE TEMP B-TREE/g)).toEqual(['USE TEMP B-TREE']);
    expect(plan).toContain('USE TEMP B-TREE FOR GROUP BY');
  });
});
