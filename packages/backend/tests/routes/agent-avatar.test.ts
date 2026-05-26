import { afterEach, describe, expect, it } from 'vitest';
import {
  AVATAR_MAX_BYTES,
  apiPaths,
  encodeUserPrincipalHeader,
  internalPaths,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * Public agent avatar surface (PR-2). Mirrors the `/api/me/avatar`
 * test layout but adds a 403 case for non-creator viewers — the
 * core gate addition from `canEditAgent`.
 *
 * Internal agent self-edit avatar tests live alongside the other
 * internal-route tests (this file only covers the public surface).
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

function localViewerHeaders(t: TestApp): Record<string, string> {
  return {
    authorization: `Bearer ${t.authToken}`,
  };
}

function userSessionHeaders(t: TestApp, userId: string): Record<string, string> {
  return {
    authorization: `Bearer ${t.ctx.authSessions.issueSession({ userId }).userToken}`,
  };
}

describe('POST /api/agents/:id/avatar', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('round-trips POST + GET + DELETE for the creator', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const id = created.agent.id as string;

    // POST happy path.
    const form = new FormData();
    form.set('file', pngFile());
    const post = await t.app.fetch(
      new Request(`http://localhost${apiPaths.agentAvatar(id)}`, {
        method: 'POST',
        headers: localViewerHeaders(t),
        body: form,
      }),
    );
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as any;
    expect(postBody.avatar_url).toMatch(
      new RegExp(`^/api/agents/${id}/avatar\\?v=\\d+$`),
    );
    expect(postBody.agent.avatar_url).toBe(postBody.avatar_url);

    // GET serves the blob.
    const get = await http(t).get(apiPaths.agentAvatar(id));
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toContain('image/png');
    expect((await get.arrayBuffer()).byteLength).toBe(PNG_BYTES.byteLength);

    // DELETE clears the pointer; subsequent GET 404s. (Locks Cindy's
    // PR-2 review nit: confirm clear behavior is observable.)
    const del = await t.app.fetch(
      new Request(`http://localhost${apiPaths.agentAvatar(id)}`, {
        method: 'DELETE',
        headers: localViewerHeaders(t),
      }),
    );
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as any;
    expect(delBody.agent.avatar_url).toBeNull();

    const get404 = await http(t).get(apiPaths.agentAvatar(id));
    expect(get404.status).toBe(404);
  });

  it('rejects non-creator user with 403 (canEditAgent gate)', async () => {
    t = buildTestApp();
    // 'teammate' creates the agent; 'local' (the default test viewer)
    // tries to upload an avatar.
    const created = await (
      await http(t).post(
        '/api/agents',
        { name: 'alice', runtime: 'claude' },
        {
          headers: {
            [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
          },
        },
      )
    ).json() as any;
    const id = created.agent.id as string;

    const form = new FormData();
    form.set('file', pngFile());
    const denied = await t.app.fetch(
      new Request(`http://localhost${apiPaths.agentAvatar(id)}`, {
        method: 'POST',
        headers: localViewerHeaders(t),
        body: form,
      }),
    );
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as any;
    expect(body.error).toBe('forbidden');

    // The creator can still upload.
    const allowedForm = new FormData();
    allowedForm.set('file', pngFile());
    const allowed = await t.app.fetch(
      new Request(`http://localhost${apiPaths.agentAvatar(id)}`, {
        method: 'POST',
        headers: userSessionHeaders(t, 'teammate'),
        body: allowedForm,
      }),
    );
    expect(allowed.status).toBe(200);
  });

  it('rejects unsupported content types with 415', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const id = created.agent.id as string;

    const form = new FormData();
    form.set(
      'file',
      new File([Buffer.from('plain')], 'a.txt', { type: 'text/plain' }),
    );
    const res = await t.app.fetch(
      new Request(`http://localhost${apiPaths.agentAvatar(id)}`, {
        method: 'POST',
        headers: localViewerHeaders(t),
        body: form,
      }),
    );
    expect(res.status).toBe(415);
    const body = (await res.json()) as any;
    expect(body.code).toBe('avatar_unsupported_type');
  });

  it('rejects oversize files with 413', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const id = created.agent.id as string;

    const form = new FormData();
    form.set(
      'file',
      new File([new Uint8Array(AVATAR_MAX_BYTES + 1)], 'too-large.png', {
        type: 'image/png',
      }),
    );
    const res = await t.app.fetch(
      new Request(`http://localhost${apiPaths.agentAvatar(id)}`, {
        method: 'POST',
        headers: localViewerHeaders(t),
        body: form,
      }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as any;
    expect(body.code).toBe('avatar_too_large');
  });

  it('returns 404 for unknown agent id', async () => {
    t = buildTestApp();
    const form = new FormData();
    form.set('file', pngFile());
    const res = await t.app.fetch(
      new Request(`http://localhost${apiPaths.agentAvatar('missing')}`, {
        method: 'POST',
        headers: localViewerHeaders(t),
        body: form,
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/agents/:id/avatar', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns 404 when the agent has no avatar set', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const id = created.agent.id as string;

    const res = await http(t).get(apiPaths.agentAvatar(id));
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown agent id', async () => {
    t = buildTestApp();
    const res = await http(t).get(apiPaths.agentAvatar('missing'));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/agents/:id/avatar', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('is idempotent (no-op on agent with no avatar)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const id = created.agent.id as string;

    const res = await t.app.fetch(
      new Request(`http://localhost${apiPaths.agentAvatar(id)}`, {
        method: 'DELETE',
        headers: localViewerHeaders(t),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.agent.avatar_url).toBeNull();
  });

  it('rejects non-creator user with 403', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post(
        '/api/agents',
        { name: 'alice', runtime: 'claude' },
        {
          headers: {
            [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
          },
        },
      )
    ).json() as any;
    const id = created.agent.id as string;

    const res = await t.app.fetch(
      new Request(`http://localhost${apiPaths.agentAvatar(id)}`, {
        method: 'DELETE',
        headers: localViewerHeaders(t),
      }),
    );
    expect(res.status).toBe(403);
  });
});

/**
 * Internal agent self-edit avatar surface. Token middleware enforces
 * `principal.agentId === :aid`, so the URL pin alone makes this
 * self-only — `canEditAgent` is a defensive double-check.
 *
 * Public profile fields (display_name / description / runtime / etc.)
 * are intentionally NOT covered by this internal surface in PR-2;
 * those continue to flow through `PATCH /api/agents/:id` with the
 * creator-only gate from PR-1.
 */
describe('Internal agent avatar routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  /** Provision an agent + a regular workspace + channel where the agent
   *  is a member, then mint an internal token bound to (cid, aid). */
  async function bootstrapAgentInChannel(
    name = 'alice',
  ): Promise<{
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
    const token = t!.ctx.agentTokens.issue(channelId, agentId);
    return { agentId, channelId, token };
  }

  it('agent self-uploads + clears its own avatar via internal route', async () => {
    t = buildTestApp();
    const { agentId, channelId, token } = await bootstrapAgentInChannel();

    const form = new FormData();
    form.set('file', pngFile());
    const post = await t.app.fetch(
      new Request(
        `http://localhost${internalPaths.agentUploadAvatar(channelId, agentId)}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: form,
        },
      ),
    );
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as any;
    expect(postBody.agent.avatar_url).toMatch(
      new RegExp(`^/api/agents/${agentId}/avatar\\?v=\\d+$`),
    );

    // Public GET serves the bytes — single read surface for both
    // creator-uploaded and self-uploaded avatars.
    const get = await http(t).get(apiPaths.agentAvatar(agentId));
    expect(get.status).toBe(200);

    const del = await t.app.fetch(
      new Request(
        `http://localhost${internalPaths.agentDeleteAvatar(channelId, agentId)}`,
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        },
      ),
    );
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as any;
    expect(delBody.agent.avatar_url).toBeNull();

    // Locks Cindy's PR-2 review nit: GET avatar after DELETE → 404.
    const get404 = await http(t).get(apiPaths.agentAvatar(agentId));
    expect(get404.status).toBe(404);
  });

  it('rejects an unauthenticated internal call (401)', async () => {
    t = buildTestApp();
    const { agentId, channelId } = await bootstrapAgentInChannel();
    const form = new FormData();
    form.set('file', pngFile());
    const res = await t.app.fetch(
      new Request(
        `http://localhost${internalPaths.agentUploadAvatar(channelId, agentId)}`,
        { method: 'POST', body: form },
      ),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a token bound to a different agent (token middleware enforces self-only)', async () => {
    t = buildTestApp();
    const a = await bootstrapAgentInChannel('alice');
    const b = await bootstrapAgentInChannel('bob');

    // Use bob's token to attempt to write alice's avatar via alice's
    // URL — token middleware verifies the (cid, aid) tuple matches the
    // token, so this fails before any service code runs.
    const form = new FormData();
    form.set('file', pngFile());
    const res = await t.app.fetch(
      new Request(
        `http://localhost${internalPaths.agentUploadAvatar(a.channelId, a.agentId)}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${b.token}` },
          body: form,
        },
      ),
    );
    expect(res.status).toBe(401);
  });
});
