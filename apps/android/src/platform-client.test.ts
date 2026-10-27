import { describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ serverInfo: vi.fn(), passwordRecovery: vi.fn() }));
vi.mock('../../ios/src/bridge', () => ({ nativeBridge: native }));
import { createAndroidPlatform } from './platform';

describe('Android uses the actual upstream mobile client', () => {
  it('reads server discovery through native and validates its response', async () => {
    const platform = createAndroidPlatform(() => {});
    native.serverInfo.mockResolvedValueOnce({ status: 200, bodyText: '{"signup_enabled":true}' });
    expect(await platform.client.getServerInfo()).toMatchObject({ signup_enabled: true });
    expect(native.serverInfo).toHaveBeenCalledOnce();
    native.serverInfo.mockResolvedValueOnce({ status: 503, bodyText: '{}' });
    await expect(platform.client.getServerInfo()).rejects.toThrow('503');
  });

  it.each(['request', 'reset'] as const)('forwards password recovery %s without adding authentication', async (action) => {
    const platform = createAndroidPlatform(() => {});
    const input = { action, body: JSON.stringify({ email: 'fixture@example.invalid' }) };
    const response = { status: 202, bodyText: '{"ok":true}' };
    native.passwordRecovery.mockResolvedValueOnce(response);
    expect(await platform.client.passwordRecovery(input)).toEqual(response);
    expect(native.passwordRecovery).toHaveBeenLastCalledWith(input);
  });

  it('retains native recovery failure', async () => {
    const platform = createAndroidPlatform(() => {});
    native.passwordRecovery.mockRejectedValueOnce(new Error('native recovery failed'));
    await expect(platform.client.passwordRecovery({ action: 'request', body: '{}' })).rejects.toThrow('native recovery failed');
  });
});
