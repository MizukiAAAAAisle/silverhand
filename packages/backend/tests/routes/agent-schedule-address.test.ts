import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { internalPaths, type ScheduleDto } from '@silverhand/shared';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ScheduleRepo } from '../../src/repos/schedule-repo.js';
import {
  buildTestApp,
  http,
  issueTestConversationRuntimeToken,
  type TestApp,
} from '../utils/app.js';

/**
 * #task:2021 P4-4: the wake destination is ONE absolute address.
 *
 * `schedule create`'s destination is a business VALUE rather than the door's
 * operating address — a schedule is owned by the AGENT, so `list` is a union and
 * `cancel` is addressed by the schedule's own id — but it is spelled in the same
 * grammar and resolved by the same resolver, and these differentials are the ones
 * that would still pass if it had kept its own rules: if the route silently fired
 * where the credential lives, or accepted a `/thread:` suffix and fired at the
 * parent, or judged `manage_schedules` where the token was minted instead of where
 * the wake lands, or kept the roster gate that made every rosterless placement
 * unschedulable — including the fire path, where the old gate would have shipped
 * schedules that create fine and then fail every single fire.
 */

/** The fixture's scheduler clock. A schedule is due only relative to a clock, and
 *  the minimum one-shot delay is 30s of real time, so seeing a fire means moving
 *  time rather than waiting for it — or rewriting `next_fire_at` behind the
 *  service's back, which would make the fired row a row this test authored. */
let now = 0;
beforeEach(() => {
  now = Date.now();
});

function startApp(): TestApp {
  return buildTestApp({ scheduleNow: () => now });
}

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.agent.id;
}

async function makeWorkspace(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<{ workspaceId: string; channelId: string }> {
  const created = (await (
    await http(t).post('/api/workspaces', { name, member_agent_ids: memberAgentIds })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    workspaceId: created.workspace.id as string,
    channelId: created.onboarding_channel_id as string,
  };
}

async function createChannel(
  t: TestApp,
  workspaceId: string,
  title: string,
  memberAgentIds: string[],
): Promise<string> {
  const created = (await (
    await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: memberAgentIds,
    })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.channel.id as string;
}

/** Create through the agent door, exactly as the CLI shapes it: the address is a
 *  body field. `target: null` omits it entirely — the hand-rolled-client path,
 *  since the CLI refuses a missing `--target-conversation` locally. */
function create(
  t: TestApp,
  credential: { conversationId: string; agentId: string },
  target: string | null,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return http(t, {
    authorization: `Bearer ${issueTestConversationRuntimeToken(
      t,
      credential.conversationId,
      credential.agentId,
    )}`,
  }).post(
    internalPaths.agentScheduleCreate(credential.agentId),
    {
      title: 'wake',
      message: 'do the thing',
      ...(target === null ? {} : { target_conversation: target }),
      spec: { kind: 'once', delay_seconds: 60 },
      ...extra,
    },
  );
}

/** Nothing was scheduled — asked of the agent's whole set, because a refusal
 *  that quietly stored the CREDENTIAL's conversation as the destination is
 *  precisely the failure mode these tests exist to catch. */
function scheduleCount(t: TestApp, agentId: string): number {
  return new ScheduleRepo(t.ctx.db).listForAgent(agentId, null, 200).length;
}

describe('internal schedule create — the address is the wake destination', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('fires in the conversation the ADDRESS names, not the one the credential is scoped to', async () => {
    t = startApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await makeWorkspace(t, 'addressed-wake', [alice]);
    const credentialChannel = await createChannel(t, ws.workspaceId, 'where-i-run', [alice]);
    const destination = await createChannel(t, ws.workspaceId, 'where-it-wakes', [alice]);

    const res = await create(
      t,
      { conversationId: credentialChannel, agentId: alice },
      `#conv:${destination}`,
    );
    expect(res.status).toBe(200);
    const { schedule } = (await res.json()) as { schedule: ScheduleDto };
    expect(schedule.target_conversation_id).toBe(destination);
  });

  it('schedules AND fires into a rosterless placement it can address', async () => {
    // The fire path is the half a create-only test cannot see. The old gate asked
    // `conversation_agents` at both ends, so a `direct_pair` destination would
    // either be refused at create or — worse, had only the create gate moved —
    // accepted and then fail every fire with "owner not member".
    t = startApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await makeWorkspace(t, 'pair-wake', [alice, bob]);

    const res = await create(t, { conversationId: ws.channelId, agentId: alice }, 'dm:@bob');
    expect(res.status).toBe(200);
    const { schedule } = (await res.json()) as { schedule: ScheduleDto };
    const pair = new ConversationRepo(t.ctx.db).findDirectPair(
      { kind: 'agent', id: alice },
      { kind: 'agent', id: bob },
    );
    expect(pair).not.toBeNull();
    // `dm:@handle` OPENS the pair when it has to: a destination must exist to be
    // stored as a stable id, which is why the resolver is asked with write intent.
    expect(schedule.target_conversation_id).toBe(pair!.id);

    // Drive the fire. Only the fixture's CLOCK moves: the row is left exactly as
    // the door wrote it, so what fires is the schedule under test rather than one
    // this test edited. (A real `delay_seconds` wait would be 60s of wall time,
    // and the point here is the participation gate, not cadence arithmetic.)
    now = schedule.next_fire_at + 1_000;
    t.fake.starts = [];
    t.fake.delivered = [];
    await t.ctx.scheduleService.tick();

    expect(new ScheduleRepo(t.ctx.db).get(schedule.id)?.status).toBe('done');
    // Both the wake row and the runtime start land in the pair: the
    // (destination, owner) session is the one that wakes, produces, and posts.
    expect(t.fake.delivered.map(d => d.conversationId)).toEqual([pair!.id]);
    expect(t.fake.starts.map(s => s.conversationId)).toEqual([pair!.id]);
  });

  it('answers a conversation it cannot post to exactly like one that does not exist, and schedules nothing', async () => {
    t = startApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await makeWorkspace(t, 'unknown-equals-unauthorized-wake', [alice, bob]);
    const mine = await createChannel(t, ws.workspaceId, 'mine', [alice]);
    const theirs = await createChannel(t, ws.workspaceId, 'theirs', [bob]);

    const unauthorized = await create(
      t,
      { conversationId: mine, agentId: alice },
      `#conv:${theirs}`,
    );
    const unknown = await create(
      t,
      { conversationId: mine, agentId: alice },
      '#conv:AAAAAAAAAAAAAAAA',
    );

    expect(unauthorized.status).toBe(404);
    expect(unknown.status).toBe(404);
    // Byte-identical, not merely same-coded: a differing message is the oracle
    // that tells a non-participant the stream exists.
    expect(await unauthorized.text()).toBe(await unknown.text());
    expect(scheduleCount(t, alice)).toBe(0);
  });

  it('refuses a /thread: suffix instead of quietly waking the parent', async () => {
    t = startApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await makeWorkspace(t, 'suffix-refused-wake', [alice]);
    const root = (await (
      await http(t).post(`/api/channels/${ws.channelId}/messages`, { content: 'root' })
    ).json()) as any;

    const res = await create(
      t,
      { conversationId: ws.channelId, agentId: alice },
      `#conv:${ws.channelId}/thread:${root.message.id}`,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({
      code: 'thread_suffix_not_supported',
    });
    // A reply cluster shares its parent's runtime, so "wake the thread" and
    // "wake the channel" would be the same act under different names. Refused
    // rather than reinterpreted: the caller's model of what wakes is wrong.
    expect(scheduleCount(t, alice)).toBe(0);
  });

  it('refuses an inbox as a wake destination', async () => {
    t = startApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await makeWorkspace(t, 'inbox-refused-wake', [alice]);
    const inbox = new ConversationRepo(t.ctx.db).getAgentInbox(alice);
    expect(inbox).not.toBeNull();

    const res = await create(
      t,
      { conversationId: ws.channelId, agentId: alice },
      `#conv:${inbox!.id}`,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({ code: 'inbox_not_writable' });
    expect(scheduleCount(t, alice)).toBe(0);
  });

  it('has no default destination: an absent field is invalid input', async () => {
    // There WAS a default — omit the field and fire wherever you called from —
    // and it is gone, because under an agent-scoped session one process serves
    // many conversations and "here" is not a place. The field is required by the
    // wire schema, so the refusal is the schema's rather than the resolver's.
    t = startApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await makeWorkspace(t, 'no-default-wake', [alice]);

    const res = await create(t, { conversationId: ws.channelId, agentId: alice }, null);
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({ code: 'invalid_input' });
    expect(scheduleCount(t, alice)).toBe(0);
  });

  it('judges manage_schedules in the DESTINATION workspace, not the credential one', async () => {
    t = startApp();
    const alice = await makeAgent(t, 'alice');
    const home = await makeWorkspace(t, 'home', [alice]);
    const away = await makeWorkspace(t, 'away', [alice]);
    const caps = new AgentCapabilityRepo(t.ctx.db);

    // Everything at home, nothing useful where the wake is going.
    caps.replaceSet(away.workspaceId, alice, ['read_messages']);
    const denied = await create(
      t,
      { conversationId: home.channelId, agentId: alice },
      `#conv:${away.channelId}`,
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()) as any).toMatchObject({
      code: 'capability_denied',
      capability: 'manage_schedules',
    });
    expect(scheduleCount(t, alice)).toBe(0);

    // Positive control, inverted: the grant that matters is the destination's,
    // and the credential's workspace losing it changes nothing.
    caps.replaceSet(away.workspaceId, alice, ['manage_schedules']);
    caps.replaceSet(home.workspaceId, alice, ['read_messages']);
    const ok = await create(
      t,
      { conversationId: home.channelId, agentId: alice },
      `#conv:${away.channelId}`,
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { schedule: ScheduleDto }).schedule.target_conversation_id).toBe(
      away.channelId,
    );
  });
});
