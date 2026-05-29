import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('GET /api/search', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns matching messages for a non-empty keyword', async () => {
    t = buildTestApp();
    const agent = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'eng',
        member_agent_ids: [agent.agent.id],
      })
    ).json() as any;

    const message = await http(t).post(
      `/api/channels/${workspace.onboarding_channel_id}/messages`,
      { content: 'needle phrase for search' },
    );
    expect(message.status).toBe(201);

    const res = await http(t).get('/api/search?q=needle');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message',
          message: expect.objectContaining({
            content: 'needle phrase for search',
          }),
        }),
      ]),
    );
  });

  it('searches workspace names without using legacy channel aliases', async () => {
    t = buildTestApp();
    await http(t).post('/api/workspaces', {
      name: 'needle-workspace',
      description: 'engineering',
    });

    const res = await http(t).get('/api/search?q=needle-workspace');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'workspace',
          workspace: expect.objectContaining({
            name: 'needle-workspace',
          }),
        }),
      ]),
    );
  });

  it('filters messages and named entities by viewer membership', async () => {
    t = buildTestApp();
    const agent = await (
      await http(t).post('/api/agents', { name: 'search-agent', runtime: 'claude' })
    ).json() as any;
    const visible = await (
      await http(t).post('/api/workspaces', {
        name: 'visible-needle-ws',
        member_agent_ids: [agent.agent.id],
      })
    ).json() as any;
    const hidden = await (
      await http(t).post('/api/workspaces', {
        name: 'hidden-needle-ws',
        member_agent_ids: [agent.agent.id],
      })
    ).json() as any;
    await http(t).post(`/api/channels/${visible.onboarding_channel_id}/messages`, {
      content: 'needle visible message',
    });
    await http(t).post(`/api/channels/${hidden.onboarding_channel_id}/messages`, {
      content: 'needle hidden message',
    });
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'local'`)
      .run(hidden.onboarding_channel_id);
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = 'local'`)
      .run(hidden.workspace.id);

    const res = await http(t).get('/api/search?q=needle');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const serialized = JSON.stringify(body.results);
    expect(serialized).toContain('visible-needle-ws');
    expect(serialized).toContain('needle visible message');
    expect(serialized).not.toContain('hidden-needle-ws');
    expect(serialized).not.toContain('needle hidden message');
  });
});
