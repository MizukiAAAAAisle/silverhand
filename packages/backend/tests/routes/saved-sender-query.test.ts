/**
 * `GET /api/saved` — the sender query parameters actually reach the domain
 * filter (#task:2059 wire hop, landed with #task:2061).
 *
 * The repo-level predicate is pinned by `tests/repos/saved-sender-filter.test.ts`
 * and the renderer emits the params under the UI no-test policy, which left the
 * ONE hop between them uncovered: a spelling drift on either side (`user_id` vs
 * `userId`, `agent_id` vs `sender_agent_id`) type-checks, passes every suite,
 * and degrades SILENTLY to "no filter" — the list simply returns MORE rows,
 * which reads as working software. So each cell below asserts a NARROWED result
 * against an unfiltered control: a dropped parameter shows up as the control's
 * row count, never as an error.
 *
 * Scope is the hop only. Which rows the predicate matches (snapshot key,
 * deleted senders, filter-before-LIMIT) belongs to the repo file and is not
 * re-litigated here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function createWorkspaceChannel(
  t: TestApp,
  agentName: string,
): Promise<{ channelId: string; agentId: string }> {
  const agent = await (
    await http(t).post('/api/agents', { name: agentName, runtime: 'claude' })
  ).json() as any;
  const workspace = await (
    await http(t).post('/api/workspaces', {
      name: `saved-sender-${agentName}`,
      member_agent_ids: [agent.agent.id],
    })
  ).json() as any;
  return {
    channelId: workspace.onboarding_channel_id,
    agentId: agent.agent.id,
  };
}

describe('GET /api/saved — sender query parameters (#task:2059 wire hop)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('narrows by user_id and by agent_id, each against the unfiltered control', async () => {
    t = buildTestApp();
    const local = http(t, { 'X-Silverhand-User-Id': 'local' });
    const alice = http(t, { 'X-Silverhand-User-Id': 'alice' });
    const { channelId, agentId } = await createWorkspaceChannel(t, 'saved-sender-bot');

    const byLocal = await (
      await local.post(`/api/channels/${channelId}/messages`, { content: 'from local' })
    ).json() as any;
    const byAlice = await (
      await alice.post(`/api/channels/${channelId}/messages`, { content: 'from alice' })
    ).json() as any;
    // The agent's message goes in through the same repository the delivery path
    // uses — the wire hop under test is the READ query string, not the send path.
    const byAgent = t.persistence.repos.messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'from the agent',
    });

    for (const id of [byLocal.message.id, byAlice.message.id, byAgent.id]) {
      expect((await local.post(`/api/messages/${id}/save`)).status).toBe(201);
    }

    const listIds = async (qs: string): Promise<string[]> => {
      const res = await local.get(`/api/saved${qs}`);
      expect(res.status).toBe(200);
      return ((await res.json()) as any).saved.map((s: any) => s.message.id);
    };

    // Control: all three, so every exclusion below is the parameter doing work.
    expect((await listIds('')).sort()).toEqual(
      [byLocal.message.id, byAlice.message.id, byAgent.id].sort(),
    );
    expect(await listIds('?user_id=alice')).toEqual([byAlice.message.id]);
    expect(await listIds('?user_id=local')).toEqual([byLocal.message.id]);
    expect(await listIds(`?agent_id=${agentId}`)).toEqual([byAgent.id]);
    // An empty value is NO filter, not a filter matching nothing — the schema's
    // preprocess reaches the wire, so an unset picker never has to be special-
    // cased by the client.
    expect((await listIds('?user_id=&agent_id=')).sort()).toEqual(
      [byLocal.message.id, byAlice.message.id, byAgent.id].sort(),
    );
  });

  it('refuses both arms at once (400) instead of silently preferring one', async () => {
    t = buildTestApp();
    const local = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId, agentId } = await createWorkspaceChannel(t, 'saved-both-arms-bot');
    const msg = await (
      await local.post(`/api/channels/${channelId}/messages`, { content: 'from local' })
    ).json() as any;
    expect((await local.post(`/api/messages/${msg.message.id}/save`)).status).toBe(201);

    // Single-select (@shiki): naming both is a client bug. A server that picked
    // one arm would answer 200 with a plausible list and hide the bug.
    const res = await local.get(`/api/saved?user_id=local&agent_id=${agentId}`);
    expect(res.status).toBe(400);
  });
});
