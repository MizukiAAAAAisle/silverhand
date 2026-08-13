import { afterEach, describe, expect, it } from 'vitest';
import { ACTIVITY_ITEM_KINDS, type ActivityItemKind } from '@silverhand/shared';
import {
  ACTIVITY_SOURCE_IDS,
  type ActivitySourceId,
} from '../../src/read-model/activity.js';
import { LIVE_CONVERSATION_PREDICATE } from '../../src/repos/conversation-liveness.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

// #task:1410 — Class A hardening: Activity source × lifecycle conformance.
//
// The bug class this file makes structurally impossible: an Activity assembly
// path that forgets the lifecycle filter, so an archived / deleted conversation
// keeps leaking items into the list (the #1409 regression — the directed query
// missed `c.archived_at IS NULL` that the positional query had). Docs are only a
// reminder; this is the hard rule, in two enforcement layers:
//
//   SOURCE COMPLETENESS (the #1411-symmetric net, Cindy review) — the matrix is
//   keyed by the PRODUCTION source registry `ACTIVITY_SOURCE_IDS`. `SOURCE_CASES`
//   is `satisfies Record<ActivitySourceId, SourceCase[]>`, so a new source phase
//   added to the read-model's chokepoint without a lifecycle case fails to
//   COMPILE here. This closes the "new SAME-kind SQL source skips the matrix"
//   gap that a kind-keyed matrix alone could not (kind maximality below is kept
//   as a second net, not the only one).
//
//   LIFECYCLE BEHAVIOR (enumeration-independent) — for each registered source:
//   live ⇒ present, archived ⇒ absent, orphaned/deleted ⇒ absent. A source that
//   expresses liveness any way other than LIVE_CONVERSATION_PREDICATE leaks its
//   item past archive/delete → its `absent` assertion goes red.
//
// The read-model's assembly loops ACTIVITY_SOURCES (the chokepoint), so an
// item can only reach the output through a registered source — there is no
// inline-SQL path that bypasses this matrix.

let notifSeq = 0;
const uniqId = (p: string) => `${p}-${(++notifSeq).toString(36)}`;

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id;
}

async function createWorkspaceChannel(t: TestApp): Promise<{
  workspaceId: string;
  channelId: string;
  senderId: string;
}> {
  const alice = await makeAgent(t, 'alice-conf');
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: 'ws-activity-conformance',
      member_agent_ids: [alice],
    })
  ).json()) as any;
  const channelId = workspace.onboarding_channel_id as string;
  // Send from a real channel member (the workspace snapshot), not a guessed id.
  const senderRow = t.ctx.db
    .prepare(
      `SELECT agent_id FROM conversation_agents WHERE conversation_id = ? LIMIT 1`,
    )
    .get(channelId) as { agent_id: string } | undefined;
  return {
    workspaceId: workspace.workspace.id,
    channelId,
    senderId: senderRow?.agent_id ?? alice,
  };
}

async function sendAsAgent(
  t: TestApp,
  channelId: string,
  agentId: string,
  content: string,
  rootMsgId?: string,
): Promise<string> {
  const result = await t.ctx.conversationMessageService.sendMessage({
    conversationId: channelId,
    actor: { kind: 'agent', agentId, conversationId: channelId },
    content,
    ...(rootMsgId
      ? { target: { kind: 'thread' as const, message_id: rootMsgId } }
      : {}),
  });
  return result.committed.message.id;
}

async function getActivity(t: TestApp): Promise<any[]> {
  const res = await http(t).get('/api/activity');
  expect(res.status).toBe(200);
  return ((await res.json()) as any).items;
}

// ─────────────────────────── the source registry ───────────────────────────

interface SeedCtx {
  workspaceId: string;
  channelId: string;
  senderId: string;
}

interface SourceCase {
  /** Human label for a precise failure message ("source X leaks after archive"). */
  label: string;
  /** The Activity kind this source produces. */
  kind: ActivityItemKind;
  /** The PRODUCTION source phase (read-model `ACTIVITY_SOURCE_IDS`) this case
   *  exercises. `SOURCE_CASES` is filed by this id and cross-checked at runtime,
   *  so a case cannot claim to cover a phase it does not actually trigger. */
  sourceId: ActivitySourceId;
  /** Directed (notification-backed) sources are orphanable: a conversation
   *  delete sets `notifications.conversation_id` NULL (ON DELETE SET NULL),
   *  leaving the row without a live conversation. Positional sources compute
   *  from live messages+conversations JOINs, so a delete removes the rows
   *  outright — "orphan" is structurally impossible, tested via delete instead. */
  orphanable: boolean;
  /** Seed the source against the given channel; return a matcher that finds
   *  THIS source's own item in an Activity list. */
  seed: (t: TestApp, ctx: SeedCtx) => Promise<(item: any) => boolean>;
}

const MENTION_SOURCE: SourceCase = {
  label: 'directed mention (mention_self notification)',
  kind: 'mention',
  sourceId: 'directed_notification',
  orphanable: true,
  async seed(t, { channelId, senderId }) {
    const msgId = await sendAsAgent(t, channelId, senderId, 'ping <silverhand://human/local-test> please');
    return item => item.kind === 'mention' && item.message_id === msgId;
  },
};

const AGENT_FAILED_SOURCE: SourceCase = {
  label: 'directed agent_failed (agent_start_failed notification)',
  kind: 'agent_failed',
  sourceId: 'directed_notification',
  orphanable: true,
  async seed(t, { workspaceId, channelId }) {
    const id = uniqId('notif-af');
    t.ctx.db
      .prepare(
        `INSERT INTO notifications
           (id, kind, user_id, agent_id, workspace_id, conversation_id,
            message_id, payload, read_at, created_at)
         VALUES (@id, 'agent_start_failed', 'local', NULL, @ws, @conv,
            NULL, @payload, NULL, @now)`,
      )
      .run({
        id,
        ws: workspaceId,
        conv: channelId,
        payload: JSON.stringify({ agent_name: 'beth', error: 'spawn ENOENT' }),
        now: Date.now(),
      });
    return item => item.kind === 'agent_failed' && item.notification_id === id;
  },
};

const CHANNEL_UNREAD_SOURCE: SourceCase = {
  label: 'ambient channel-mainline unread (positional)',
  kind: 'unread',
  sourceId: 'positional_stream',
  orphanable: false,
  async seed(t, { channelId, senderId }) {
    // Default channel attention pref = 'all' → a plain mainline message enters
    // as ambient unread for the viewer.
    await sendAsAgent(t, channelId, senderId, 'plain ambient message, no mention');
    return item =>
      item.kind === 'unread' &&
      item.conversation_id === channelId &&
      item.thread_root_id === null;
  },
};

const THREAD_UNREAD_SOURCE: SourceCase = {
  label: 'ambient thread unread (positional, followed cluster)',
  kind: 'unread',
  sourceId: 'positional_stream',
  orphanable: false,
  async seed(t, { channelId, senderId }) {
    const rootMsg = await sendAsAgent(t, channelId, senderId, 'THREAD root for conformance');
    await sendAsAgent(t, channelId, senderId, 'reply inside the thread', rootMsg);
    // Follow the cluster (delivery precondition); parent pref 'all' → thread
    // ambient enters (#task:1268 aggregate-floor).
    t.ctx.db
      .prepare(
        `INSERT INTO thread_followers
           (thread_root_id, conversation_id, principal_kind, principal_id,
            followed_at, source)
         VALUES (?, ?, 'human', 'local', ?, 'manual')`,
      )
      .run(rootMsg, channelId, Date.now());
    return item => item.kind === 'unread' && item.thread_root_id === rootMsg;
  },
};

/**
 * The lifecycle matrix, keyed by the PRODUCTION source registry. `satisfies
 * Record<ActivitySourceId, SourceCase[]>` is the compile-time hard rule: add a
 * new phase to the read-model's `ACTIVITY_SOURCE_IDS` and this object no longer
 * satisfies the record → typecheck fails until the new source gets ≥1
 * lifecycle-tested case. A kind-keyed matrix could not catch a new SAME-kind
 * source (e.g. a third query that also produces `unread`); keying off the
 * production source id does.
 */
const SOURCE_CASES = {
  directed_notification: [MENTION_SOURCE, AGENT_FAILED_SOURCE],
  positional_stream: [CHANNEL_UNREAD_SOURCE, THREAD_UNREAD_SOURCE],
} satisfies Record<ActivitySourceId, SourceCase[]>;

const ALL_SOURCES: SourceCase[] = ACTIVITY_SOURCE_IDS.flatMap(id => SOURCE_CASES[id]);

// ──────────────────────────────── the tests ────────────────────────────────

describe('Activity lifecycle conformance (#task:1410)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('the shared LIVE_CONVERSATION_PREDICATE gates on both existence and archival', () => {
    // The single source of the lifecycle rule. `c.id IS NOT NULL` drops orphans
    // (deleted conversation → notification.conversation_id NULL); `archived_at
    // IS NULL` drops archived. Both clauses are load-bearing — see #1409.
    expect(LIVE_CONVERSATION_PREDICATE).toContain('c.id IS NOT NULL');
    expect(LIVE_CONVERSATION_PREDICATE).toContain('c.archived_at IS NULL');
  });

  it('COMPLETENESS: every production Activity source id has a lifecycle case filed under it', () => {
    // Compile-time, `satisfies Record<ActivitySourceId, SourceCase[]>` already
    // forces an entry per source id; these runtime checks close what the type
    // cannot: an empty array (satisfies `SourceCase[]`) and a case misfiled
    // under a source id it does not actually exercise.
    for (const id of ACTIVITY_SOURCE_IDS) {
      expect(SOURCE_CASES[id].length).toBeGreaterThan(0);
      for (const c of SOURCE_CASES[id]) expect(c.sourceId).toBe(id);
    }
  });

  it('MAXIMALITY (second net): seeding every source surfaces every declared kind live', async () => {
    t = buildTestApp();
    const ctx = await createWorkspaceChannel(t);
    for (const src of ALL_SOURCES) await src.seed(t, ctx);

    const observed = new Set((await getActivity(t)).map(i => i.kind));
    const declared = new Set<string>(ACTIVITY_ITEM_KINDS);
    // Equality both ways: a declared kind with no seeding source (⊊) means the
    // matrix would silently skip it; an observed-but-undeclared kind (⊋) means
    // the DTO union drifted from what the read-model emits.
    expect(observed).toEqual(declared);
  });

  // ── LIFECYCLE MATRIX: one isolated app per source so a leak names its source ──

  for (const src of ALL_SOURCES) {
    it(`ARCHIVE drops: ${src.label}`, async () => {
      t = buildTestApp();
      const ctx = await createWorkspaceChannel(t);
      const matches = await src.seed(t, ctx);

      // Live: the source's own item is present.
      expect((await getActivity(t)).some(matches)).toBe(true);

      // Archive the conversation via the real route (route-level conformance).
      const archived = await http(t).patch(`/api/channels/${ctx.channelId}/archive`, {
        archived: true,
      });
      expect(archived.status).toBe(200);

      // Archived ⇒ absent. Both this source's item AND anything else anchored to
      // the archived conversation must be gone.
      const items = await getActivity(t);
      expect(items.some(matches)).toBe(false);
      expect(items.some(i => i.conversation_id === ctx.channelId)).toBe(false);
    });
  }

  for (const src of ALL_SOURCES.filter(s => s.orphanable)) {
    it(`ORPHAN (conversation_id → NULL) drops: ${src.label}`, async () => {
      t = buildTestApp();
      const ctx = await createWorkspaceChannel(t);
      const matches = await src.seed(t, ctx);
      expect((await getActivity(t)).some(matches)).toBe(true);

      // Simulate the ON DELETE SET NULL end-state a conversation delete produces
      // for a directed notification (orphaned: row survives, conversation gone).
      t.ctx.db
        .prepare(`UPDATE notifications SET conversation_id = NULL WHERE user_id = 'local'`)
        .run();

      expect((await getActivity(t)).some(matches)).toBe(false);
    });
  }

  it('DELETE (conversation cascade) drops every source at once', async () => {
    t = buildTestApp();
    const ctx = await createWorkspaceChannel(t);
    for (const src of ALL_SOURCES) await src.seed(t, ctx);
    expect((await getActivity(t)).length).toBeGreaterThan(0);

    // Hard-delete the conversation row: messages CASCADE-delete (positional
    // sources vanish), notifications.conversation_id → NULL (directed sources
    // orphan). FK enforcement is ON (db.ts). listActivity must survive with no
    // leaked item — the enumeration-independent invariant.
    t.ctx.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(ctx.channelId);

    const items = await getActivity(t);
    expect(items.some(i => i.conversation_id === ctx.channelId)).toBe(false);
    expect(items).toHaveLength(0);
  });

  it('DELETE workspace (route cascade) leaves an empty Activity list', async () => {
    t = buildTestApp();
    const ctx = await createWorkspaceChannel(t);
    for (const src of ALL_SOURCES) await src.seed(t, ctx);
    expect((await getActivity(t)).length).toBeGreaterThan(0);

    // Workspace delete CASCADEs conversations (positional) and notification rows
    // (notifications.workspace_id ON DELETE CASCADE), so nothing anchors an item.
    const res = await http(t).del(`/api/workspaces/${ctx.workspaceId}`);
    expect(res.status).toBe(204);

    expect(await getActivity(t)).toHaveLength(0);
  });
});
