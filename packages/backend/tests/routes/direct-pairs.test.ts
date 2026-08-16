/**
 * #task:2035 — the Direct Messages list at the wire: `GET /api/direct-pairs` plus
 * the viewer-scoped `direct_pairs_changed` frame that makes a line appear without
 * a reload.
 *
 * THE ACCEPTANCE CRITERION, verbatim (@shiki): 「某个不是我创建的，从来也没跟我 DM
 * 过的 agent，在第一次 DM 我的时候，我的 sidebar 是要能够即时出现这个消息的。」 Everything
 * in the first test exists to make that one sentence checkable, including what
 * makes the sender a STRANGER: it is agent-scoped (an agent spawned by another
 * agent, not a seat the viewer opened), it shares no workspace with the viewer, and
 * there is no pair row — so before the send the viewer's list is empty and no
 * client cache holds anything about it.
 *
 * WHY THE `message` FRAME CANNOT BE THE PROOF, and why this file asserts that
 * explicitly: a client is subscribed to `conversation:<id>` for conversations it
 * has open, and this one has never been open. A test that watched the conversation
 * scope would go green while the real sidebar stayed empty — the exact false green
 * the original bug hid behind (`conversationViewerUserIds` read the roster, which is
 * authoritative for the WORKSPACE arm only, so every viewer frame for a DM went to
 * nobody). So the frames are captured on EVERY scope and the assertion is about
 * WHICH scope carried the discovery.
 *
 * The list itself is the authority for membership, order and unread; the frame is a
 * hint (see `DirectPairsChangedPayload`). Hence every test here asserts the pair:
 * the frame fired, and the re-read then shows the row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiPaths,
  internalPaths,
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
  type DirectPairListItem,
  type DirectPairListResponse,
  type ScheduleDto,
} from '@silverhand/shared';
import {
  buildTestApp,
  http,
  issueTestConversationRuntimeToken,
  type TestApp,
} from '../utils/app.js';
import { agentSlotAuth, insertAgentScopedAgent } from '../utils/agent-scope.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { ScheduleRepo } from '../../src/repos/schedule-repo.js';
import { createSqliteAgentTeardownPersistence } from '../../src/repos/agent-teardown-persistence.js';
// The pair under the route funnel, imported so one test can call it WITHOUT the
// funnel — the only way to check that the announcement travels with the mint rather
// than with the agent-route surface (@Cindy B4).
import { resolveDeliveryTarget } from '../../src/application/delivery-target-resolution.js';
import { deliveryTargetPorts } from '../../src/repos/delivery-target-persistence.js';

/** The viewer handle the test fixture registers for `viewerUserId` (`tests/utils/db.ts`). */
const VIEWER_HANDLE = 'local-test';
/** The second registered human — a viewer whose lines must never show up in the first's. */
const OTHER_USER_ID = 'teammate';

interface Frame {
  scope: string;
  kind: string;
  payload: unknown;
}

/**
 * Every frame published on EVERY scope while `run` executed.
 *
 * Deliberately not `subscribeScope('viewer:<id>')`: the interesting facts here are
 * negative ones about OTHER scopes — that the discovery did not depend on the
 * conversation stream, and that the workspace-keyed unread frame was not emitted for
 * a placement that has no workspace. A per-scope subscription cannot see either.
 * Calls through, so replay buffers and seq counters behave exactly as in production.
 */
async function framesDuring(t: TestApp, run: () => Promise<void>): Promise<Frame[]> {
  const frames: Frame[] = [];
  const publish = t.ctx.events.publishToScope.bind(t.ctx.events);
  const spy = vi
    .spyOn(t.ctx.events, 'publishToScope')
    .mockImplementation((scope: string, kind: string, payload: unknown) => {
      frames.push({ scope, kind, payload });
      publish(scope, kind, payload);
    });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return frames;
}

/** A conversation-scoped agent the VIEWER created — only ever the parent of the
 *  stranger below, never an endpoint of the lines under test. */
async function makeAgent(t: TestApp, name: string): Promise<string> {
  const r = await http(t).post('/api/agents', { name, runtime: 'claude' });
  expect(r.status).toBe(201);
  return ((await r.json()) as any).agent.id as string;
}

/** The same agent plus its `agent_home` DM channel id — a conversation it is a
 *  roster member of, which is what a ConversationSlot credential needs to exist in.
 *  `schedule create` is an `agent_participation` door for both slot kinds, so this
 *  credential may address a pair that is not the stream it lives in. */
async function makeAgentWithHome(
  t: TestApp,
  name: string,
): Promise<{ agentId: string; homeChannelId: string }> {
  const r = await http(t).post('/api/agents', { name, runtime: 'claude' });
  expect(r.status).toBe(201);
  const body = (await r.json()) as any;
  expect(typeof body.dm_channel_id).toBe('string');
  t.fake.starts = [];
  t.fake.delivered = [];
  return { agentId: body.agent.id as string, homeChannelId: body.dm_channel_id as string };
}

/** `schedule create` through the agent door, addressed at a DM. The wake
 *  DESTINATION is the address (#task:2021 P4-4), which is why this door reaches the
 *  resolver's allocating arm without sending anything. */
function createSchedule(
  t: TestApp,
  auth: Record<string, string>,
  agentId: string,
  target: string,
): Promise<Response> {
  return http(t, auth).post(internalPaths.agentScheduleCreate(agentId), {
    title: 'wake',
    message: 'do the thing',
    target_conversation: target,
    spec: { kind: 'once', delay_seconds: 60 },
  });
}

async function listDirectPairs(
  t: TestApp,
  userId?: string,
): Promise<DirectPairListItem[]> {
  const r = await http(
    t,
    userId === undefined
      ? undefined
      : { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(userId) },
  ).get(apiPaths.directPairs);
  expect(r.status).toBe(200);
  return ((await r.json()) as DirectPairListResponse).direct_pairs;
}

/** The stranger's send, through the real addressing path: `dm:@handle` on a main-line
 *  write is the resolver's one allocating arm, so THIS is what opens the pair. */
async function dmTheViewerAck(
  t: TestApp,
  agentId: string,
  content: string,
): Promise<{ conversation_id: string; unresolved_references?: unknown[] }> {
  const r = await http(t, agentSlotAuth(t, agentId)).post(
    internalPaths.agentSendConversationMessage(agentId),
    { content, target: `dm:@${VIEWER_HANDLE}` },
  );
  expect(r.status).toBe(200);
  return (await r.json()) as any;
}

async function dmTheViewer(
  t: TestApp,
  agentId: string,
  content: string,
): Promise<string> {
  return (await dmTheViewerAck(t, agentId, content)).conversation_id;
}

function viewerFrames(frames: Frame[], t: TestApp): Frame[] {
  return frames.filter(f => f.scope === `viewer:${t.viewerUserId}`);
}

describe('GET /api/direct-pairs + direct_pairs_changed', () => {
  let t: TestApp | null = null;
  /** The fixture's scheduler clock, for the two schedule tests below. A schedule is
   *  due only relative to a clock, and the minimum one-shot delay is 30s of real
   *  time, so seeing a fire means moving time rather than waiting for it. */
  let now = 0;
  beforeEach(() => {
    now = Date.now();
  });
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it("a stranger agent's first DM appears in the viewer's list, announced on the viewer's own scope", async () => {
    t = buildTestApp();
    const parent = await makeAgent(t, 'parent');
    const stranger = insertAgentScopedAgent(t, parent, 'stranger');

    // Before the send there is no line and nothing to patch: this is the case the
    // frame exists for.
    expect(await listDirectPairs(t)).toEqual([]);

    let conversationId = '';
    const frames = await framesDuring(t, async () => {
      conversationId = await dmTheViewer(t!, stranger, 'first contact');
    });

    // TWO frames on a FIRST contact, and exactly two: the line came into existence
    // (the resolver's allocating arm, announced by the mint itself) and then it
    // got its first message. Both are real changes to what this list shows —
    // membership, then unread — and each is announced once. Collapsing them would
    // need the allocation site to know whether its caller is going to send
    // afterwards, which is the per-door knowledge that produced the missing
    // create-time emit in the first place (see `directPairAllocationPort`).
    // The frame is an invalidation, so the cost is one extra
    // `GET /api/direct-pairs` on the first contact of a pair, ever.
    const expectedFrame = {
      scope: `viewer:${t.viewerUserId}`,
      kind: 'direct_pairs_changed',
      payload: { conversation_id: conversationId },
    };
    expect(viewerFrames(frames, t)).toEqual([expectedFrame, expectedFrame]);
    // The falsifier: the message frame rides ONLY the conversation scope, which
    // this viewer cannot be subscribed to (the line has never been open). If the
    // sidebar's discovery ever comes to depend on it, the viewer-scoped assertion
    // above is what fails.
    expect(
      frames.filter(f => f.kind === 'message').map(f => f.scope),
    ).toEqual([`conversation:${conversationId}`]);
    // The workspace-keyed read model has no coordinate for a `direct_pair`, so its
    // frames must not be emitted at all — not with a fabricated workspace, not with
    // a null one.
    expect(
      frames.filter(
        f => f.kind === 'unread_updated' || f.kind === 'attention_badge_updated',
      ),
    ).toEqual([]);

    expect(await listDirectPairs(t)).toEqual([
      {
        conversation_id: conversationId,
        counterpart: {
          status: 'active',
          kind: 'agent',
          id: stranger,
          name: 'stranger',
          display_name: 'stranger',
          avatar_url: null,
          runtime: 'claude',
        },
        unread_count: 1,
        read_only: false,
        created_at: expect.any(Number),
      },
    ]);
  });

  it('a second DM moves the same row: one line, one frame per send, unread accumulates', async () => {
    t = buildTestApp();
    const parent = await makeAgent(t, 'parent');
    const stranger = insertAgentScopedAgent(t, parent, 'stranger');
    const conversationId = await dmTheViewer(t, stranger, 'first contact');

    const frames = await framesDuring(t, async () => {
      const again = await dmTheViewer(t!, stranger, 'still here');
      // The allocating arm is get-OR-create: the second send lands in the same row.
      expect(again).toBe(conversationId);
    });

    // Announced again — the hint is per change, and a consumer that already holds
    // the row re-reads it for the new unread rather than being handed a delta.
    expect(viewerFrames(frames, t).map(f => f.kind)).toEqual([
      'direct_pairs_changed',
    ]);
    const rows = await listDirectPairs(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ conversation_id: conversationId, unread_count: 2 });
  });

  it('lists only the lines the asking viewer is an endpoint of, oldest first', async () => {
    t = buildTestApp();
    const parent = await makeAgent(t, 'parent');
    const first = insertAgentScopedAgent(t, parent, 'first');
    const second = insertAgentScopedAgent(t, parent, 'second');
    const conversations = new ConversationRepo(t.ctx.db);
    // Explicit `now`s: `created_at` IS this list's order, so the assertion must not
    // race the clock.
    const older = conversations.getOrCreateDirectPair(
      { kind: 'agent', id: first },
      { kind: 'human', id: t.viewerUserId },
      1_000,
    ).conversation.id;
    const newer = conversations.getOrCreateDirectPair(
      { kind: 'agent', id: second },
      { kind: 'human', id: t.viewerUserId },
      2_000,
    ).conversation.id;
    // Someone else's line with the same agent: the transpose is keyed by the ASKING
    // viewer, so this must be invisible on one face and the only row on the other.
    const theirs = conversations.getOrCreateDirectPair(
      { kind: 'agent', id: first },
      { kind: 'human', id: OTHER_USER_ID },
      3_000,
    ).conversation.id;

    expect((await listDirectPairs(t)).map(row => row.conversation_id)).toEqual([
      older,
      newer,
    ]);
    expect(
      (await listDirectPairs(t, OTHER_USER_ID)).map(row => row.conversation_id),
    ).toEqual([theirs]);
  });

  it("keeps the survivor's line when the counterpart is gone: deleted counterpart, read-only row", async () => {
    t = buildTestApp();
    const parent = await makeAgent(t, 'parent');
    const stranger = insertAgentScopedAgent(t, parent, 'stranger');
    const conversationId = await dmTheViewer(t, stranger, 'first contact');

    createSqliteAgentTeardownPersistence(t.ctx.db).uow.atomicallyForAgent(
      { agentId: stranger },
      tx => {
        tx.agent.deleteAgentRow();
        return 0;
      },
    );

    // The endpoint coordinate outlives the principal (v73), so the line stays — as
    // history the viewer can read and cannot post to. Identity-only counterpart: a
    // deleted agent has no current display identity to project.
    const rows = await listDirectPairs(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversation_id).toBe(conversationId);
    expect(rows[0]!.counterpart).toEqual({
      status: 'deleted',
      kind: 'agent',
      id: stranger,
    });
    expect(rows[0]!.read_only).toBe(true);
  });

  // ── The read side: clearing a DM's unread is a change to the same row ──────────

  it('observing a DM lowers its unread and announces the list, without a workspace frame', async () => {
    // The bug this pins: `observe()`'s post-commit loop asked
    // `requireWorkspacePlacement` unconditionally, so a DirectPair source COMMITTED
    // the cursor and then threw — HTTP 500 to a client whose read had in fact
    // landed, and no frame at all. "Cursor lowered, 500 returned, client never
    // told" is the worst of both outcomes, which is why the placement split lives at
    // this caller and not inside the workspace-keyed publisher.
    t = buildTestApp();
    const parent = await makeAgent(t, 'parent');
    const stranger = insertAgentScopedAgent(t, parent, 'stranger');
    const conversationId = await dmTheViewer(t, stranger, 'first contact');
    expect((await listDirectPairs(t))[0]!.unread_count).toBe(1);

    let res: Response | null = null;
    const frames = await framesDuring(t, async () => {
      res = await http(t!).post(apiPaths.attentionObserve, {
        sources: [
          {
            kind: 'stream',
            conversation_id: conversationId,
            thread_root_id: null,
            position: { kind: 'stream_head' },
          },
        ],
      });
    });

    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ changed: true });
    expect(
      new ConversationReadRepo(t.ctx.db).unreadCountForConversation(
        conversationId,
        t.viewerUserId,
      ),
    ).toBe(0);
    // ONE frame, to the observer only: this batch moved their read state and nobody
    // else's. And the workspace-keyed pair must not appear — a `direct_pair` has no
    // coordinate in that read model.
    expect(viewerFrames(frames, t)).toEqual([
      {
        scope: `viewer:${t.viewerUserId}`,
        kind: 'direct_pairs_changed',
        payload: { conversation_id: conversationId },
      },
    ]);
    expect(
      frames.filter(
        f => f.kind === 'unread_updated' || f.kind === 'attention_badge_updated',
      ),
    ).toEqual([]);
    expect((await listDirectPairs(t))[0]!.unread_count).toBe(0);
  });

  // ── Membership: a door that OPENS a line without sending into it ───────────────

  it('a schedule addressed at a DM opens the line and announces it, with no message in it', async () => {
    // `schedule create --target-conversation dm:@handle` stores a destination, which
    // has to exist first — so this door reaches the resolver's allocating arm while
    // sending nothing. Before #task:2035 the pair appeared in a cold
    // `GET /api/direct-pairs` and the live sidebar never heard about it, which is why
    // the announcement belongs to the RESOLUTION funnel rather than to the send.
    t = buildTestApp({ scheduleNow: () => now });
    const { agentId, homeChannelId } = await makeAgentWithHome(t, 'scheduler');
    const auth = {
      authorization: `Bearer ${issueTestConversationRuntimeToken(t, homeChannelId, agentId)}`,
    };

    let res: Response | null = null;
    const frames = await framesDuring(t, async () => {
      res = await createSchedule(t!, auth, agentId, `dm:@${VIEWER_HANDLE}`);
    });
    expect(res!.status).toBe(200);
    const { schedule } = (await res!.json()) as { schedule: ScheduleDto };

    const pair = new ConversationRepo(t.ctx.db).findDirectPair(
      { kind: 'agent', id: agentId },
      { kind: 'human', id: t.viewerUserId },
    );
    expect(pair).not.toBeNull();
    expect(schedule.target_conversation_id).toBe(pair!.id);
    expect(viewerFrames(frames, t)).toEqual([
      {
        scope: `viewer:${t.viewerUserId}`,
        kind: 'direct_pairs_changed',
        payload: { conversation_id: pair!.id },
      },
    ]);
    // Membership without a message: the row is in the list, and its unread is 0.
    expect(await listDirectPairs(t)).toEqual([
      {
        conversation_id: pair!.id,
        counterpart: {
          status: 'active',
          kind: 'agent',
          id: agentId,
          name: 'scheduler',
          display_name: 'scheduler',
          avatar_url: null,
          runtime: 'claude',
        },
        unread_count: 0,
        read_only: false,
        created_at: expect.any(Number),
      },
    ]);
  });

  it('announces the line even when the operation that opened it then fails', async () => {
    // The boundary (@Cindy): the frame announces a ROW THAT EXISTS, not an operation
    // that succeeded. The mint is its own committed statement, so a door that refuses
    // afterwards still leaves the viewer a line — and withdrawing the frame would
    // leave the live client unable to learn about a row a cold read shows. Here the
    // refusal is `agent_home_not_found`: an agent-scoped agent has no `agent_home`
    // DM channel, which `ScheduleService.create` requires, and it is judged AFTER the
    // address resolved.
    t = buildTestApp({ scheduleNow: () => now });
    const parent = await makeAgent(t, 'parent');
    const stranger = insertAgentScopedAgent(t, parent, 'stranger');

    let res: Response | null = null;
    const frames = await framesDuring(t, async () => {
      res = await createSchedule(
        t!,
        agentSlotAuth(t!, stranger),
        stranger,
        `dm:@${VIEWER_HANDLE}`,
      );
    });

    expect(res!.status).toBe(404);
    expect((await res!.json()) as any).toMatchObject({ code: 'agent_home_not_found' });
    expect(new ScheduleRepo(t.ctx.db).listForAgent(stranger, null, 200)).toEqual([]);

    const pair = new ConversationRepo(t.ctx.db).findDirectPair(
      { kind: 'agent', id: stranger },
      { kind: 'human', id: t.viewerUserId },
    );
    expect(pair).not.toBeNull();
    expect(viewerFrames(frames, t)).toEqual([
      {
        scope: `viewer:${t.viewerUserId}`,
        kind: 'direct_pairs_changed',
        payload: { conversation_id: pair!.id },
      },
    ]);
    expect((await listDirectPairs(t)).map(row => row.conversation_id)).toEqual([
      pair!.id,
    ]);
  });

  it('a resolver call OUTSIDE the route funnel still announces the line it opened', async () => {
    // @Cindy's mutation, run as a test instead of argued about: a door that does not
    // exist yet — the human-initiated "Message this agent" open (#task:2036) is the
    // known one — calling `resolveDeliveryTarget` directly, with the production ports
    // and no `resolveDeliveryTargetForRoute` anywhere in the call stack.
    //
    // Under the previous shape this passed silently. The answer carried a `created`
    // flag and the ONE agent-route funnel consumed it, so "every door announces" was
    // a property of who the callers happened to be: this call minted the row, the
    // funnel's announce step never ran, and the viewer's list gained a line a live
    // client could not learn about — the original #task:2035 bug, re-entering through
    // a new door. What announces here is not this call site's discipline: it is the
    // `allocations` port the caller had to be handed in order to resolve at all.
    //
    // No message is sent, on purpose. The frame under test is the one that says the
    // LIST changed, and this is the shape where it is the only frame there is.
    t = buildTestApp();
    const parent = await makeAgent(t, 'parent');
    const stranger = insertAgentScopedAgent(t, parent, 'stranger');
    const { agents, conversations, messages, users, workspaces } = t.persistence.repos;

    expect(await listDirectPairs(t)).toEqual([]);

    let conversationId = '';
    const frames = await framesDuring(t, async () => {
      const answer = resolveDeliveryTarget(
        deliveryTargetPorts({
          agents,
          conversations,
          messages,
          users,
          workspaces,
          logger: t!.ctx.logger,
          events: t!.ctx.events,
        }),
        {
          address: `dm:@${VIEWER_HANDLE}`,
          principal: { kind: 'agent', id: stranger },
          intent: 'write',
          allocation: 'permitted',
          now,
        },
      );
      expect(answer.ok).toBe(true);
      if (answer.ok) conversationId = answer.target.stream.conversationId;
    });

    expect(frames).toEqual([
      {
        scope: `viewer:${t.viewerUserId}`,
        kind: 'direct_pairs_changed',
        payload: { conversation_id: conversationId },
      },
    ]);
    expect((await listDirectPairs(t))[0]).toMatchObject({
      conversation_id: conversationId,
      unread_count: 0,
    });

    // And the mint's other half is still once-only: resolving the same address again
    // finds the row instead of creating it, so a repeat caller adds no frame.
    const repeat = await framesDuring(t, async () => {
      resolveDeliveryTarget(
        deliveryTargetPorts({
          agents,
          conversations,
          messages,
          users,
          workspaces,
          logger: t!.ctx.logger,
          events: t!.ctx.events,
        }),
        {
          address: `dm:@${VIEWER_HANDLE}`,
          principal: { kind: 'agent', id: stranger },
          intent: 'write',
          allocation: 'permitted',
          now,
        },
      );
    });
    expect(repeat).toEqual([]);
  });

  it('a schedule FIRE into a DM announces the line it landed in', async () => {
    // The fire path is the half a create-only test cannot see. Before this it was a
    // NAMED SKIP — the arm existed only to avoid the workspace publisher's throw —
    // so a DM-targeted fire was the one placement whose viewer-facing surface heard
    // nothing.
    t = buildTestApp({ scheduleNow: () => now });
    const { agentId, homeChannelId } = await makeAgentWithHome(t, 'scheduler');
    const auth = {
      authorization: `Bearer ${issueTestConversationRuntimeToken(t, homeChannelId, agentId)}`,
    };
    const created = await createSchedule(t, auth, agentId, `dm:@${VIEWER_HANDLE}`);
    expect(created.status).toBe(200);
    const { schedule } = (await created.json()) as { schedule: ScheduleDto };
    const pairId = schedule.target_conversation_id;

    // Only the fixture's CLOCK moves: the row stays exactly as the door wrote it, so
    // what fires is the schedule under test rather than one this test authored.
    now = schedule.next_fire_at + 1_000;
    t.fake.starts = [];
    t.fake.delivered = [];
    const frames = await framesDuring(t, async () => {
      await t!.ctx.scheduleService.tick();
    });

    expect(new ScheduleRepo(t.ctx.db).get(schedule.id)?.status).toBe('done');
    expect(t.fake.delivered.map(d => d.conversationId)).toEqual([pairId]);
    expect(viewerFrames(frames, t)).toEqual([
      {
        scope: `viewer:${t.viewerUserId}`,
        kind: 'direct_pairs_changed',
        payload: { conversation_id: pairId },
      },
    ]);
    expect(
      frames.filter(
        f => f.kind === 'unread_updated' || f.kind === 'attention_badge_updated',
      ),
    ).toEqual([]);
    // The honest limit, asserted so nobody reads the frame as an unread bump: the
    // wake row is `from_kind='system'`, which the shared unread predicate excludes.
    // Both arms of the split publish under exactly this condition — what the frame
    // carries is "the line the wake landed in changed", and the list stays the
    // authority for the number.
    expect((await listDirectPairs(t))[0]).toMatchObject({
      conversation_id: pairId,
      unread_count: 0,
    });
  });

  // ── A DM is not a workspace Activity coordinate ────────────────────────────────

  it('a human reference inside a DM resolves but produces no mention notification', async () => {
    // In a `direct_pair` THE STREAM IS THE MENTION: the placement has two endpoints
    // and the human is a party to every message in it, so a `mention_self` row would
    // tell them what they were already told — while the surface it feeds (Activity)
    // is coordinated by (workspace, conversation), which a DM has no first half of.
    // Inserting one anyway shipped an Activity item with `workspace_id: ''`: not a
    // navigable coordinate, and a fabricated workspace is worse than the
    // mis-delivery it replaced.
    t = buildTestApp();
    const parent = await makeAgent(t, 'parent');
    const stranger = insertAgentScopedAgent(t, parent, 'stranger');

    let frames: Frame[] = [];
    let ack: { conversation_id: string; unresolved_references?: unknown[] } | null = null;
    frames = await framesDuring(t, async () => {
      ack = await dmTheViewerAck(
        t!,
        stranger,
        `heads up <silverhand://human/${VIEWER_HANDLE}>`,
      );
    });

    // NOT a deferral and NOT an unresolved address: the reference names a real human
    // who is an endpoint of this pair, so it ADDRESSED someone —
    // `unresolved_references` is absent exactly when every reference landed
    // (`UnresolvedReferencesSchema`). If a DM mention were ever reported as
    // addressing nobody, this is the assertion that fails. What is withheld is the
    // notification, nothing else.
    expect(ack!.unresolved_references).toBeUndefined();
    expect(
      new NotificationRepo(t.ctx.db)
        .list({ userId: t.viewerUserId, limit: 50 })
        .filter(n => n.kind === 'mention_self'),
    ).toEqual([]);
    expect(frames.filter(f => f.kind === 'notification')).toEqual([]);

    const activity = await http(t).get(apiPaths.activity);
    expect(activity.status).toBe(200);
    expect(((await activity.json()) as any).items).toEqual([]);
    // The line itself is still announced and still carries the unread — the DM's own
    // read surface is where this message is owed to the viewer.
    expect(viewerFrames(frames, t).map(f => f.kind)).toEqual([
      'direct_pairs_changed',
      'direct_pairs_changed',
    ]);
    expect((await listDirectPairs(t))[0]).toMatchObject({
      conversation_id: ack!.conversation_id,
      unread_count: 1,
    });
  });
});
