import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths, internalPaths, AgentChangedEventSchema } from '@silverhand/shared';
import {
  buildTestApp,
  http,
  issueTestConversationRuntimeToken,
  type TestApp,
} from '../utils/app.js';

/**
 * Agent self-edit profile metadata (#task:1178) — the internal routes
 * behind `silverhand profile get|update`. Mirrors the self-edit avatar
 * test layout. Self-only is enforced structurally by the token middleware
 * (the (cid, aid) tuple must match the token); `update` is ONE multipart
 * request carrying text fields + the avatar action together.
 */

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
    + '8900000000497384b8000000010000000049444154789c63000100000005000'
    + '1d3d2c4e90000000049454e44ae426082',
  'hex',
);

function pngFile(name = 'avatar.png'): File {
  return new File([PNG_BYTES], name, { type: 'image/png' });
}

describe('agent self-profile (internal routes)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function bootstrapAgentInChannel(name = 'alice'): Promise<{
    agentId: string;
    channelId: string;
    token: string;
  }> {
    const created = await (
      await http(t!).post('/api/agents', { name, runtime: 'claude' })
    ).json() as any;
    const agentId = created.agent.id as string;
    const ws = await (
      await http(t!).post('/api/workspaces', {
        name: `ws-${crypto.randomUUID().slice(0, 8)}`,
        member_agent_ids: [agentId],
      })
    ).json() as any;
    const channelId = ws.onboarding_channel_id as string;
    const token = issueTestConversationRuntimeToken(t!, channelId, agentId);
    return { agentId, channelId, token };
  }

  function getProfile(channelId: string, agentId: string, token: string) {
    return t!.app.fetch(
      new Request(`http://localhost${internalPaths.agentProfileGet(agentId)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  }

  function updateProfile(
    channelId: string,
    agentId: string,
    token: string,
    form: FormData,
  ) {
    return t!.app.fetch(
      new Request(`http://localhost${internalPaths.agentProfileUpdate(agentId)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
      }),
    );
  }

  /** Capture `agent_changed` ids published on the `app` scope from the
   *  moment of the call (subscribe AFTER bootstrap so only the action
   *  under test is observed). */
  function captureAgentChanged(): string[] {
    const ids: string[] = [];
    t!.ctx.events.subscribeScope('app', e => {
      if (e.kind !== 'agent_changed') return;
      const parsed = AgentChangedEventSchema.safeParse(e.payload);
      if (parsed.success) ids.push(parsed.data.agent_id);
    });
    return ids;
  }

  it('publishes agent_changed on a text update (so all clients refetch)', async () => {
    t = buildTestApp();
    const { agentId, channelId, token } = await bootstrapAgentInChannel();
    const changed = captureAgentChanged();
    const form = new FormData();
    form.set('display_name', 'Renamed');
    expect((await updateProfile(channelId, agentId, token, form)).status).toBe(200);
    expect(changed).toContain(agentId);
  });

  it('publishes agent_changed on avatar set and on clear', async () => {
    t = buildTestApp();
    const { agentId, channelId, token } = await bootstrapAgentInChannel();
    const changed = captureAgentChanged();

    const setForm = new FormData();
    setForm.set('avatar_action', 'set');
    setForm.set('file', pngFile());
    expect((await updateProfile(channelId, agentId, token, setForm)).status).toBe(200);

    const clearForm = new FormData();
    clearForm.set('avatar_action', 'clear');
    expect((await updateProfile(channelId, agentId, token, clearForm)).status).toBe(200);

    // One for set, one for clear — both flow through the shared seam.
    expect(changed.filter(x => x === agentId).length).toBeGreaterThanOrEqual(2);
  });

  it('GET returns the self profile shape', async () => {
    t = buildTestApp();
    const { agentId, channelId, token } = await bootstrapAgentInChannel();
    const res = await getProfile(channelId, agentId, token);
    expect(res.status).toBe(200);
    const { profile } = (await res.json()) as any;
    expect(profile.id).toBe(agentId);
    expect(profile.name).toBe('alice');
    expect(typeof profile.display_name).toBe('string');
    expect(profile.avatar_url).toBeNull();
  });

  it('updates text fields (display_name + description)', async () => {
    t = buildTestApp();
    const { agentId, channelId, token } = await bootstrapAgentInChannel();
    const form = new FormData();
    form.set('display_name', 'Alice the Architect');
    form.set('description', 'systems + design');
    const res = await updateProfile(channelId, agentId, token, form);
    expect(res.status).toBe(200);
    const { profile } = (await res.json()) as any;
    expect(profile.display_name).toBe('Alice the Architect');
    expect(profile.description).toBe('systems + design');
  });

  it('sets and clears the avatar (blob round-trip)', async () => {
    t = buildTestApp();
    const { agentId, channelId, token } = await bootstrapAgentInChannel();

    const setForm = new FormData();
    setForm.set('avatar_action', 'set');
    setForm.set('file', pngFile());
    const setRes = await updateProfile(channelId, agentId, token, setForm);
    expect(setRes.status).toBe(200);
    const setBody = (await setRes.json()) as any;
    expect(setBody.profile.avatar_url).toMatch(
      new RegExp(`^/api/agents/${agentId}/avatar\\?v=\\d+$`),
    );
    // Public GET serves the bytes.
    expect((await http(t).get(apiPaths.agentAvatar(agentId))).status).toBe(200);

    const clearForm = new FormData();
    clearForm.set('avatar_action', 'clear');
    const clearRes = await updateProfile(channelId, agentId, token, clearForm);
    expect(clearRes.status).toBe(200);
    expect(((await clearRes.json()) as any).profile.avatar_url).toBeNull();
    expect((await http(t).get(apiPaths.agentAvatar(agentId))).status).toBe(404);
  });

  it('applies text + avatar in one request', async () => {
    t = buildTestApp();
    const { agentId, channelId, token } = await bootstrapAgentInChannel();
    const form = new FormData();
    form.set('display_name', 'Combined');
    form.set('avatar_action', 'set');
    form.set('file', pngFile());
    const res = await updateProfile(channelId, agentId, token, form);
    expect(res.status).toBe(200);
    const { profile } = (await res.json()) as any;
    expect(profile.display_name).toBe('Combined');
    expect(profile.avatar_url).not.toBeNull();
  });

  it('rejects an empty update (400) and an invalid display_name without a partial write', async () => {
    t = buildTestApp();
    const { agentId, channelId, token } = await bootstrapAgentInChannel();

    // Empty update.
    expect((await updateProfile(channelId, agentId, token, new FormData())).status).toBe(400);

    // Seed a known description, then send an invalid display_name alongside
    // a new description — the whole request must fail and leave description
    // unchanged (no partial write).
    const seed = new FormData();
    seed.set('description', 'original');
    await updateProfile(channelId, agentId, token, seed);

    const bad = new FormData();
    bad.set('display_name', '   '); // trims to empty → fails DisplayNameSchema
    bad.set('description', 'should not persist');
    expect((await updateProfile(channelId, agentId, token, bad)).status).toBe(400);

    const after = (await (await getProfile(channelId, agentId, token)).json()) as any;
    expect(after.profile.description).toBe('original');
  });

  it('an invalid avatar aborts the update — the text fields are not written', async () => {
    t = buildTestApp();
    const { agentId, channelId, token } = await bootstrapAgentInChannel();

    // Seed a known display_name so we can prove a failed update left it intact.
    const seed = new FormData();
    seed.set('display_name', 'Original Name');
    expect((await updateProfile(channelId, agentId, token, seed)).status).toBe(200);

    // Valid text (passes the schema) + an invalid avatar (non-image type).
    // The avatar service is the authoritative validator and rejects it; since
    // the avatar is applied before the text write, the new display_name must
    // NOT persist — this locks the pre-validation / ordering guarantee.
    const bad = new FormData();
    bad.set('display_name', 'Should Not Persist');
    bad.set('avatar_action', 'set');
    bad.set('file', new File([Buffer.from('not an image')], 'x.txt', { type: 'text/plain' }));
    const res = await updateProfile(channelId, agentId, token, bad);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const after = (await (await getProfile(channelId, agentId, token)).json()) as any;
    expect(after.profile.display_name).toBe('Original Name');
    expect(after.profile.avatar_url).toBeNull();
  });

  it('rejects a token bound to a different agent (self-only)', async () => {
    t = buildTestApp();
    const a = await bootstrapAgentInChannel('alice');
    const b = await bootstrapAgentInChannel('bob');
    const form = new FormData();
    form.set('display_name', 'hijack');
    const res = await updateProfile(a.channelId, a.agentId, b.token, form);
    expect(res.status).toBe(401);
  });
});
