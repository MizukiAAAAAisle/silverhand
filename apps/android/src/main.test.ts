import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  mount: vi.fn(), configure: vi.fn(), initialize: vi.fn(), profile: vi.fn(),
  getTheme: vi.fn(), saveTheme: vi.fn(), listen: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  viewport: vi.fn(() => vi.fn()), root: { textContent: '' }, order: [] as string[],
}));
vi.mock('@silverhand/app-ui', () => ({
  mountApp: h.mount, configurePlatform: h.configure, initializeThemePersistence: h.initialize, resumeApp: vi.fn(),
}));
vi.mock('../../ios/src/bridge', () => ({ nativeBridge: {
  getProfile: h.profile, getTheme: h.getTheme, saveTheme: h.saveTheme, addListener: h.listen,
} }));
vi.mock('./platform', () => ({ createAndroidPlatform: () => ({}) }));
vi.mock('./short-viewport', () => ({ bindShortViewport: h.viewport }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); h.order.length = 0; h.root.textContent = '';
  vi.stubGlobal('document', { getElementById: () => h.root });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  h.profile.mockImplementation(async () => { h.order.push('profile'); });
  h.getTheme.mockImplementation(async () => { h.order.push('theme'); return { theme: 'glass' }; });
  h.initialize.mockImplementation(async (store) => { await store.getTheme(); });
  h.mount.mockImplementation(() => { h.order.push('mount'); });
});
afterEach(() => vi.unstubAllGlobals());

it('installs the narrow theme adapter after profile and before mount, and saves through the existing proxy', async () => {
  await import('./main');
  await vi.waitFor(() => expect(h.mount).toHaveBeenCalledTimes(1));
  expect(h.order).toEqual(['profile', 'theme', 'mount']);
  await h.initialize.mock.calls[0]![0].saveTheme('glass');
  expect(h.saveTheme).toHaveBeenCalledWith({ theme: 'glass' });
});
it('leaves the existing profile failure visible and does not run theme initialization or mount', async () => {
  h.profile.mockRejectedValue(new Error('profile denied'));
  await import('./main');
  await vi.waitFor(() => expect(h.root.textContent).toContain('profile denied'));
  expect(h.initialize).not.toHaveBeenCalled();
  expect(h.mount).not.toHaveBeenCalled();
});
it('preserves appearance and reloads the native initialization path when the session is reset', async () => {
  const storage = new Map([['silverhand:appearance', '{"theme":"iris","fontSize":17}'], ['session', 'old']]);
  const replace = vi.fn();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), clear: () => storage.clear() });
  vi.stubGlobal('sessionStorage', { clear: vi.fn() });
  vi.stubGlobal('location', { origin: 'https://localhost', replace });
  await import('./main');
  await vi.waitFor(() => expect(h.mount).toHaveBeenCalledTimes(1));
  h.listen.mock.calls.find(([event]) => event === 'sessionInvalidated')![1]();
  expect([...storage]).toEqual([['silverhand:appearance', '{"theme":"iris","fontSize":17}']]);
  expect(replace).toHaveBeenCalledWith('https://localhost/');
});
