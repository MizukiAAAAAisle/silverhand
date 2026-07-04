import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json() as any;
  return created.agent.id;
}

async function createWorkspaceChannel(
  t: TestApp,
  names: string[],
): Promise<{ workspaceId: string; channelId: string; agentIds: Record<string, string> }> {
  const agentIds: Record<string, string> = {};
  for (const name of names) {
    agentIds[name] = await makeAgent(t, name);
  }
  const workspace = await (
    await http(t).post('/api/workspaces', {
      name: `ws-${names.join('-')}`,
      member_agent_ids: Object.values(agentIds),
    })
  ).json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  t.fake.resolvedRuns = [];
  return {
    workspaceId: workspace.workspace.id,
    channelId: workspace.onboarding_channel_id,
    agentIds,
  };
}

describe('message routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('routes user requests through the session bearer subject', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const post = await http(t).post(
      `/api/channels/${channelId}/messages`,
      { content: 'from teammate' },
      {
        headers: {
          [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
        },
      },
    );
    expect(post.status).toBe(201);
    const body = await post.json() as any;
    expect(body.message.from_user_id).toBe('teammate');
  });
});

describe('GET /api/channels/:id/messages — reply_summaries_by_root (P1)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns the enriched reply-badge sidecar keyed like reply_counts_by_root', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const messages = new MessageRepo(t.ctx.db);

    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'has a thread',
    });
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentIds.alice!,
      content: 'a reply',
      threadRootId: root.id,
    });
    // A main-line message with no replies — appears in counts (0) but not in
    // the summaries sidecar.
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'no thread',
    });

    const body = (await (
      await http(t).get(`/api/channels/${channelId}/messages`)
    ).json()) as any;

    const summaries = body.reply_summaries_by_root;
    expect(summaries).toBeDefined();
    expect(summaries[root.id]).toBeDefined();
    // Mirrors the count sidecar exactly.
    expect(summaries[root.id].reply_count).toBe(body.reply_counts_by_root[root.id]);
    expect(summaries[root.id].reply_count).toBe(1);
    expect(summaries[root.id].repliers).toEqual([
      { kind: 'agent', id: agentIds.alice },
    ]);
    expect(summaries[root.id].replier_total).toBe(1);
    expect(typeof summaries[root.id].last_reply_at).toBe('number');
    // Per-viewer unread no longer rides on the reply-summary sidecar — it is
    // server-scored and served by the dedicated conversation-unread read-model
    // (`GET /api/conversations/:id/unread`), so the chip and the Threads list
    // read the same fact and the sidecar carries only optimistic reply metadata.
    expect(summaries[root.id]).not.toHaveProperty('unread_count');
    // Open-time snapshot of the opened (mainline) stream, captured in the same
    // read as the window — drives the `observe()` at_seq clear without
    // swallowing a tail.
    expect(typeof body.stream_head_seq).toBe('number');
    expect(body.stream_head_seq).toBeGreaterThan(0);
    // Every summary key is a count key (never widens the root set).
    for (const k of Object.keys(summaries)) {
      expect(body.reply_counts_by_root).toHaveProperty(k);
    }
  });
});
