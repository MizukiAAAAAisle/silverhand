import { describe, expect, it, vi } from 'vitest';
vi.mock('../../ios/src/bridge', () => ({ nativeBridge: {} }));
const upstream = {
  client: { marker: 'upstream-auth' },
  files: { saveAttachment: vi.fn(), openExternal: vi.fn(), sharePngExport: vi.fn(), previewPngExport: vi.fn() },
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
    const platform = createAndroidPlatform(() => {});
    expect(platform.client).toBe(upstream.client);
    expect(platform.files.saveAttachment).toBe(upstream.files.saveAttachment);
    for (const capability of [
      'navigation',
      'titlebar',
      'pageBar',
      'composer',
      'avatarMaker',
      'banner',
      'storeUrl',
      'localHost',
    ])
      expect(platform).not.toHaveProperty(capability);
    expect(platform.files.sharePngExport).toBe(upstream.files.sharePngExport);
    expect(platform.files).not.toHaveProperty('previewPngExport');
  });
});
