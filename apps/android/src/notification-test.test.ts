// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createAndroidNotifications, type AndroidNotificationBridge } from './notifications';
import { installNotificationTest } from './notification-test';

afterEach(() => vi.unstubAllGlobals());

it('uses the same show executor once with fixed data, disables while pending, and cleans its mount', async () => {
  vi.stubGlobal('__SILVERHAND_ANDROID_ACCEPTANCE__', true);
  const bridge: AndroidNotificationBridge = {
    notificationSession: vi.fn(async () => ({ session: 'PRIVATE_SESSION' })),
    notificationDiagnostics: vi.fn<AndroidNotificationBridge['notificationDiagnostics']>(async () => ({ runtimePermission: 'unknown', appEnabled: null, channel: 'unknown', channelBlocked: null })),
    notificationShow: vi.fn(async () => ({ status: 'posted' })),
    notificationDismiss: vi.fn(async () => ({ status: 'dismissed' })),
    notificationTakeClicks: vi.fn(async () => ({ clicks: [] })),
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })),
  };
  const owner = createAndroidNotifications(bridge);
  const control = installNotificationTest(owner);
  const subscribe = control.subscribe;
  const unsubscribed = vi.fn();
  control.subscribe = (handler) => { const off = subscribe(handler); return () => { off(); unsubscribed(); }; };
  const host = document.createElement('div'); document.body.append(host);
  const unmount = owner.diagnostics.mountTestControl!(host);
  try {
    await owner.capability.showSystemNotification({ title: 'Real private title', notificationId: 'REAL_ID' });
    const real = owner.diagnostics.getLocalSnapshot().lastSend;
    let finish!: (result: { status: string }) => void;
    vi.mocked(bridge.notificationShow).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const button = host.querySelector('button')!;
    button.click(); button.click();
    expect(button.disabled).toBe(true);
    await vi.waitFor(() => expect(bridge.notificationShow).toHaveBeenCalledTimes(2));
    expect(vi.mocked(bridge.notificationShow).mock.calls[1]![0]).toEqual({
      title: 'Silverhand 通知测试', body: '这是一条验收测试通知', force: true, session: 'PRIVATE_SESSION', diagnosticTest: true,
    });
    finish({ status: 'channel-disabled' });
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(host.textContent).toContain('channel-disabled');
    expect(host.textContent).not.toMatch(/PRIVATE_SESSION|Real private title|REAL_ID/);
    expect(owner.diagnostics.getLocalSnapshot().lastSend).toBe(real);
    vi.mocked(bridge.notificationShow).mockRejectedValueOnce({ code: 'NOTIFICATION_FAILED', message: 'PRIVATE_NATIVE_ERROR' });
    button.click();
    await vi.waitFor(() => expect(host.textContent).toContain('NOTIFICATION_FAILED'));
    expect(host.textContent).not.toContain('PRIVATE_NATIVE_ERROR');
    expect(owner.diagnostics.getLocalSnapshot().lastSend).toBe(real);
    await owner.refreshSession();
    expect(control.getSnapshot()).toBeNull();
    expect(host.textContent).not.toContain('NOTIFICATION_FAILED');
  } finally { unmount(); owner.dispose(); }
  expect(unsubscribed).toHaveBeenCalledOnce();
  expect(host.childNodes).toHaveLength(0); host.remove();
});
