import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  apiPaths,
  authPaths,
  DESKTOP_SERVER_API_EPOCH,
  MINIMUM_SERVER_API_EPOCH,
} from '@silverhand/shared';
import admission from '../../../packages/shared/src/backend-admission.json';
import { createIOSPlatform } from './platform';
import type { NativeBridge } from './bridge';

function harness() {
  const native = {
    getProfile: vi.fn(async () => ({ server_url: 'https://server.example', updated_at: 1 })),
    authState: vi.fn(async () => ({
      serverUrl: 'https://server.example',
      info: {
        status: 200,
        statusText: 'OK',
        headers: {},
        bodyText: JSON.stringify({
          signup_enabled: true,
          desktop_api: {
            current_epoch: DESKTOP_SERVER_API_EPOCH,
            minimum_client_epoch: DESKTOP_SERVER_API_EPOCH,
          },
        }),
      },
    })),
    saveProfile: vi.fn(),
    clearProfile: vi.fn(),
    request: vi.fn(),
    authenticate: vi.fn(),
    logout: vi.fn(),
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    openExternal: vi.fn(),
    openSocket: vi.fn(),
    sendSocket: vi.fn(),
    closeSocket: vi.fn(),
  };
  const reset = vi.fn();
  return { native, reset, platform: createIOSPlatform(native as NativeBridge, reset) };
}

describe('iOS platform', () => {
  it('never advertises local host or desktop shell capabilities', async () => {
    const { platform } = harness();
    expect(platform.localHost).toBeUndefined();
    expect(platform.shell).toBeUndefined();
    expect(platform.notifications).toBeUndefined();
    expect(await platform.client.getConnectionInfo()).toEqual({
      url: 'https://server.example',
      mode: 'remote',
    });
    expect(await platform.client.getAuthState()).toEqual({
      status: 'unauthenticated',
      signup_enabled: true,
    });
  });

  it('does not reset UI if native secure profile commit fails', async () => {
    const { native, platform, reset } = harness();
    native.saveProfile.mockRejectedValue(new Error('Keychain failed'));
    expect(
      await platform.client.saveServerConnectionProfile({ serverUrl: 'https://b.example' }),
    ).toMatchObject({ ok: false });
    expect(reset).not.toHaveBeenCalled();
  });

  it('resets all browser state after a successful native switch', async () => {
    const { native, platform, reset } = harness();
    native.saveProfile.mockResolvedValue({
      server_url: 'https://b.example',
      updated_at: 2,
      info: { signup_enabled: true },
    });
    expect(
      await platform.client.saveServerConnectionProfile({ serverUrl: 'https://b.example' }),
    ).toMatchObject({ ok: true });
    expect(reset).toHaveBeenCalledOnce();
  });

  it('routes login natively and never asks native to reveal a token', async () => {
    const { native, platform } = harness();
    native.authenticate.mockResolvedValue({ ok: true, user: { id: 'u' } });
    await platform.client.login({ email: 'u@example.com', password: 'password' });
    expect(native.authenticate).toHaveBeenCalledWith({
      action: 'login',
      body: '{"email":"u@example.com","password":"password"}',
    });
  });

  it('keeps binary bytes intact across JSON transport', async () => {
    const { native, platform } = harness();
    native.request.mockResolvedValue({
      status: 200,
      headers: {},
      statusText: 'OK',
      bodyBase64: 'AP+A',
    });
    expect(
      (await platform.client.backendRequest({ path: '/api/bytes', responseType: 'arrayBuffer' }))
        .bodyBytes,
    ).toEqual(new Uint8Array([0, 255, 128]));
  });

  it('fails unsupported attachment operations explicitly', async () => {
    const { platform } = harness();
    await expect(
      platform.client.backendUpload({ path: '/api/upload', fields: [], files: [] }),
    ).rejects.toThrow('not available');
    expect(
      await platform.files.saveAttachment({ filename: 'file', bytes: new Uint8Array() }),
    ).toMatchObject({ ok: false });
  });

  it('keeps native admission and route resource tied to shared authority', () => {
    const native = JSON.parse(
      readFileSync(
        new URL('../native/Sources/SilverhandNative/Resources/Protocol.json', import.meta.url),
        'utf8',
      ),
    );
    expect(native).toEqual({
      ...admission,
      desktopApi: DESKTOP_SERVER_API_EPOCH,
      desktopMinServer: MINIMUM_SERVER_API_EPOCH,
      serverInfo: apiPaths.serverInfo,
      me: apiPaths.me,
      mePassword: apiPaths.mePassword,
      login: authPaths.login,
      signup: authPaths.signup,
      logout: authPaths.logout,
    });
  });

  it('has no remote WebView URL, wildcard navigation or relaxed TLS', () => {
    const config = readFileSync(new URL('../capacitor.config.ts', import.meta.url), 'utf8');
    const plist = readFileSync(new URL('../ios/App/App/Info.plist', import.meta.url), 'utf8');
    expect(config).not.toMatch(/server\s*:|allowNavigation|allowMixedContent/);
    expect(plist).not.toMatch(/NSAllowsArbitraryLoads|NSExceptionAllowsInsecureHTTPLoads/);
  });
});
