import { describe, expect, it, vi } from 'vitest';
vi.mock('../../ios/src/bridge', () => ({ nativeBridge: {} }));
const upstream = {
  client: { marker: 'upstream-auth', login: vi.fn(), signup: vi.fn() },
  files: {
    saveAttachment: vi.fn(),
    openExternal: vi.fn(),
    sharePngExport: vi.fn(),
    previewPngExport: vi.fn(),
  },
  getAppVersion: vi.fn(),
  navigation: {},
  titlebar: {},
  pageBar: {},
  composer: {},
  avatarMaker: {},
  banner: {},
  storeUrl: 'apple-store',
};
vi.mock('../../ios/src/platform', () => ({ createIOSPlatform: () => upstream }));
import { createAndroidPlatform } from './platform';
describe('Android stage 1 capability boundary', () => {
  it('reuses upstream client semantics without advertising iOS chrome or an Apple store', () => {
    const notices = {
      banner: { show: vi.fn(), subscribe: vi.fn() },
      toast: { show: vi.fn(), dismiss: vi.fn(), subscribe: vi.fn() },
    };
    const notifications = { capability: { marker: 'android-notifications' }, refreshSession: vi.fn() };
    const platform = createAndroidPlatform(() => {}, notices, notifications as never);
    expect(platform.banner).toBe(notices.banner);
    expect(platform.toast).toBe(notices.toast);
    expect(platform.client).toHaveProperty('marker', 'upstream-auth');
    expect(platform.notifications).toBe(notifications.capability);
    expect(platform.files.saveAttachment).toBe(upstream.files.saveAttachment);
    for (const capability of [
      'navigation',
      'titlebar',
      'pageBar',
      'composer',
      'avatarMaker',
      'storeUrl',
      'localHost',
    ])
      expect(platform).not.toHaveProperty(capability);
    expect(platform.files.sharePngExport).toBe(upstream.files.sharePngExport);
    expect(platform.files).not.toHaveProperty('previewPngExport');
  });
  it('refreshes notification ownership only after a successful login or signup', async () => {
    const refreshSession = vi.fn(async () => {});
    const platform = createAndroidPlatform(() => {}, {} as never, { capability: {} as never, refreshSession });
    upstream.client.login.mockResolvedValueOnce({ ok: false, status: 401 });
    await platform.client.login({ email: 'a@example.com', password: 'password' });
    expect(refreshSession).not.toHaveBeenCalled();
    upstream.client.login.mockResolvedValueOnce({ ok: true, user: { id: 'u' } });
    await platform.client.login({ email: 'a@example.com', password: 'password' });
    expect(refreshSession).toHaveBeenCalledOnce();
    upstream.client.signup.mockResolvedValueOnce({ ok: true, user: { id: 'u2' } });
    await platform.client.signup({ email: 'b@example.com', name: 'B', password: 'password' });
    expect(refreshSession).toHaveBeenCalledTimes(2);
  });
});
