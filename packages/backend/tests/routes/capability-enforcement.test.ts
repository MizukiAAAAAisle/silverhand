import { afterEach, describe, expect, it } from 'vitest';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * Graded-permissions cut 2 — request-time capability enforcement.
 *
 * The seed grants every fresh member the full set, so the gates are
 * behavior-neutral by default. To prove the gate is REAL (not a default
 * passthrough), each test first narrows the agent's set with
 * `replaceSet([])` (or a deliberately-missing bucket) and asserts the
 * typed `{ code: 'capability_denied', capability }` shape — then a
 * positive control with the bucket present succeeds. Routes gate inline;
 * task/schedule mutations gate inside their service but surface the SAME
 * typed shape (doc §3.4b, Cindy `0VvD-47mLnkjgDvw`).
 */

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.agent.id;
}

interface Team {
  workspaceId: string;
  channelId: string;
  alice: string;
  bob: string;
}

async function makeTeam(t: TestApp): Promise<Team> {
  const alice = await makeAgent(t, 'alice');
  const bob = await makeAgent(t, 'bob');
  const created = (await (
    await http(t).post('/api/workspaces', {
      name: 'team',
      member_agent_ids: [alice, bob],
    })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    workspaceId: created.workspace.id,
    channelId: created.onboarding_channel_id,
    alice,
    bob,
  };
}

function caps(t: TestApp): AgentCapabilityRepo {
  return new AgentCapabilityRepo(t.ctx.db);
}

function internal(channelId: string, agentId: string, suffix: string): string {
  return `/internal/conversations/${channelId}/agents/${agentId}/${suffix}`;
}

describe('capability enforcement — route-level gates', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('read-history: denies without read_messages, allows with it', async () => {
    t = buildTestApp();
    const team = await makeTeam(t);
    caps(t).replaceSet(team.workspaceId, team.alice, []);

    const denied = await http(t).post(
      internal(team.channelId, team.alice, 'read-history'),
      { before_seq: 9999 },
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: 'capability_denied',
      capability: 'read_messages',
    });

    caps(t).replaceSet(team.workspaceId, team.alice, ['read_messages']);
    const ok = await http(t).post(
      internal(team.channelId, team.alice, 'read-history'),
      { before_seq: 9999 },
    );
    expect(ok.status).toBe(200);
  });

  it('send-message: denies without send_messages', async () => {
    t = buildTestApp();
    const team = await makeTeam(t);
    caps(t).replaceSet(team.workspaceId, team.alice, ['read_messages']);

    const denied = await http(t).post(
      internal(team.channelId, team.alice, 'send-message'),
      { content: 'hello' },
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: 'capability_denied',
      capability: 'send_messages',
    });
  });

  it('create-thread: denies without create_threads', async () => {
    t = buildTestApp();
    const team = await makeTeam(t);
    caps(t).replaceSet(team.workspaceId, team.alice, ['read_messages']);

    const denied = await http(t).post(
      internal(team.channelId, team.alice, 'create-thread'),
      { title: 'x', members: [team.alice], context_summary: 'c', initial_prompt: 'p' },
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: 'capability_denied',
      capability: 'create_threads',
    });
  });

  it('list-channels: denies without read_messages', async () => {
    t = buildTestApp();
    const team = await makeTeam(t);
    caps(t).replaceSet(team.workspaceId, team.alice, []);

    const denied = await http(t).get(
      internal(team.channelId, team.alice, 'list-channels'),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: 'capability_denied',
      capability: 'read_messages',
    });
  });

  it('list tasks: denies without read_tasks', async () => {
    t = buildTestApp();
    const team = await makeTeam(t);
    caps(t).replaceSet(team.workspaceId, team.alice, []);

    const denied = await http(t).get(internal(team.channelId, team.alice, 'tasks'));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: 'capability_denied',
      capability: 'read_tasks',
    });
  });

  it('create tasks: denies without create_tasks', async () => {
    t = buildTestApp();
    const team = await makeTeam(t);
    caps(t).replaceSet(team.workspaceId, team.alice, ['read_tasks']);

    const denied = await http(t).post(
      internal(team.channelId, team.alice, 'tasks/create'),
      { tasks: [{ title: 'do a thing' }] },
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: 'capability_denied',
      capability: 'create_tasks',
    });
  });

  it('add conversation member: denies without manage_conversation_members', async () => {
    t = buildTestApp();
    const team = await makeTeam(t);
    caps(t).replaceSet(team.workspaceId, team.alice, ['read_messages']);

    const denied = await http(t).post(
      internal(team.channelId, team.alice, 'members'),
      { handle: 'bob' },
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: 'capability_denied',
      capability: 'manage_conversation_members',
    });
  });

  it('agent_home exemption: own-DM routes work with no cap row', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    // The agent's own DM channel + home workspace are auto-provisioned on
    // create; the home has no workspace_members row, so no caps were
    // seeded. The exemption must let the agent operate in its own home.
    const dm = t.ctx.db
      .prepare<[string], { id: string }>(
        `SELECT c.id FROM conversations c
           JOIN workspaces w ON w.id = c.workspace_id
          WHERE w.owner_agent_id = ? AND w.workspace_kind = 'agent_home'`,
      )
      .get(alice);
    expect(dm?.id).toBeTruthy();
    const ok = await http(t).post(
      internal(dm!.id, alice, 'read-history'),
      { before_seq: 9999 },
    );
    expect(ok.status).toBe(200);
  });
});

describe('capability enforcement — service-level gates (typed shape)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('task claim: denies without write_tasks, typed shape preserved', async () => {
    t = buildTestApp();
    const team = await makeTeam(t);
    // alice creates a task (needs create_tasks), then is narrowed to no
    // write_tasks before claiming.
    const created = (await (
      await http(t).post(internal(team.channelId, team.alice, 'tasks/create'), {
        tasks: [{ title: 'claimable task' }],
      })
    ).json()) as any;
    const taskNumber = created.tasks[0].task_number;

    caps(t).replaceSet(team.workspaceId, team.bob, ['read_tasks']);
    const denied = await http(t).post(
      internal(team.channelId, team.bob, 'tasks/claim'),
      { task_numbers: [taskNumber] },
    );
    expect(denied.status).toBe(200);
    const body = (await denied.json()) as any;
    // Claim returns a per-entry result array; the failing entry must carry
    // the typed capability denial (not forbidden / task_not_found).
    const entry = body.results[0];
    expect(entry.code).toBe('capability_denied');
    expect(entry.capability).toBe('write_tasks');
  });

  it('schedule create: denies without manage_schedules, typed shape preserved', async () => {
    t = buildTestApp();
    const team = await makeTeam(t);
    caps(t).replaceSet(team.workspaceId, team.alice, []);

    const denied = await http(t).post(
      internal(team.channelId, team.alice, 'schedules'),
      {
        title: 'wake',
        message: 'check in',
        spec: { kind: 'once', delay_seconds: 120 },
      },
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: 'capability_denied',
      capability: 'manage_schedules',
    });
  });
});

describe('capability enforcement — cross-axis orthogonality (doc §6.3 case 4)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('narrowing an agent capability does not alter any human role', async () => {
    t = buildTestApp();
    const team = await makeTeam(t);

    const roleBefore = t.ctx.db
      .prepare<[string], { role: string }>(
        `SELECT role FROM workspace_users WHERE workspace_id = ? AND user_id = 'local'`,
      )
      .get(team.workspaceId);

    // Mutate the AGENT axis: strip alice to nothing.
    caps(t).replaceSet(team.workspaceId, team.alice, []);

    const roleAfter = t.ctx.db
      .prepare<[string], { role: string }>(
        `SELECT role FROM workspace_users WHERE workspace_id = ? AND user_id = 'local'`,
      )
      .get(team.workspaceId);
    expect(roleAfter?.role).toBe(roleBefore?.role);

    // And bob's capability set is untouched by alice's narrowing.
    expect(caps(t).list(team.workspaceId, team.bob).length).toBeGreaterThan(0);
  });

  it('changing a human role does not alter any agent capability set', async () => {
    t = buildTestApp();
    const team = await makeTeam(t);
    const before = [...caps(t).list(team.workspaceId, team.alice)].sort();

    // Mutate the HUMAN axis: demote the local user to member.
    t.ctx.db
      .prepare(
        `UPDATE workspace_users SET role = 'member' WHERE workspace_id = ? AND user_id = 'local'`,
      )
      .run(team.workspaceId);

    const after = [...caps(t).list(team.workspaceId, team.alice)].sort();
    expect(after).toEqual(before);
  });
});
