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
});
