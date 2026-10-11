import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateState } from '@silverhand/client';
import { AppUpdateController, type AppUpdateEngine } from './app-update-controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<AppUpdateEngine> = {}) {
  const engine: AppUpdateEngine = {
    check: vi.fn(async () => ({ version: '1.2.0' })),
    download: vi.fn(async () => undefined),
    stage: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    ...overrides,
  };
  const controller = new AppUpdateController(engine, () => 42);
  const states: AppUpdateState[] = [];
  controller.subscribe((s) => states.push(s));
  return { engine, controller, states };
}

afterEach(() => vi.useRealTimers());

describe('AppUpdateController', () => {
  it('checks without downloading and coalesces concurrent checks', async () => {
    const d = deferred<{ version: string } | null>();
    const { engine, controller } = harness({ check: vi.fn(() => d.promise) });
    const a = controller.check();
    const b = controller.check();
    expect(controller.getState()).toEqual({ status: 'checking' });
    d.resolve({ version: '1.2.0' });
    await Promise.all([a, b]);
    expect(engine.check).toHaveBeenCalledTimes(1);
    expect(engine.download).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({ status: 'available', version: '1.2.0' });
  });

  it('reports up to date with the check time', async () => {
    const { controller } = harness({ check: vi.fn(async () => null) });
    await controller.check();
    expect(controller.getState()).toEqual({ status: 'idle', lastCheckedAt: 42 });
  });

  it('checks on start and then every interval', async () => {
    vi.useFakeTimers();
    const { engine, controller } = harness({ check: vi.fn(async () => null) });
    controller.start(1000);
    controller.start(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.check).toHaveBeenCalledTimes(2);
    controller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(engine.check).toHaveBeenCalledTimes(2);
  });

  it('downloads only on request, reports progress, and coalesces', async () => {
    const d = deferred<void>();
    let progress!: (t: number, total: number | null) => void;
    const { engine, controller } = harness({
      download: vi.fn((onProgress) => {
        progress = onProgress;
        return d.promise;
      }),
    });
    await controller.download();
    expect(engine.download).not.toHaveBeenCalled();
    await controller.check();
    const a = controller.download();
    const b = controller.download();
    progress(50, 100);
    expect(controller.getState()).toEqual({
      status: 'downloading',
      version: '1.2.0',
      transferred: 50,
      total: 100,
    });
    d.resolve();
    await Promise.all([a, b]);
    expect(engine.download).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toEqual({ status: 'downloaded', version: '1.2.0' });
  });

  it('keeps the version on download failure so the user can retry', async () => {
    const download = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);
    const { controller } = harness({ download });
    await controller.check();
    await controller.download();
    expect(controller.getState()).toEqual({
      status: 'error',
      message: 'network down',
      version: '1.2.0',
    });
    await controller.download();
    expect(controller.getState()).toEqual({ status: 'downloaded', version: '1.2.0' });
  });

  it('does not let a periodic check displace a download or a found update', async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce({ version: '1.2.0' })
      .mockRejectedValueOnce(new Error('offline'));
    const { engine, controller } = harness({ check });
    await controller.check();
    await controller.check();
    expect(controller.getState()).toEqual({ status: 'available', version: '1.2.0' });
    await controller.download();
    await controller.check();
    expect(engine.check).toHaveBeenCalledTimes(2);
    expect(controller.getState().status).toBe('downloaded');
  });

  it('installs only after a completed download, on an explicit choice', async () => {
    const { engine, controller } = harness();
    await controller.install('now');
    await controller.check();
    await controller.install('now');
    expect(engine.stage).not.toHaveBeenCalled();
    await controller.download();
    expect(engine.stage).not.toHaveBeenCalled();
    await controller.install('now');
    expect(engine.stage).toHaveBeenCalledTimes(1);
    expect(engine.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('schedules install on quit without quitting, and still allows restarting now', async () => {
    const { engine, controller } = harness();
    await controller.check();
    await controller.download();
    await controller.install('on-quit');
    expect(controller.getState()).toEqual({ status: 'scheduled', version: '1.2.0' });
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    await controller.check();
    expect(engine.check).toHaveBeenCalledTimes(1);
    await Promise.all([controller.install('now'), controller.install('now')]);
    await controller.install('now');
    expect(engine.stage).toHaveBeenCalledTimes(1);
    expect(engine.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("coalesces choices while staging; a later 'now' does not override 'on-quit'", async () => {
    const d = deferred<void>();
    const { engine, controller } = harness({ stage: vi.fn(() => d.promise) });
    await controller.check();
    await controller.download();
    const a = controller.install('on-quit');
    expect(controller.getState()).toEqual({ status: 'installing', version: '1.2.0' });
    const b = controller.install('now');
    const c = controller.install('now');
    d.resolve();
    await Promise.all([a, b, c]);
    expect(engine.stage).toHaveBeenCalledTimes(1);
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({ status: 'scheduled', version: '1.2.0' });
  });

  it('surfaces a staging failure as a retryable error', async () => {
    const stage = vi
      .fn()
      .mockRejectedValueOnce(new Error('code signature mismatch'))
      .mockResolvedValueOnce(undefined);
    const { engine, controller } = harness({ stage });
    await controller.check();
    await controller.download();
    await controller.install('now');
    expect(controller.getState()).toEqual({
      status: 'error',
      message: 'code signature mismatch',
      version: '1.2.0',
    });
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    await controller.download();
    await controller.install('now');
    expect(engine.download).toHaveBeenCalledTimes(2);
    expect(engine.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
