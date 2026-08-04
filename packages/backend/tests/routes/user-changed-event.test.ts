// `user_changed` is the human counterpart of `agent_changed`: one
// app-scope broadcast per profile write, carrying only the user id, so a
// second machine can invalidate its identity read models (#task:1702).
//
// What these tests pin is the SIGNAL, not the payload: no profile field
// may ride the frame, and the publish must follow the row actually
// changing — a no-op write or a rejected write stays silent. The
// positive cases and the silent cases share one capture helper, so a
// silent-case assertion cannot pass vacuously (the helper is proven to
// observe in the same file).
import { afterEach, describe, expect, it } from 'vitest';
import {
  apiPaths,
  UserChangedEventSchema,
  X_SILVERHAND_LEGACY_USER_ID_HEADER,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { CURRENT_DESKTOP_EPOCH_HEADERS } from '../utils/desktop-client-epoch.js';

// 1x1 transparent PNG — same bytes as me.test.ts's round-trip case.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
    + '8900000000497384b8000000010000000049444154789c63000100000005000'
    + '1d3d2c4e90000000049454e44ae426082',
  'hex',
);

describe('user_changed app-scope broadcast', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  function viewerHeaders(app: TestApp): Record<string, string> {
    return {
      ...CURRENT_DESKTOP_EPOCH_HEADERS,
      authorization: `Bearer ${app.authToken}`,
      [X_SILVERHAND_LEGACY_USER_ID_HEADER]: 'local',
    };
  }

  /** Capture the `user_changed` ids published on the `app` scope from the
   *  moment of the call, so only the action under test is observed. */
  function captureUserChanged(app: TestApp): string[] {
    const ids: string[] = [];
    app.ctx.events.subscribeScope('app', e => {
      if (e.kind !== 'user_changed') return;
      const parsed = UserChangedEventSchema.safeParse(e.payload);
      if (parsed.success) ids.push(parsed.data.user_id);
    });
    return ids;
  }

  function uploadAvatar(app: TestApp, bytes: Buffer, contentType: string) {
    const form = new FormData();
    form.set('file', new File([bytes], 'avatar.png', { type: contentType }));
    return app.app.fetch(
      new Request(`http://localhost${apiPaths.meAvatar}`, {
        method: 'POST',
        headers: viewerHeaders(app),
        body: form,
      }),
    );
  }

  function clearAvatar(app: TestApp) {
    return app.app.fetch(
      new Request(`http://localhost${apiPaths.meAvatar}`, {
        method: 'DELETE',
        headers: viewerHeaders(app),
      }),
    );
  }

  it('publishes once on PATCH /api/me, with the id and nothing else', async () => {
    t = buildTestApp();
    const frames: unknown[] = [];
    t.ctx.events.subscribeScope('app', e => {
      if (e.kind === 'user_changed') frames.push(e.payload);
    });

    const res = await http(t).patch(apiPaths.me, { display_name: 'Renamed' });
    expect(res.status).toBe(200);

    // Exactly one frame, and its payload is the id alone: a client cannot
    // read a profile out of the event even if it wanted to.
    expect(frames).toEqual([{ user_id: 'local' }]);
  });

  it('publishes on avatar upload and on avatar clear', async () => {
    t = buildTestApp();
    const changed = captureUserChanged(t);

    expect((await uploadAvatar(t, PNG, 'image/png')).status).toBe(200);
    expect(changed).toEqual(['local']);

    expect((await clearAvatar(t)).status).toBe(200);
    expect(changed).toEqual(['local', 'local']);
  });

  it('stays silent when the write changes nothing', async () => {
    t = buildTestApp();
    // Seed a known display_name through the real write path, then start
    // observing and re-send the same value.
    expect(
      (await http(t).patch(apiPaths.me, { display_name: 'Stable' })).status,
    ).toBe(200);
    const changed = captureUserChanged(t);

    const repeat = await http(t).patch(apiPaths.me, { display_name: 'Stable' });
    expect(repeat.status).toBe(200);
    // The fixture viewer starts with no avatar, so this clear is the
    // service's idempotent no-op arm.
    expect((await clearAvatar(t)).status).toBe(200);

    expect(changed).toEqual([]);
  });

  it('stays silent when the write is rejected', async () => {
    t = buildTestApp();
    const changed = captureUserChanged(t);

    // 400 — schema rejects an empty patch before the service runs.
    expect((await http(t).patch(apiPaths.me, {})).status).toBe(400);
    // 400 — control character in display_name.
    expect(
      (await http(t).patch(apiPaths.me, { display_name: 'bad\nname' })).status,
    ).toBe(400);
    // 415 — unsupported avatar content type, rejected before any write.
    expect(
      (await uploadAvatar(t, Buffer.from('plain'), 'text/plain')).status,
    ).toBe(415);

    expect(changed).toEqual([]);
  });
});
