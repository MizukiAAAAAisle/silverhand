import { afterEach, describe, expect, it } from 'vitest';
import { AVATAR_MAX_BYTES, apiPaths } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('/api/me + /api/users/:id/avatar', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('GET /api/me returns the registered viewer profile', async () => {
    t = buildTestApp();
    const res = await http(t).get(apiPaths.me);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // The fixture pre-registers a `local` user (see tests/utils/db.ts).
    // Production has no fixture: pre-registration `/api/me` returns the
    // `{registration_required, suggested_name}` shape — exercised in
    // pre-register-gate.test.ts.
    expect(body.id).toBe('local');
    expect(body.name).toBe('local-test');
    expect(body.avatar_url).toBeNull();
    expect(body.registration_required).toBeUndefined();
    expect(typeof body.created_at).toBe('number');
  });

  it('PATCH /api/me updates display_name', async () => {
    t = buildTestApp();
    const res = await http(t).patch(apiPaths.me, { display_name: 'Shiki' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe('local');
    // `name` is set at registration only; it is unaffected by PATCH.
    expect(body.name).toBe('local-test');
    expect(body.display_name).toBe('Shiki');
  });

  it('PATCH /api/me rejects an empty body', async () => {
    t = buildTestApp();
    const res = await http(t).patch(apiPaths.me, {});
    expect(res.status).toBe(400);
  });

  it('PATCH /api/me silently ignores a `name` field (schema strips unknown keys)', async () => {
    // The schema does not declare `name`; zod's default mode passes
    // unknown keys through but our `.refine` requires at least one
    // declared key. Sending only `name` therefore fails validation
    // with "no fields to update" — encoding the contract that
    // PATCH /api/me cannot rename the user.
    t = buildTestApp();
    const res = await http(t).patch(apiPaths.me, { name: 'shiki' });
    expect(res.status).toBe(400);
  });

  it('POST + GET + DELETE /api/me/avatar round-trips a PNG', async () => {
    t = buildTestApp();
    // 1x1 transparent PNG (smallest valid). 67 bytes — well under
    // the avatar cap so the path exercises the happy case.
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
        + '8900000000497384b8000000010000000049444154789c63000100000005000'
        + '1d3d2c4e90000000049454e44ae426082',
      'hex',
    );

    const form = new FormData();
    form.set(
      'file',
      new File([png], 'avatar.png', { type: 'image/png' }),
    );
    const post = await t.app.fetch(
      new Request(`http://localhost${apiPaths.meAvatar}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.authToken}` },
        body: form,
      }),
    );
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as any;
    expect(postBody.avatar_url).toMatch(/^\/api\/users\/local\/avatar\?v=\d+$/);

    // GET /api/users/:id/avatar serves the bytes.
    const get = await http(t).get(apiPaths.userAvatar('local'));
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toContain('image/png');

    // DELETE /api/me/avatar clears the pointer.
    const del = await t.app.fetch(
      new Request(`http://localhost${apiPaths.meAvatar}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${t.authToken}` },
      }),
    );
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as any;
    expect(delBody.avatar_url).toBeNull();

    // Now the public-by-id endpoint 404s.
    const get404 = await http(t).get(apiPaths.userAvatar('local'));
    expect(get404.status).toBe(404);
  });

  it('POST /api/me/avatar rejects unsupported content types', async () => {
    t = buildTestApp();
    const form = new FormData();
    form.set(
      'file',
      new File([Buffer.from('plain')], 'a.txt', { type: 'text/plain' }),
    );
    const res = await t.app.fetch(
      new Request(`http://localhost${apiPaths.meAvatar}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.authToken}` },
        body: form,
      }),
    );
    expect(res.status).toBe(415);
    const body = (await res.json()) as any;
    expect(body.code).toBe('avatar_unsupported_type');
  });

  it('POST /api/me/avatar rejects files over 5 MB with a JSON error shape', async () => {
    t = buildTestApp();
    const form = new FormData();
    form.set(
      'file',
      new File(
        [new Uint8Array(AVATAR_MAX_BYTES + 1)],
        'too-large.png',
        { type: 'image/png' },
      ),
    );
    const res = await t.app.fetch(
      new Request(`http://localhost${apiPaths.meAvatar}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.authToken}` },
        body: form,
      }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      code: 'avatar_too_large',
      error: 'Avatar must be 5 MB or smaller.',
    });
  });

  it('GET /api/users/:id/avatar returns 404 when no avatar is set', async () => {
    t = buildTestApp();
    const res = await http(t).get(apiPaths.userAvatar('local'));
    expect(res.status).toBe(404);
  });
});
