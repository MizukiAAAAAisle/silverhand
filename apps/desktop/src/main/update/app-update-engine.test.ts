import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false }, autoUpdater: {} }));
vi.mock('electron-updater', () => ({ MacUpdater: class {} }));

const { createElectronUpdaterEngine } = await import('./app-update-engine');

function fakeUpdater() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '1.3.0' },
    })),
    downloadUpdate: vi.fn(async () => {
      emitter.emit('download-progress', { transferred: 5, total: 10 });
      return [];
    }),
    quitAndInstall: vi.fn(),
  });
}

function fakeNative() {
  return Object.assign(new EventEmitter(), { checkForUpdates: vi.fn() });
}

describe('createElectronUpdaterEngine', () => {
  it("disables electron-updater's automatic download and install-on-quit", async () => {
    const updater = fakeUpdater();
    const engine = createElectronUpdaterEngine(updater as never, fakeNative() as never);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(await engine.check()).toEqual({ version: '1.3.0' });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('reports no update when the feed is not newer', async () => {
    const updater = fakeUpdater();
    updater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: false,
      updateInfo: { version: '1.2.0' },
    });
    expect(
      await createElectronUpdaterEngine(updater as never, fakeNative() as never).check(),
    ).toBeNull();
  });

  it('forwards download progress only while downloading', async () => {
    const updater = fakeUpdater();
    const progress = vi.fn();
    await createElectronUpdaterEngine(updater as never, fakeNative() as never).download(progress);
    expect(progress).toHaveBeenCalledWith(5, 10);
    expect(updater.listenerCount('download-progress')).toBe(0);
  });

  it('stages through Squirrel and leaves no listeners after success or failure', async () => {
    const native = fakeNative();
    const engine = createElectronUpdaterEngine(fakeUpdater() as never, native as never);
    const failed = engine.stage();
    native.emit('error', new Error('signature mismatch'));
    await expect(failed).rejects.toThrow('signature mismatch');
    const staged = engine.stage();
    native.emit('update-downloaded');
    await expect(staged).resolves.toBeUndefined();
    expect(native.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(native.listenerCount('update-downloaded')).toBe(0);
    expect(native.listenerCount('error')).toBe(0);
  });
});
