/**
 * #task:2072 at the wire: a mention CC now opens the AUTHOR's direct line with
 * the mentioned agent, and WHO gets one is the production authorization gate's
 * answer — not this door's.
 *
 * WHY THIS FILE EXISTS BESIDE `tests/services/mention-cc.test.ts`. The service
 * suite hands `directLineAgentIds` in as data, which is exactly the right shape for
 * it (the set is computed at the send boundary, outside the transaction) — but it
 * means nothing there proves WHO computes it, or that the thing computing it is
 * `canInitiateDirectMessageToAgent` rather than a harness that says yes. Replace the
 * closure in `index.ts` with `() => agent.id` and every service test stays green
 * while a stranger who guessed a globally-unique handle mints a line to an agent
 * they may not even see — and, because the human endpoint of a pair is itself an
 * arm of `canViewAgent`, thereby grants themselves visibility of it. So the verdict
 * is asserted HERE, through the real HTTP door with the real predicate wired
 * (`tests/utils/app.ts` composes the same closure production does).
 *
 * THE THREE POPULATIONS, one per arm of the verdict:
 *   1. an agent-scoped agent the author CREATED, in no workspace → a line is opened;
 *   2. the same agent mentioned by ANOTHER human → refused (`canViewAgent`: not the
 *      creator, no pair yet, and the agent reaches no workspace whose members it
 *      would admit);
 *   3. a CONVERSATION-scoped agent the author owns → refused on the scope half, and
 *      this one is the interesting negative: the author can see its page, so only
 *      fact 3 of the verdict stops it.
 *
 * WHAT A REFUSAL LOOKS LIKE FROM THE OUTSIDE, and why 2 and 3 assert the same
 * thing: the send still succeeds (201 — a mention that cannot be delivered is not a
 * reason to reject the message a human wrote), no pair exists, and the handle comes
 * back in `unresolved_references` with NO reason. One answer for both populations is
 * deliberate: distinguishing "this agent does not take direct lines" from "you may
 * not see this agent" would answer a question about an agent the author has no
 * access to (`no_direct_line`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiPaths,
  encodeUserPrincipalHeader,
  formatReferenceToken,
  X_SILVERHAND_PRINCIPAL_HEADER,
  type DirectPairListItem,
  type DirectPairListResponse,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { insertAgentScopedAgent } from '../utils/agent-scope.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';

/** The second registered human — a principal that is neither the target agent's
 *  creator nor an endpoint of any pair with it. */
const OTHER_USER_ID = 'teammate';

interface Frame {
  scope: string;
  kind: string;
  payload: unknown;
}

/** Every scope-addressed frame published while `run` ran. Scope-addressed only:
 *  the fact under test is which VIEWER learned that a line now exists, and
 *  `publish(conversationId, …)` cannot carry that (a client is not subscribed to a
 *  conversation it has never opened — #task:2035). */
async function viewerFramesDuring(t: TestApp, run: () => Promise<void>): Promise<Frame[]> {
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

/** A conversation-scoped agent the viewer created through the product door. */
async function makeAgent(t: TestApp, name: string): Promise<string> {
  const r = await http(t).post('/api/agents', { name, runtime: 'claude' });
  expect(r.status).toBe(201);
  return ((await r.json()) as any).agent.id as string;
}

/** A workspace with one member agent, and the channel a human posts the mention
 *  into. The mentioned agents below are deliberately NOT members of it: a CC
 *  exists only for a non-participant. */
async function makeChannel(t: TestApp): Promise<string> {
  const memberAgentId = await makeAgent(t, 'member');
  const r = await http(t).post('/api/workspaces', {
    name: 'ws-mention-cc',
    member_agent_ids: [memberAgentId],
  });
  expect(r.status).toBe(201);
  const body = (await r.json()) as any;
  return body.onboarding_channel_id as string;
}

/**
 * An AGENT-SCOPED agent owned by the viewer and in NO workspace — population 1.
 *
 * Cloned from a viewer-created parent, which is what makes `created_by_user_id`
 * the viewer (the creator arm of `canViewAgent`) while leaving the clone with no
 * workspace of its own: the workspace-members arm therefore admits NOBODY, which
 * is what makes the teammate's refusal below a real refusal rather than a fixture
 * accident.
 */
async function agentScopedTarget(t: TestApp, name: string): Promise<string> {
  const parent = await makeAgent(t, `${name}-parent`);
  return insertAgentScopedAgent(t, parent, name);
}

function mention(handle: string): string {
  return `please look at this ${formatReferenceToken({ kind: 'agent', handle })}`;
}

async function postMention(
  t: TestApp,
  channelId: string,
  handle: string,
  userId?: string,
): Promise<{ status: number; body: any }> {
  // The wake log is cleared AT THE SEND BOUNDARY: creating an agent provisions and
  // starts its own home, so the runs recorded before this line belong to the
  // fixture. What remains afterwards is what the send caused.
  t.fake.starts = [];
  t.fake.delivered = [];
  const res = await http(
    t,
    userId === undefined
      ? undefined
      : { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(userId) },
  ).post(apiPaths.channelMessages(channelId), { content: mention(handle) });
  return { status: res.status, body: await res.json() };
}

async function listDirectPairs(t: TestApp, userId?: string): Promise<DirectPairListItem[]> {
  const r = await http(
    t,
    userId === undefined
      ? undefined
      : { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(userId) },
  ).get(apiPaths.directPairs);
  expect(r.status).toBe(200);
  return ((await r.json()) as DirectPairListResponse).direct_pairs;
}

/** The wakes and deliveries the send aimed at ONE agent (`postMention` clears the
 *  log first).
 *
 *  Filtered by agent rather than compared whole: a human message in a channel also
 *  wakes the channel's own member agent, which is not this rule's business. A
 *  whole-array assertion would be about that wake, and would still be green the day
 *  the CC stopped waking anybody. */
function wakesFor(t: TestApp, agentId: string): { started: string[]; delivered: string[] } {
  return {
    started: t.fake.starts.filter(s => s.agentId === agentId).map(s => s.conversationId),
    delivered: t.fake.delivered
      .filter(d => d.agentId === agentId)
      .map(d => d.conversationId),
  };
}

function pairOf(t: TestApp, agentId: string, userId?: string) {
  return new ConversationRepo(t.ctx.db).findDirectPair(
    { kind: 'human', id: userId ?? t.viewerUserId },
    { kind: 'agent', id: agentId },
  );
}

describe('mention CC opens the author’s direct line (#task:2072, production gate)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('mints the author↔agent pair, copies into it, wakes the agent there, and announces the row to the author', async () => {
    t = buildTestApp();
    const channelId = await makeChannel(t);
    const agentId = await agentScopedTarget(t, 'scoped-target');
    expect(await listDirectPairs(t)).toEqual([]);

    let sent: { status: number; body: any } | null = null;
    const frames = await viewerFramesDuring(t, async () => {
      sent = await postMention(t!, channelId, 'scoped-target');
    });
    expect(sent!.status).toBe(201);
    // The mention resolved: nothing comes back unresolved, so the author is told
    // the reference reached someone.
    expect(sent!.body.unresolved_references).toBeUndefined();

    const pair = pairOf(t, agentId);
    expect(pair).not.toBeNull();
    expect(pair!.placement_kind).toBe('direct_pair');

    // The copy is IN the pair, and it is the only message there.
    const copies = new MessageRepo(t.ctx.db).listForConversation(pair!.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.from_kind).toBe('system');
    expect(copies[0]!.content).toContain('answer here');

    // The wake goes to the PAIR — the destination the recipient can write in — not
    // to a stream whose only participant is the agent (the retired `agent_inbox`).
    expect(wakesFor(t, agentId)).toEqual({
      started: [pair!.id],
      delivered: [pair!.id],
    });

    // The author's own DM list is the read authority for the new line, and the
    // frame that invalidates it rides the AUTHOR's viewer scope — published after
    // the send's commit, because the mint happened inside it.
    expect(
      frames.filter(f => f.kind === 'direct_pairs_changed'),
    ).toEqual([
      {
        scope: `viewer:${t.viewerUserId}`,
        kind: 'direct_pairs_changed',
        payload: { conversation_id: pair!.id },
      },
    ]);
    // And the re-read shows it. `unread_count` is 0 on purpose: the copy is a
    // `system` message, which every unread branch excludes (`UNREAD_GUARDS`) — the
    // author's jump target stays the `mention_external` notification.
    const rows = await listDirectPairs(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversation_id: pair!.id,
      counterpart: { kind: 'agent', id: agentId, name: 'scoped-target' },
      unread_count: 0,
    });
    expect(
      frames.filter(f => f.kind === 'notification').map(f => f.payload),
    ).toEqual([
      {
        kind: 'mention_external',
        conversation_id: channelId,
        message_id: sent!.body.message.id,
      },
    ]);
  });

  it('refuses the line when the author may not VIEW the agent — send still 201, no pair, reason-free unresolved', async () => {
    t = buildTestApp();
    const channelId = await makeChannel(t);
    // Created by the viewer, in no workspace: the teammate is not its creator, holds
    // no pair with it, and shares no workspace WITH IT (they do share the channel's
    // workspace, which the agent is not in — that is the distinction this asserts).
    const agentId = await agentScopedTarget(t, 'not-yours');

    let sent: { status: number; body: any } | null = null;
    const frames = await viewerFramesDuring(t, async () => {
      sent = await postMention(t!, channelId, 'not-yours', OTHER_USER_ID);
    });
    // The human's message is committed and posted — a mention nobody may receive
    // does not reject the send.
    expect(sent!.status).toBe(201);
    expect(sent!.body.message.from_user_id).toBe(OTHER_USER_ID);
    // Reported UNRESOLVED, carrying no reason: the same answer an unknown handle
    // gets, so the send is not an existence oracle for agents this principal may
    // not see.
    expect(sent!.body.unresolved_references).toEqual([
      { kind: 'agent', handle: 'not-yours' },
    ]);

    expect(pairOf(t, agentId, OTHER_USER_ID)).toBeNull();
    expect(await listDirectPairs(t, OTHER_USER_ID)).toEqual([]);
    expect(frames.filter(f => f.kind === 'direct_pairs_changed')).toEqual([]);
    // Nothing was woken FOR THIS AGENT: no copy exists to deliver.
    expect(wakesFor(t, agentId)).toEqual({ started: [], delivered: [] });
  });

  it('refuses the line for a CONVERSATION-scoped agent the author owns — the scope half, with page visibility granted', async () => {
    t = buildTestApp();
    const channelId = await makeChannel(t);
    // The viewer created it, so `canViewAgent` admits them: only
    // `session_scope === 'agent'` refuses this one. Its human entry is its own
    // workspace / Agent Space, and a workspace-less pair beside that would be a
    // second, parallel line for a lifecycle defined by its conversation.
    const agentId = await makeAgent(t, 'conv-scoped-target');

    const sent = await postMention(t, channelId, 'conv-scoped-target');
    expect(sent.status).toBe(201);
    expect(sent.body.unresolved_references).toEqual([
      { kind: 'agent', handle: 'conv-scoped-target' },
    ]);
    expect(pairOf(t, agentId)).toBeNull();
    expect(await listDirectPairs(t)).toEqual([]);
    expect(wakesFor(t, agentId)).toEqual({ started: [], delivered: [] });
  });
});
