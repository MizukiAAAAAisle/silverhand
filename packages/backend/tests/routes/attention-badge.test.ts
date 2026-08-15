import { afterEach, describe, expect, it } from 'vitest';
import { AttentionBadgeRepo } from '../../src/repos/attention-badge-repo.js';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { stream } from '../utils/destination.js';

// #task:1870 B — the TIERED BADGE projection.
//
//   badge(workspace) = Σ positional unread over `all`-tier conversations
//                    + Σ EFFECTIVE DIRECTED CLAIMS over `mentions`/`mute`-tier ones
//
// What this file pins down, in the order the bugs would bite:
//   - the per-tier matrix, including that a `mute`d channel still contributes its
//     directed residue (muting silences the ambient channel, never the person
//     addressing you);
//   - no double counting in the loud case (an `all`-tier conversation's positional
//     count already includes the @me message);
//   - archived ⇒ fail-closed on BOTH terms (they inherit `ROLLUP_UNREAD` /
//     `liveConversationPredicate` rather than restating liveness);
//   - the workspace SUPPRESSOR silences without rewriting — un-muting restores
//     each channel's own stored tier exactly;
//   - the three UPDATE SOURCES all emit, because the client never refetches this
//     badge on its own schedule (no polling, no focus refetch): a missing frame
//     stays wrong until a remount / reconnect / unrelated invalidation, not for a
//     moment. Two of the three (a pref write, a directed notification going
//     read) move the badge without moving any unread cursor.
//   - one arithmetic, three faces: the roll-up endpoint, the per-workspace hot
//     path and the event payload must agree — and NO fourth copy on another read
//     model (#task:1875 deleted the favorites one).
//   - the DIRECTED half is not a local rule: badge, `directed_unread_count` and
//     the Activity list all read ONE effective-claim definition
//     (`repos/directed-claim-predicate.ts`), so a duplicated notification or a
//     cursor-covered mention moves all three at once — never a lit badge pointing
//     at an empty Activity list.

const VIEWER = 'local';
const VIEWER_HANDLE = 'local-test';
/** How a message ADDRESSES the viewer (#task:2000): a canonical reference in
 *  prose. The plain `@handle` alias would render as a chip and notify nobody,
 *  so it cannot stand in for a mention in these fixtures. */
const VIEWER_REF = `<silverhand://human/${VIEWER_HANDLE}>`;

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id;
}

async function createWorkspaceChannel(t: TestApp): Promise<{
  workspaceId: string;
  channelId: string;
  aliceId: string;
}> {
  const aliceId = await makeAgent(t, 'alice-badge');
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: 'ws-badge',
      member_agent_ids: [aliceId],
    })
  ).json()) as any;
  return {
    workspaceId: workspace.workspace.id,
    channelId: workspace.onboarding_channel_id,
    aliceId,
  };
}

/** A second channel in the same workspace, so the two-term arithmetic can be
 *  observed across DIFFERENT tiers inside ONE badge.
 *
 *  `visibility` matters for one case only: self-leave refuses the LAST human
 *  member of a PRIVATE channel, so the membership test needs a public room. */
async function createSecondChannel(
  t: TestApp,
  workspaceId: string,
  aliceId: string,
  memberAgentIds?: string[],
  visibility?: 'public' | 'private',
): Promise<string> {
  const res = await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
    title: 'second-room',
    member_agent_ids: memberAgentIds ?? [aliceId],
    ...(visibility ? { visibility } : {}),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).channel.id;
}

/** The agents a message actually reached. In a CHANNEL an idle recipient is
 *  reached by being spawned (`runtimeHost.start`), not by an inbox row — the
 *  durable row is the thread-`observe` path — so all three are read here and the
 *  assertion is on their union.
 *
 *  `sinceStarts` / `sinceDelivered` cut off the runtime traffic that channel
 *  SETUP already produced, so the assertion is about the message under test and
 *  not about anything the fixture happened to wake earlier. */
function reachedAgents(
  t: TestApp,
  conversationId: string,
  since: { starts: number; delivered: number } = { starts: 0, delivered: 0 },
): Set<string> {
  const reached = new Set<string>();
  for (const s of t.fake.starts.slice(since.starts)) {
    if (s.conversationId === conversationId) reached.add(s.agentId);
  }
  for (const d of t.fake.delivered.slice(since.delivered)) {
    if (d.conversationId === conversationId) reached.add(d.agentId);
  }
  for (const row of t.ctx.db
    .prepare<[string], { agent_id: string }>(
      `SELECT DISTINCT agent_id FROM conversation_inboxes WHERE conversation_id = ?`,
    )
    .all(conversationId)) {
    reached.add(row.agent_id);
  }
  return reached;
}


/** Real send through the production service, so `mention_self` rows and unread
 *  come from the emission paths the badge actually reads. */
async function sendAsAgent(
  t: TestApp,
  channelId: string,
  agentId: string,
  content: string,
): Promise<string> {
  const result = await t.ctx.conversationMessageService.sendMessage({
    conversationId: channelId,
    actor: { kind: 'agent', agentId, conversationId: channelId },
    destination: stream(channelId),
    content,
  });
  return result.committed.message.id;
}

/** A THREAD reply under `rootMessageId`, sent through the same production
 *  service — so the mention's in-transaction thread auto-follow (the thing the
 *  loud-tier thread case depends on) is exercised, not simulated. */
async function sendAsThreadReply(
  t: TestApp,
  channelId: string,
  agentId: string,
  rootMessageId: string,
  content: string,
): Promise<string> {
  const result = await t.ctx.conversationMessageService.sendMessage({
    conversationId: channelId,
    actor: { kind: 'agent', agentId, conversationId: channelId },
    destination: stream(channelId, rootMessageId),
    content,
  });
  return result.committed.message.id;
}

async function setChannelTier(
  t: TestApp,
  channelId: string,
  mode: 'all' | 'mentions' | 'mute',
): Promise<void> {
  const res = await http(t).put(
    `/api/conversations/${channelId}/attention-preference`,
    { mode },
  );
  expect(res.status).toBe(200);
}

async function setWorkspaceMuted(
  t: TestApp,
  workspaceId: string,
  muted: boolean,
): Promise<void> {
  const res = await http(t).put(
    `/api/workspaces/${workspaceId}/attention-preference`,
    { muted },
  );
  expect(res.status).toBe(200);
}

async function badgeRollup(t: TestApp): Promise<{
  by_workspace: Record<string, number>;
  total: number;
  muted_workspace_ids: string[];
}> {
  const res = await http(t).get('/api/attention/badges');
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

/** The badge for ONE workspace as every face reports it, asserted to be the same
 *  number. Returns that agreed value. */
async function agreedBadge(t: TestApp, workspaceId: string): Promise<number> {
  const rollup = await badgeRollup(t);
  const fromRollup = rollup.by_workspace[workspaceId] ?? 0;
  const fromHotPath = new AttentionBadgeRepo(t.ctx.db).badgeCountForWorkspace(
    VIEWER,
    workspaceId,
  );
  expect(fromHotPath).toBe(fromRollup);
  return fromRollup;
}

async function modes(t: TestApp, workspaceId: string): Promise<any> {
  const res = await http(t).get(
    `/api/attention/modes?workspace_id=${workspaceId}`,
  );
  expect(res.status).toBe(200);
  return await res.json();
}

/** The Activity list — the OTHER face of the same directed claim. The badge is a
 *  COUNT of claims and Activity is a LIST of them, so reading both is what makes
 *  "the badge says 1 while Activity is empty" visible as a contradiction instead
 *  of two separately-plausible answers. */
async function activity(t: TestApp): Promise<any> {
  const res = await http(t).get('/api/activity');
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

/** A message's stream position, for driving a cursor to a known point. */
function seqOf(t: TestApp, messageId: string): number {
  return t.ctx.db
    .prepare<[string], { seq: number }>(`SELECT seq FROM messages WHERE id = ?`)
    .get(messageId)!.seq;
}

/** A SECOND `mention_self` row for the same message. Nothing in the schema
 *  forbids it (no unique index over (user, message, kind)), so "one claim per
 *  message" has to hold on the READ side — this is the shape that proves it
 *  does. */
function duplicateMentionRow(t: TestApp, messageId: string): void {
  const inserted = t.ctx.db
    .prepare(
      `INSERT INTO notifications
         (id, kind, user_id, agent_id, workspace_id, conversation_id, message_id,
          source_workspace_id, source_conversation_id, source_message_id,
          payload, read_at, created_at)
       SELECT 'dup_' || id, kind, user_id, agent_id, workspace_id,
              conversation_id, message_id, source_workspace_id,
              source_conversation_id, source_message_id, payload, read_at,
              created_at + 1
         FROM notifications
        WHERE message_id = ? AND kind = 'mention_self' AND user_id = ?`,
    )
    .run(messageId, VIEWER);
  expect(inserted.changes).toBe(1);
}

/** Advance ONE stream's read cursor exactly the way the production read path does
 *  (`ConversationReadRepo.markRead`) and NOTHING else — `notifications.read_at`
 *  stays NULL. That isolates §7's cursor conjunct: a face that reads only
 *  `read_at` will disagree here with every face that derives from the cursor. */
function advanceMainlineCursor(
  t: TestApp,
  conversationId: string,
  seq: number,
): void {
  new ConversationReadRepo(t.ctx.db).markRead({
    viewerUserId: VIEWER,
    conversationId,
    threadRootId: null,
    seq,
  });
}

function unreadMentionRowCount(t: TestApp, messageId: string): number {
  return t.ctx.db
    .prepare<[string, string], { c: number }>(
      `SELECT COUNT(*) AS c FROM notifications
        WHERE user_id = ? AND message_id = ?
          AND kind = 'mention_self' AND read_at IS NULL`,
    )
    .get(VIEWER, messageId)!.c;
}

/** Capture the frames published on ONE scope while `run` executes. */
async function captureScopeFrames(
  t: TestApp,
  scope: string,
  run: (app: TestApp) => Promise<void>,
): Promise<{ kind: string; payload: any }[]> {
  const frames: { kind: string; payload: any }[] = [];
  const unsub = t.ctx.events.subscribeScope(scope, e => {
    frames.push({ kind: e.kind, payload: e.payload });
  });
  try {
    await run(t);
  } finally {
    unsub();
  }
  return frames;
}

/** Capture viewer-scope frames while `run` executes. The app is handed back to
 *  the callback so call sites never have to re-narrow the nullable `t`. */
async function captureViewerFrames(
  t: TestApp,
  run: (app: TestApp) => Promise<void>,
): Promise<{ kind: string; payload: any }[]> {
  return await captureScopeFrames(t, `viewer:${VIEWER}`, run);
}

describe('tiered attention badge (#task:1870 B)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('all-tier: badge equals raw positional unread', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);

    await sendAsAgent(t, channelId, aliceId, 'one');
    await sendAsAgent(t, channelId, aliceId, 'two');

    expect(await agreedBadge(t, workspaceId)).toBe(2);
  });

  it('all-tier: an @me message is counted ONCE, not by both terms', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);

    await sendAsAgent(t, channelId, aliceId, 'one');
    await sendAsAgent(t, channelId, aliceId, 'two');
    await sendAsAgent(t, channelId, aliceId, `three ${VIEWER_REF}`);

    // 3, not 4: the positional term already includes the mention, so the directed
    // term is restricted to the conversations the positional term skipped.
    expect(await agreedBadge(t, workspaceId)).toBe(3);
  });

  it('mentions-tier: only the unread @me survives; plain ambient is silent', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    await setChannelTier(t, channelId, 'mentions');

    await sendAsAgent(t, channelId, aliceId, 'one');
    await sendAsAgent(t, channelId, aliceId, 'two');
    await sendAsAgent(t, channelId, aliceId, `look ${VIEWER_REF}`);

    expect(await agreedBadge(t, workspaceId)).toBe(1);
  });

  it('mute-tier: ambient is silent but the directed residue still reaches the human', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    await setChannelTier(t, channelId, 'mute');

    await sendAsAgent(t, channelId, aliceId, 'one');
    await sendAsAgent(t, channelId, aliceId, `look ${VIEWER_REF}`);

    // The tier that silences the CHANNEL never silences the PERSON addressing
    // you — that residue is the whole reason `mute` is a loudness level of one
    // badge rather than an eligibility switch.
    expect(await agreedBadge(t, workspaceId)).toBe(1);
  });

  it('two tiers in ONE workspace sum into one badge', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    const second = await createSecondChannel(t, workspaceId, aliceId);
    await setChannelTier(t, second, 'mentions');

    await sendAsAgent(t, channelId, aliceId, 'loud one');
    await sendAsAgent(t, channelId, aliceId, 'loud two');
    await sendAsAgent(t, second, aliceId, 'quiet plain');
    await sendAsAgent(t, second, aliceId, `quiet ${VIEWER_REF}`);

    // 2 positional (loud channel) + 1 directed (quiet channel) = 3.
    expect(await agreedBadge(t, workspaceId)).toBe(3);
  });

  it('all-tier THREAD @me counts exactly 1 — neither silent (auto-follow) nor doubled (partition)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);

    // Mainline root, then the @me lands as a THREAD reply under it.
    const rootId = await sendAsAgent(t, channelId, aliceId, 'root');
    await sendAsThreadReply(t, channelId, aliceId, rootId, `over here ${VIEWER_REF}`);

    // The directed claim exists…
    expect(
      t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM notifications
            WHERE user_id = ? AND kind = 'mention_self' AND read_at IS NULL`,
        )
        .get(VIEWER)!.c,
    ).toBe(1);

    // …and it is countable POSITIONALLY only because the mention made the viewer
    // a thread follower inside the send transaction: `ROLLUP_UNREAD`'s
    // followed-thread branch requires a `thread_followers` row, so without that
    // auto-follow the reply would be invisible to the positional term.
    expect(
      t.ctx.db
        .prepare<[string, string], { c: number }>(
          `SELECT COUNT(*) AS c FROM thread_followers
            WHERE thread_root_id = ? AND principal_kind = 'human' AND principal_id = ?`,
        )
        .get(rootId, VIEWER)!.c,
    ).toBe(1);

    // 2 = the mainline root + the thread @me. The two failure modes this pins
    // are opposite: 1 would mean a directed claim went SILENT in the loud tier
    // (auto-follow regressed and the directed term does not cover `all`-tier
    // channels by design); 3 would mean the partition leaked and the same
    // message was counted by both terms.
    expect(await agreedBadge(t, workspaceId)).toBe(2);
  });

  it('archived channel is fail-closed on BOTH terms', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);

    await sendAsAgent(t, channelId, aliceId, 'plain');
    await sendAsAgent(t, channelId, aliceId, `hey ${VIEWER_REF}`);
    expect(await agreedBadge(t, workspaceId)).toBe(2);

    const archived = await http(t).patch(`/api/channels/${channelId}/archive`, {
      archived: true,
    });
    expect(archived.status).toBe(200);

    // Both terms inherit liveness from the shared fragments rather than restating
    // it, so neither can leak past archive.
    expect(await agreedBadge(t, workspaceId)).toBe(0);
  });

  it('workspace mute suppresses ambient; un-muting restores each channel tier exactly', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    const second = await createSecondChannel(t, workspaceId, aliceId);
    await setChannelTier(t, second, 'mentions');

    await sendAsAgent(t, channelId, aliceId, 'loud one');
    await sendAsAgent(t, channelId, aliceId, 'loud two');
    await sendAsAgent(t, channelId, aliceId, `loud ${VIEWER_REF}`);
    await sendAsAgent(t, second, aliceId, 'quiet plain');
    expect(await agreedBadge(t, workspaceId)).toBe(3);

    await setWorkspaceMuted(t, workspaceId, true);
    // Every channel collapses to the directed residue: the one @me in the loud
    // channel. The stored tiers are untouched.
    expect(await agreedBadge(t, workspaceId)).toBe(1);
    const muted = await modes(t, workspaceId);
    expect(muted.muted).toBe(true);
    expect(
      muted.channels.find((c: any) => c.conversation_id === channelId),
    ).toMatchObject({ mode: 'all', effective_mode: 'mute' });
    expect(
      muted.channels.find((c: any) => c.conversation_id === second),
    ).toMatchObject({ mode: 'mentions', effective_mode: 'mute' });

    await setWorkspaceMuted(t, workspaceId, false);
    expect(await agreedBadge(t, workspaceId)).toBe(3);
    const unmuted = await modes(t, workspaceId);
    expect(unmuted.muted).toBe(false);
    expect(
      unmuted.channels.find((c: any) => c.conversation_id === channelId),
    ).toMatchObject({ mode: 'all', effective_mode: 'all' });
    expect(
      unmuted.channels.find((c: any) => c.conversation_id === second),
    ).toMatchObject({ mode: 'mentions', effective_mode: 'mentions' });
  });

  it('the raw positional roll-up is tier-INDEPENDENT (§8: the sidebar count does not move)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    await sendAsAgent(t, channelId, aliceId, 'one');
    await sendAsAgent(t, channelId, aliceId, 'two');

    const unreadBefore = (await (
      await http(t).get(`/api/conversations/${channelId}/unread`)
    ).json()) as any;

    await setChannelTier(t, channelId, 'mute');
    await setWorkspaceMuted(t, workspaceId, true);

    const unreadAfter = (await (
      await http(t).get(`/api/conversations/${channelId}/unread`)
    ).json()) as any;
    // The badge went quiet; the unread 口径 did not change. That separation is why
    // the badge rides its own event instead of redefining `unread_updated`.
    expect(unreadAfter).toEqual(unreadBefore);
    expect(await agreedBadge(t, workspaceId)).toBe(0);
  });

  it('favorites carries NO badge field — the badge has one carrier (#task:1875)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    await setChannelTier(t, channelId, 'mentions');
    await sendAsAgent(t, channelId, aliceId, 'plain one');
    await sendAsAgent(t, channelId, aliceId, 'plain two');
    await sendAsAgent(t, channelId, aliceId, `hey ${VIEWER_REF}`);
    // Favorites holds CONVERSATIONS (#task:1888) — star the channel itself.
    expect((await http(t).post(`/api/channels/${channelId}/star`)).status).toBe(200);

    const items = (await (await http(t).get('/api/favorites')).json()) as any;
    const row = items.items.find((i: any) => i.entity_id === channelId);
    // The tiered number is served by the badge face alone; favorites is not a
    // subscriber of `attention_badge_updated`, so a copy here would be a second
    // carrier nothing refreshes.
    expect(row.badge_count).toBeUndefined();
    expect(await agreedBadge(t, workspaceId)).toBe(1);
    // …while the row's own question ("how many messages are unread") is untouched.
    expect(row.unread_count).toBe(3);
  });

  it('rollup total is the sum and 0-badge workspaces are absent', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    const quiet = (await (
      await http(t).post('/api/workspaces', {
        name: 'ws-badge-quiet',
        member_agent_ids: [aliceId],
      })
    ).json()) as any;

    await sendAsAgent(t, channelId, aliceId, 'one');
    const rollup = await badgeRollup(t);
    expect(rollup.by_workspace[workspaceId]).toBe(1);
    expect(rollup.by_workspace[quiet.workspace.id]).toBeUndefined();
    expect(rollup.total).toBe(
      Object.values(rollup.by_workspace).reduce((s, n) => s + n, 0),
    );
  });

  it('the rollup carries the viewer MUTED workspaces, including ones at 0 (#task:1877)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    const quiet = (await (
      await http(t).post('/api/workspaces', {
        name: 'ws-muted-quiet',
        member_agent_ids: [aliceId],
      })
    ).json()) as any;

    expect((await badgeRollup(t)).muted_workspace_ids).toEqual([]);

    // The quiet workspace has NO entry in `by_workspace` (absent ≡ 0) — which is
    // the whole reason the marker is a sibling array: there is nothing to hang a
    // per-entry flag on, and muting something already at 0 is the common case.
    await setWorkspaceMuted(t, quiet.workspace.id, true);
    const muted = await badgeRollup(t);
    expect(muted.by_workspace[quiet.workspace.id]).toBeUndefined();
    expect(muted.muted_workspace_ids).toEqual([quiet.workspace.id]);

    // A muted workspace that is still LOUD (a directed claim pierces mute, §5.1)
    // appears in both places at once — the two facts are independent.
    await setChannelTier(t, channelId, 'mute');
    await sendAsAgent(t, channelId, aliceId, `hey ${VIEWER_REF}`);
    await setWorkspaceMuted(t, workspaceId, true);
    const both = await badgeRollup(t);
    expect(both.by_workspace[workspaceId]).toBe(1);
    expect(both.muted_workspace_ids).toContain(workspaceId);

    // Un-muting removes the id rather than storing a `false` the client must read.
    await setWorkspaceMuted(t, quiet.workspace.id, false);
    expect((await badgeRollup(t)).muted_workspace_ids).toEqual([workspaceId]);
  });

  it('muted ids follow CURRENT membership: removal drops the id, re-join restores it (#task:1877)', async () => {
    t = buildTestApp();
    const { workspaceId } = await createWorkspaceChannel(t);
    const workspaces = new WorkspaceRepo(t.ctx.db);

    await setWorkspaceMuted(t, workspaceId, true);
    expect((await badgeRollup(t)).muted_workspace_ids).toEqual([workspaceId]);

    // Removing the viewer from the workspace deletes `workspace_users` and LEAVES
    // the preference row (that table FKs to users/workspaces only) — so "a row
    // exists" is not "the viewer can still see it". A cold read must not hand back
    // a workspace the viewer no longer has access to.
    workspaces.removeUserMember(workspaceId, VIEWER);
    expect((await badgeRollup(t)).muted_workspace_ids).toEqual([]);
    // Precondition for the next half: the row itself survived, on purpose.
    expect(
      t.ctx.db
        .prepare<[string, string], { c: number }>(
          `SELECT COUNT(*) AS c FROM workspace_attention_preferences
            WHERE user_id = ? AND workspace_id = ? AND muted = 1`,
        )
        .get(VIEWER, workspaceId)!.c,
    ).toBe(1);

    // Re-joining restores the viewer's OWN earlier decision with no write on
    // either edge — which is why the collapse to "currently visible" belongs on
    // the read projection rather than in a deletion cascade.
    workspaces.addUserMember(workspaceId, VIEWER);
    expect((await badgeRollup(t)).muted_workspace_ids).toEqual([workspaceId]);
  });
});

describe('tiered badge update sources (#task:1870 B)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('a mention arriving in a mentions-tier channel emits the badge AFTER the notification row exists', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    await setChannelTier(t, channelId, 'mentions');

    const frames = await captureViewerFrames(t, async app => {
      await sendAsAgent(app, channelId, aliceId, `ping ${VIEWER_REF}`);
    });

    const badges = frames.filter(f => f.kind === 'attention_badge_updated');
    expect(badges).toHaveLength(1);
    // 1, not 0. The mention is the ONLY thing that makes this quiet channel loud,
    // so a badge computed before `notifyViewerMentionBestEffort` committed the
    // `mention_self` row would ship 0 — and the client, holding the badge with no
    // refetch, would stay at 0 until some unrelated event arrived.
    expect(badges[0]!.payload).toEqual({
      workspace_id: workspaceId,
      badge_count: 1,
    });
    expect(await agreedBadge(t, workspaceId)).toBe(1);
  });

  it('a channel tier write emits identity + absolute badge, and never unread_updated', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    await sendAsAgent(t, channelId, aliceId, 'one');
    await sendAsAgent(t, channelId, aliceId, 'two');

    const frames = await captureViewerFrames(t, async app => {
      await setChannelTier(app, channelId, 'mute');
    });

    expect(frames.map(f => f.kind)).not.toContain('unread_updated');
    const pref = frames.find(f => f.kind === 'attention_pref_changed');
    // Identity ONLY: carrying the new mode here would make the event a second
    // authority for state the read faces own.
    expect(pref?.payload).toEqual({
      workspace_id: workspaceId,
      conversation_id: channelId,
    });
    const badge = frames.find(f => f.kind === 'attention_badge_updated');
    expect(badge?.payload).toEqual({ workspace_id: workspaceId, badge_count: 0 });
  });

  it('a workspace mute write emits a workspace-wide identity frame (conversation_id null)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    await sendAsAgent(t, channelId, aliceId, 'one');

    const frames = await captureViewerFrames(t, async app => {
      await setWorkspaceMuted(app, workspaceId, true);
    });

    expect(frames.find(f => f.kind === 'attention_pref_changed')?.payload).toEqual({
      workspace_id: workspaceId,
      conversation_id: null,
    });
    expect(
      frames.find(f => f.kind === 'attention_badge_updated')?.payload,
    ).toEqual({ workspace_id: workspaceId, badge_count: 0 });
  });

  it('observe(notification) on a muted channel emits the badge even though no cursor moved', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    await setChannelTier(t, channelId, 'mute');
    await sendAsAgent(t, channelId, aliceId, `ping ${VIEWER_REF}`);
    expect(await agreedBadge(t, workspaceId)).toBe(1);

    const notifId = (
      t.ctx.db
        .prepare(
          `SELECT id FROM notifications
            WHERE user_id = ? AND kind = 'mention_self' AND read_at IS NULL`,
        )
        .get(VIEWER) as { id: string }
    ).id;

    const frames = await captureViewerFrames(t, async app => {
      const res = await http(app).post('/api/attention/observe', {
        sources: [{ kind: 'notification', notification_id: notifId }],
      });
      expect(res.status).toBe(200);
    });

    // A directed clear moves NO cursor, so nothing in the `unread_updated`
    // message-variant family would have carried the new badge.
    expect(
      frames.find(f => f.kind === 'attention_badge_updated')?.payload,
    ).toEqual({ workspace_id: workspaceId, badge_count: 0 });
    expect(await agreedBadge(t, workspaceId)).toBe(0);
  });

  it('POST /api/notifications/read emits a badge frame for the workspace that moved', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    await setChannelTier(t, channelId, 'mentions');
    await sendAsAgent(t, channelId, aliceId, `ping ${VIEWER_REF}`);
    expect(await agreedBadge(t, workspaceId)).toBe(1);

    const frames = await captureViewerFrames(t, async app => {
      const res = await http(app).post('/api/notifications/read', {
        conversation_id: channelId,
      });
      expect(res.status).toBe(200);
    });

    expect(
      frames.find(f => f.kind === 'attention_badge_updated')?.payload,
    ).toEqual({ workspace_id: workspaceId, badge_count: 0 });
    expect(await agreedBadge(t, workspaceId)).toBe(0);
  });

  it('POST /api/notifications/read emits NOTHING when the badge did not move', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    // Loud channel: the mention is already inside the positional term, so
    // clearing the directed row leaves the badge where it was.
    await sendAsAgent(t, channelId, aliceId, `ping ${VIEWER_REF}`);
    expect(await agreedBadge(t, workspaceId)).toBe(1);

    const frames = await captureViewerFrames(t, async app => {
      await http(app).post('/api/notifications/read', {
        conversation_id: channelId,
      });
    });

    expect(frames.map(f => f.kind)).not.toContain('attention_badge_updated');
    expect(await agreedBadge(t, workspaceId)).toBe(1);
  });
});

// The badge's arithmetic has TWO kinds of independent variable: loudness (the
// tiers, covered above) and the MEMBERSHIP EDGE both terms join on. The second
// one is deliberately NOT a push source — per §12 a membership transition is one
// domain fact whose viewer-local consumers converge on the events that already
// carry it, so the badge must be REFETCHED on `workspace_channels_changed` /
// `viewer_workspaces_changed` rather than waiting for a badge frame that never
// comes. These cells exist so nobody later reads "three update sources" as
// "three is the whole story".
describe('the effective directed claim: ONE definition, three faces (§7/§8)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('two notification rows for ONE message are ONE claim — badge, modes and Activity all say 1', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    const second = await createSecondChannel(t, workspaceId, aliceId);
    await setChannelTier(t, second, 'mute');

    const mentionId = await sendAsAgent(
      t,
      second,
      aliceId,
      `muted ${VIEWER_REF}`,
    );
    expect(await agreedBadge(t, workspaceId)).toBe(1);

    duplicateMentionRow(t, mentionId);
    // Two unread ROWS now exist for the one message…
    expect(unreadMentionRowCount(t, mentionId)).toBe(2);

    // …and every face still reports ONE claim. Counting rows would say 2 here
    // (badge) and 2 (per-channel explanation) while Activity — which de-dupes per
    // message — kept saying 1.
    expect(await agreedBadge(t, workspaceId)).toBe(1);
    const row = (await modes(t, workspaceId)).channels.find(
      (r: any) => r.conversation_id === second,
    );
    expect(row?.directed_unread_count).toBe(1);
    expect(
      ((await activity(t)).items as any[]).filter(
        i => i.conversation_id === second,
      ),
    ).toHaveLength(1);
    // The channel the mention did NOT land in is unaffected either way.
    expect(
      ((await activity(t)).items as any[]).filter(
        i => i.conversation_id === channelId,
      ),
    ).toEqual([]);
  });

  it('a cursor-covered mention is cleared on every face at once, with read_at still NULL', async () => {
    t = buildTestApp();
    const { workspaceId, aliceId } = await createWorkspaceChannel(t);
    const second = await createSecondChannel(t, workspaceId, aliceId);
    await setChannelTier(t, second, 'mute');

    const mentionId = await sendAsAgent(
      t,
      second,
      aliceId,
      `muted ${VIEWER_REF}`,
    );
    expect(await agreedBadge(t, workspaceId)).toBe(1);
    expect(
      ((await activity(t)).items as any[]).filter(
        i => i.conversation_id === second,
      ),
    ).toHaveLength(1);

    // The viewer reads the stream positionally. NOTHING collapses the
    // notification row — this is the exact state §7 calls "cursor-passed ⇒
    // directed cleared".
    advanceMainlineCursor(t, second, seqOf(t, mentionId));
    expect(unreadMentionRowCount(t, mentionId)).toBe(1);

    // All three faces clear together. A face reading only `read_at` would still
    // say 1 here — that is the reachable contradiction (lit badge, empty
    // Activity) this shared predicate exists to make impossible.
    expect(await agreedBadge(t, workspaceId)).toBe(0);
    const row = (await modes(t, workspaceId)).channels.find(
      (r: any) => r.conversation_id === second,
    );
    expect(row?.directed_unread_count).toBe(0);
    expect(
      ((await activity(t)).items as any[]).filter(
        i => i.conversation_id === second,
      ),
    ).toEqual([]);
  });
});

describe('membership: the badge’s fourth dependency (§8/§10)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('self-leave drops the channel’s contribution from badge AND modes — via the existing domain event, with NO badge frame', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    // Public: self-leave refuses the last human member of a private channel.
    const second = await createSecondChannel(
      t,
      workspaceId,
      aliceId,
      undefined,
      'public',
    );

    await sendAsAgent(t, channelId, aliceId, 'home one');
    await sendAsAgent(t, second, aliceId, 'public one');
    await sendAsAgent(t, second, aliceId, `public ${VIEWER_REF}`);
    expect(await agreedBadge(t, workspaceId)).toBe(3);

    const viewerFrames: { kind: string; payload: any }[] = [];
    const unsubViewer = t.ctx.events.subscribeScope(`viewer:${VIEWER}`, e => {
      viewerFrames.push({ kind: e.kind, payload: e.payload });
    });
    const workspaceFrames = await captureScopeFrames(
      t,
      `workspace:${workspaceId}`,
      async app => {
        const res = await http(app).post(`/api/channels/${second}/leave`, {});
        expect(res.status).toBe(200);
      },
    );
    unsubViewer();

    // The number MOVED without any of the three push sources firing: no message
    // arrived, no preference was written, no notification was read.
    expect(await agreedBadge(t, workspaceId)).toBe(1);
    const modeRows = (await modes(t, workspaceId)).channels as any[];
    expect(modeRows.map(r => r.conversation_id)).not.toContain(second);

    // NO dedicated badge event — this is the refetch-driven class…
    expect(viewerFrames.map(f => f.kind)).not.toContain('attention_badge_updated');
    // …and the signal the renderer must key off is the domain fact that DOES
    // fire, on a scope channel-membership loss does not take away.
    expect(
      workspaceFrames.filter(f => f.kind === 'workspace_channels_changed'),
    ).toHaveLength(1);
    expect(
      workspaceFrames.find(f => f.kind === 'workspace_channels_changed')?.payload,
    ).toEqual({ workspace_id: workspaceId, channel_id: second });
  });

  it('re-join restores the EDGE but not a cursor-covered claim — the two rules compose', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, aliceId } = await createWorkspaceChannel(t);
    const second = await createSecondChannel(
      t,
      workspaceId,
      aliceId,
      undefined,
      'public',
    );
    await setChannelTier(t, second, 'mute');
    await sendAsAgent(t, channelId, aliceId, 'home one');
    await sendAsAgent(t, second, aliceId, `muted ${VIEWER_REF}`);
    // 1 positional (home) + 1 directed residue (muted room).
    expect(await agreedBadge(t, workspaceId)).toBe(2);

    expect((await http(t).post(`/api/channels/${second}/leave`, {})).status).toBe(200);
    expect(await agreedBadge(t, workspaceId)).toBe(1);

    // Re-joining restores the membership edge, and the notification row + the
    // stored tier both survived (the seed contract is insert-only). The badge
    // still does NOT go back to 2: joining seeds a per-stream read baseline at
    // the current head (#task:1404 — pre-join history is not unread), so the old
    // mention is now cursor-covered and its EFFECTIVE directed claim is cleared.
    // That is the whole point of sharing one claim definition: Activity says the
    // same thing, so no lit badge can point at an empty list.
    expect((await http(t).post(`/api/channels/${second}/join`, {})).status).toBe(200);
    expect(await agreedBadge(t, workspaceId)).toBe(1);
    expect(
      ((await activity(t)).items as any[]).filter(
        i => i.conversation_id === second,
      ),
    ).toEqual([]);
    const row = (await modes(t, workspaceId)).channels.find(
      (r: any) => r.conversation_id === second,
    );
    expect(row?.mode).toBe('mute'); // stored tier survived the round trip
    expect(row?.directed_unread_count).toBe(0);

    // The edge IS the variable for anything the baseline did not cover: a fresh
    // mention after the re-join contributes again, with no badge frame involved.
    await sendAsAgent(t, second, aliceId, `muted again ${VIEWER_REF}`);
    expect(await agreedBadge(t, workspaceId)).toBe(2);
  });
});

describe('delivery ⊥ attention (§5.2)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('the loudest suppression a human can express still delivers to the agents', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice-orth');
    const bobId = await makeAgent(t, 'bob-orth');
    const workspace = (await (
      await http(t).post('/api/workspaces', {
        name: 'ws-orth',
        member_agent_ids: [aliceId, bobId],
      })
    ).json()) as any;
    const workspaceId = workspace.workspace.id as string;
    const channelId = await createSecondChannel(t, workspaceId, aliceId, [
      aliceId,
      bobId,
    ]);

    // Both suppressors at maximum: the channel is muted AND the whole workspace
    // is muted on top of it.
    await setChannelTier(t, channelId, 'mute');
    await setWorkspaceMuted(t, workspaceId, true);

    const since = {
      starts: t.fake.starts.length,
      delivered: t.fake.delivered.length,
    };

    const messageId = await sendAsAgent(t, channelId, aliceId, 'work continues');
    expect(messageId).toBeTruthy();

    // The human's attention state is a projection of the human's own queue. It
    // is NOT an eligibility switch on the message pipeline: @bob is still
    // reached and woken, because muting says what the human wants to see, never
    // what the workspace does.
    const reached = reachedAgents(t, channelId, since);
    expect(reached).toContain(bobId);

    // …and the human's side is genuinely silent, so the assertion above is not
    // passing because the suppression failed to apply.
    expect(await agreedBadge(t, workspaceId)).toBe(0);
  });
});
