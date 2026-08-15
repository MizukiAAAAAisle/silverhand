import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function setupConversation(t: TestApp): Promise<{
  conversationId: string;
  agentId: string;
}> {
  const h = http(t);
  const agentRes = await h.post('/api/agents', { name: 'alice', runtime: 'claude' });
  const agentBody = (await agentRes.json()) as any;
  const workspaceRes = await h.post('/api/workspaces', {
    name: 'eng',
    member_agent_ids: [agentBody.agent.id],
  });
  const workspaceBody = (await workspaceRes.json()) as any;
  return {
    conversationId: workspaceBody.onboarding_channel_id,
    agentId: agentBody.agent.id,
  };
}

describe('conversation log debug API', () => {
  let t: TestApp | null = null;

  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('lets a human open and close a temporary per-conversation debug window', async () => {
    t = buildTestApp();
    const { conversationId } = await setupConversation(t);
    const h = http(t);

    const before = await h.get(apiPaths.conversationLogDebug(conversationId));
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({
      conversationId,
      enabled: false,
      expiresAt: null,
    });

    const open = await h.post(apiPaths.conversationLogDebug(conversationId), {
      enabled: true,
    });
    expect(open.status).toBe(200);
    const opened = (await open.json()) as any;
    expect(opened).toMatchObject({
      conversationId,
      enabled: true,
      daemonSynced: true,
    });
    expect(typeof opened.expiresAt).toBe('number');
    expect(t.fake.logDebugSyncs).toEqual([
      { conversationId, enabled: true, expiresAt: opened.expiresAt },
    ]);
    expect(t.ctx.logControl.getConversationDebugStatus(conversationId)).toMatchObject({
      enabled: true,
      expiresAt: opened.expiresAt,
    });

    const close = await h.post(apiPaths.conversationLogDebug(conversationId), {
      enabled: false,
    });
    expect(close.status).toBe(200);
    expect(await close.json()).toMatchObject({
      conversationId,
      enabled: false,
      expiresAt: null,
      daemonSynced: true,
    });
    expect(t.fake.logDebugSyncs.at(-1)).toEqual({
      conversationId,
      enabled: false,
      expiresAt: null,
    });
    expect(t.ctx.logControl.getConversationDebugStatus(conversationId)).toEqual({
      enabled: false,
      expiresAt: null,
    });
  });

  it('does not expose a matching agent-internal route', async () => {
    t = buildTestApp();
    const { conversationId, agentId } = await setupConversation(t);
    const res = await http(t).post(
      `/internal/agents/${agentId}/log-debug`,
      { enabled: true },
    );
    expect(res.status).toBe(404);
  });
});
