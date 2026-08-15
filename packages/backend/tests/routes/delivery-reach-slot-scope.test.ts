/**
 * #task:2021 P4-4 — REACH at the wire: which credential may act HOW FAR, door by
 * door (@shiki's 2026-08-15 ruling, tabled in `docs/agent-scoped-session-v1.md`
 * §7.1, ruled as data in `@silverhand/shared`'s `delivery-reach.ts` and enforced by
 * `application/delivery-reach.ts`).
 *
 * The boundary is a PRODUCT ruling and not a derivable rule, so this file pins it
 * twice, from two directions that fail for different reasons:
 *
 *   1. THE TABLE. `DELIVERY_REACH` is asserted against a literal copy of the ruled
 *      matrix. This is the one assertion here that is about authority rather than
 *      about behaviour: three doors a ConversationSlot ALREADY reaches across
 *      streams on `origin/main` (history, task create, schedule create) may not be
 *      narrowed, and the four doors P4's addressing newly exposed
 *      (`message send`, `file upload`, `member add`, `channel create`'s fork
 *      source) may not be widened. Either direction is a decision nobody took, and
 *      without a literal expectation a one-word edit makes it silently.
 *   2. THE DOORS. Every operation in the table, called for real, with both slot
 *      kinds, at both a cross-stream and an own-stream destination — and the
 *      expected answer is COMPUTED from the table. So the two halves cannot drift:
 *      a cell changed without a route change fails here, and a route that stops
 *      consulting the table fails too.
 *
 * WHY TWO AGENTS. A slot kind is a property of the Agent row (`session_scope`), and
 * the triggers make the two mutually exclusive by construction — a ConversationSlot
 * is minted per roster edge for a conversation-scoped agent, an AgentSlot is born
 * with an agent-scoped one. So the matrix needs two principals, and they are made
 * as alike as possible in every OTHER respect: same workspace, same two channels,
 * both on both rosters, full capabilities. The only thing varying down a column is
 * the credential kind, which is what makes a difference in the answer attributable
 * to it.
 *
 * WHAT A CELL ASSERTS, precisely: whether the response IS the reach refusal
 * (403 `slot_out_of_scope`). Not "succeeds" — several of these doors legitimately
 * fail for unrelated reasons at a valid address (`member add` is handed a handle
 * nobody holds, so it gets that far and then refuses on the handle), and asserting
 * success would tie this matrix to those doors' other rules. Reach is a gate: the
 * fact under test is whether it closed.
 *
 * THE FALSIFIER at the bottom is the ORDERING half, which no status can show: the
 * resolver's one side-effecting arm opens a `direct_pair` on a main-line
 * `dm:@handle` write, and it runs BEFORE reach could refuse. A confined door must
 * therefore leave no conversation and no message behind — asserted in the DB, with
 * an AgentSlot positive control proving the suppression is credential-specific and
 * not a blanket disable of the allocating arm.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DELIVERY_REACH,
  internalPaths,
  type AddressedOperation,
} from '@silverhand/shared';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import {
  buildTestApp,
  http,
  issueTestConversationRuntimeToken,
  type TestApp,
} from '../utils/app.js';
import { agentSlotAuth, insertAgentScopedAgent } from '../utils/agent-scope.js';

type Auth = { authorization: string };

interface Credential {
  readonly label: 'conversation_slot' | 'agent_slot';
  readonly agentId: string;
  readonly auth: Auth;
}

/**
 * Every addressed door, keyed by the OPERATION the route declares — the join
 * between the table and the wire. Each request is valid in every respect except
 * possibly the reach of its address.
 */
const DOORS: ReadonlyArray<{
  operation: AddressedOperation;
  call: (t: TestApp, cred: Credential, target: string) => Promise<Response>;
}> = [
  {
    operation: 'message_send',
    call: (t, cred, target) =>
      http(t, cred.auth).post(
        internalPaths.agentSendConversationMessage(cred.agentId),
        { content: 'hello', target },
      ),
  },
  {
    operation: 'message_history',
    call: (t, cred, target) =>
      http(t, cred.auth).post(
        internalPaths.agentReadHistory(cred.agentId),
        { target, limit: 10 },
      ),
  },
  {
    operation: 'task_create',
    call: (t, cred, target) =>
      http(t, cred.auth).post(
        internalPaths.agentCreateConversationTasks(cred.agentId),
        { tasks: [{ title: 'a task' }], target },
      ),
  },
  {
    operation: 'schedule_create',
    call: (t, cred, target) =>
      http(t, cred.auth).post(
        internalPaths.agentScheduleCreate(cred.agentId),
        {
          title: 'wake',
          message: 'do the thing',
          spec: { kind: 'once', delay_seconds: 60 },
          target_conversation: target,
        },
      ),
  },
  {
    operation: 'channel_fork_source',
    call: (t, cred, target) =>
      http(t, cred.auth).post(
        internalPaths.agentCreateChannel(cred.agentId),
        {
          title: `forked-${Math.random().toString(36).slice(2, 8)}`,
          context_summary: 'split this out',
          initial_prompt: 'continue here',
          target,
        },
      ),
  },
  {
    operation: 'member_add',
    call: (t, cred, target) =>
      http(t, cred.auth).post(
        internalPaths.agentAddConversationMember(cred.agentId),
        { handle: 'nobody-holds-this', target },
      ),
  },
  {
    operation: 'file_upload',
    call: async (t, cred, target) => {
      // The one door whose address rides in a multipart form beside the bytes.
      const form = new FormData();
      form.append('target', target);
      form.append(
        'file',
        new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
        'shot.png',
      );
      return await t.app.fetch(
        new Request(
          `http://localhost${internalPaths.agentUploadAttachment(
            cred.agentId,
          )}`,
          { method: 'POST', headers: { ...cred.auth }, body: form },
        ),
      );
    },
  },
];

/** The reach refusal as the actor reads it — status AND code, because a 403 from
 *  some other gate (a capability, a roster) is a different fact. */
async function isReachRefusal(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body = (await res.clone().json().catch(() => ({}))) as { code?: string };
  return body.code === 'slot_out_of_scope';
}

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.agent.id as string;
}

interface Scene {
  readonly t: TestApp;
  readonly anchor: string;
  readonly away: string;
  readonly credentials: readonly Credential[];
}

/**
 * Two channels in one workspace, both principals on both rosters.
 *
 * `away` is a second channel rather than a second workspace on purpose: the
 * destination has to be one that resolution ADMITS for both principals, so that a
 * refusal can only have come from reach. A stream in a workspace one of them is not
 * in would collapse into the 404 instead, and prove nothing.
 */
async function scene(t: TestApp): Promise<Scene> {
  const seed = await makeAgent(t, 'seed');
  const connie = await makeAgent(t, 'connie');
  const aria = insertAgentScopedAgent(t, seed, 'aria');
  const ws = (await (
    await http(t).post('/api/workspaces', {
      name: 'reach',
      member_agent_ids: [connie, aria],
    })
  ).json()) as any;
  const workspaceId = ws.workspace.id as string;
  const anchor = ws.onboarding_channel_id as string;
  const away = ((await (
    await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title: 'away',
      member_agent_ids: [connie, aria],
    })
  ).json()) as any).channel.id as string;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    t,
    anchor,
    away,
    credentials: [
      {
        label: 'conversation_slot',
        agentId: connie,
        auth: {
          authorization: `Bearer ${issueTestConversationRuntimeToken(t, anchor, connie)}`,
        },
      },
      {
        label: 'agent_slot',
        agentId: aria,
        auth: agentSlotAuth(t, aria),
      },
    ],
  };
}

describe('reach — how far a credential may act, per door', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('is the ruled 3/4 matrix, written out', () => {
    // A literal copy of the ruling. The mapped type already forces every cell to
    // be DECIDED; this forces it to be decided the way it was ruled.
    expect(DELIVERY_REACH).toEqual({
      message_history: {
        conversation_slot: 'agent_participation',
        agent_slot: 'agent_participation',
      },
      task_create: {
        conversation_slot: 'agent_participation',
        agent_slot: 'agent_participation',
      },
      schedule_create: {
        conversation_slot: 'agent_participation',
        agent_slot: 'agent_participation',
      },
      message_send: {
        conversation_slot: 'own_stream',
        agent_slot: 'agent_participation',
      },
      file_upload: {
        conversation_slot: 'own_stream',
        agent_slot: 'agent_participation',
      },
      member_add: {
        conversation_slot: 'own_stream',
        agent_slot: 'agent_participation',
      },
      channel_fork_source: {
        conversation_slot: 'own_stream',
        agent_slot: 'agent_participation',
      },
    });
  });

  it('exercises every door in the table — no cell is tested by assumption', () => {
    // The table is the closed set of addressed doors, so a new one must arrive
    // here with its own request shape rather than inherit another door's verdict.
    expect(DOORS.map(d => d.operation).sort()).toEqual(
      Object.keys(DELIVERY_REACH).sort(),
    );
    expect(new Set(DOORS.map(d => d.operation)).size).toBe(DOORS.length);
  });

  it('closes exactly the cells the table calls own_stream, and only for a foreign stream', async () => {
    t = buildTestApp();
    const s = await scene(t);

    // (door x credential x destination) -> "the reach gate closed" | "it did not",
    // compared against the table's own prediction. Reported as a diff of maps so a
    // failure names the cell instead of a boolean.
    const observed = new Map<string, boolean>();
    const predicted = new Map<string, boolean>();
    for (const door of DOORS) {
      for (const cred of s.credentials) {
        for (const [relation, destination] of [
          ['own', s.anchor],
          ['foreign', s.away],
        ] as const) {
          const key = `${door.operation} / ${cred.label} / ${relation}`;
          const res = await door.call(t, cred, `#conv:${destination}`);
          observed.set(key, await isReachRefusal(res));
          // The rule, restated from the table: a confined cell refuses everything
          // but the credential's own stream, and an AgentSlot has no own stream —
          // which is why `own_stream` x `agent_slot` would refuse BOTH columns. No
          // such cell exists today, and this expectation is what would notice if
          // one appeared.
          const domain = DELIVERY_REACH[door.operation][cred.label];
          predicted.set(
            key,
            domain === 'own_stream'
              && !(cred.label === 'conversation_slot' && relation === 'own'),
          );
        }
      }
    }
    expect(Object.fromEntries(observed)).toEqual(Object.fromEntries(predicted));
    // Both columns really were exercised: a scene where every call refused (or
    // none did) would satisfy a mis-derived prediction map trivially.
    const closed = [...observed.values()].filter(Boolean).length;
    expect(closed).toBe(4);
    expect(observed.size).toBe(DOORS.length * 2 * 2);
  });

  it('says the SAME thing at every confined door: one status, one code, no reason', async () => {
    t = buildTestApp();
    const s = await scene(t);
    const conversationSlot = s.credentials[0]!;
    const answers = new Set<string>();
    for (const door of DOORS) {
      if (DELIVERY_REACH[door.operation].conversation_slot !== 'own_stream') continue;
      const res = await door.call(t, conversationSlot, `#conv:${s.away}`);
      answers.add(`${res.status} ${await res.text()}`);
    }
    // One answer across all four, and its object has exactly the two keys every
    // other P4 refusal has. A `reason`/`anchor`/`allowed` field would be an
    // instruction the actor cannot act on and a fact it did not have.
    expect([...answers]).toEqual([
      '403 {"error":"this operation acts only in the conversation your session is anchored to","code":"slot_out_of_scope"}',
    ]);
  });

  /**
   * The ordering, in the DB. A status cannot show this: the resolver allocates the
   * pair while ANSWERING, so a route that judged reach one line later would return
   * the identical 403 and still have created a conversation.
   */
  it('a confined door opens no pair and writes no row — the AgentSlot control does both', async () => {
    t = buildTestApp();
    const s = await scene(t);
    const conversationSlot = s.credentials[0]!;
    const agentSlot = s.credentials[1]!;
    const bob = await makeAgent(t, 'bob');
    const conversations = new ConversationRepo(t.ctx.db);
    const messages = new MessageRepo(t.ctx.db);
    const send = DOORS.find(d => d.operation === 'message_send')!;
    const endpoints = (agentId: string) =>
      [{ kind: 'agent', id: agentId }, { kind: 'agent', id: bob }] as const;

    // (a) The pair does NOT exist. Refused — and unborn: an allocating resolve
    // would have left a brand-new empty DM as the reward for a refused request.
    expect(conversations.findDirectPair(...endpoints(conversationSlot.agentId))).toBeNull();
    const unborn = await send.call(t, conversationSlot, 'dm:@bob');
    expect(unborn.status).toBeGreaterThanOrEqual(400);
    expect(
      conversations.findDirectPair(...endpoints(conversationSlot.agentId)),
      'a confined door allocated a conversation it then refused to use',
    ).toBeNull();

    // (b) The pair EXISTS, so resolution succeeds and reach is what refuses — the
    // one case where the 403 is reachable through the allocating arm. Nothing is
    // written into it.
    const pair = conversations.getOrCreateDirectPair(
      ...endpoints(conversationSlot.agentId),
      Date.now(),
    ).conversation.id;
    const refused = await send.call(t, conversationSlot, 'dm:@bob');
    expect(await isReachRefusal(refused)).toBe(true);
    expect(messages.listForConversation(pair)).toEqual([]);

    // (c) The control. Suppressing allocation is a property of the CELL, not of the
    // grammar arm: the same address from an AgentSlot opens the pair and lands the
    // message. Without this, disabling `dm:@handle` allocation outright would pass.
    expect(conversations.findDirectPair(...endpoints(agentSlot.agentId))).toBeNull();
    const sent = await send.call(t, agentSlot, 'dm:@bob');
    expect(sent.status, await sent.clone().text()).toBe(200);
    const opened = conversations.findDirectPair(...endpoints(agentSlot.agentId));
    expect(opened).not.toBeNull();
    expect(messages.listForConversation(opened!.id).map(m => m.content)).toEqual(['hello']);
  });
});
