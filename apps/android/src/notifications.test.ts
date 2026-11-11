import { afterEach, expect, it, vi } from 'vitest';
import { createAndroidNotifications, type AndroidNotificationBridge } from './notifications';
import { createNotificationTest } from './notification-test';

function fixture(acceptance = false) {
  vi.stubGlobal('__SILVERHAND_ANDROID_ACCEPTANCE__', acceptance);
  let receive: (() => void) | undefined;
  let clicks: Array<{ id: string; token: string }> = [];
  const take = () => { const value = clicks; clicks = []; return { clicks: value }; };
  const remove = vi.fn(async () => {});
  const bridge = {
    notificationDiagnostics: vi.fn<AndroidNotificationBridge['notificationDiagnostics']>(async () => ({ runtimePermission: 'unknown', appEnabled: null, channel: 'unknown', channelBlocked: null })),
    notificationSession: vi.fn(async () => ({ session: 'account-a' })),
    notificationShow: vi.fn<AndroidNotificationBridge['notificationShow']>(async () => ({ status: 'posted' })),
    notificationDismiss: vi.fn<AndroidNotificationBridge['notificationDismiss']>(async () => ({ status: 'dismissed' })),
    notificationTakeClicks: vi.fn<AndroidNotificationBridge['notificationTakeClicks']>(async () => take()),
    addListener: vi.fn(async (_event: 'systemNotificationClicked', listener: () => void) => {
      receive = listener; return { remove };
    }),
  } satisfies AndroidNotificationBridge;
  const owner = createAndroidNotifications(bridge);
  return { bridge, owner, remove, take, click(id: string, token = id) { clicks.push({ id, token }); receive?.(); } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('forwards every shared kind shape without title/kind inference and keeps badge count a safe no-op', async () => {
  const f = fixture();
  try {
    await f.owner.capability.showSystemNotification({ title: 'Self', notificationId: 'self', force: true, groupId: 'channel' });
    await f.owner.capability.showSystemNotification({ title: 'External', notificationId: 'external', force: false });
    await f.owner.capability.showSystemNotification({ title: 'Failure', body: 'Unable to start', groupId: 'channel' });
    await f.owner.capability.showSystemNotification({ title: 'Failure', body: 'Unable to start', groupId: 'channel' });
    expect(f.bridge.notificationShow.mock.calls.map(([value]) => value)).toEqual([
      { title: 'Self', notificationId: 'self', force: true, groupId: 'channel', session: 'account-a' },
      { title: 'External', notificationId: 'external', force: false, session: 'account-a' },
      { title: 'Failure', body: 'Unable to start', groupId: 'channel', session: 'account-a' },
      { title: 'Failure', body: 'Unable to start', groupId: 'channel', session: 'account-a' },
    ]);
    await f.owner.capability.dismissSystemNotifications(['self', 'external']);
    expect(f.bridge.notificationDismiss).toHaveBeenCalledWith({ session: 'account-a', ids: ['self', 'external'] });
    await expect(f.owner.capability.setBadgeCount(9)).resolves.toBeUndefined();
    expect(f.bridge.notificationShow).toHaveBeenCalledTimes(4);
  } finally { f.owner.dispose(); }
});

it('retains clicks before a consumer subscribes, isolates unsubscription and drains once', async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.bridge.addListener).toHaveBeenCalledOnce());
  f.click('before-ready');
  await vi.waitFor(() => expect(f.bridge.notificationTakeClicks.mock.calls.length).toBeGreaterThan(1));
  const first = vi.fn(); const second = vi.fn();
  const off = f.owner.capability.onNotificationClicked(first);
  expect(first).toHaveBeenCalledExactlyOnceWith('before-ready');
  f.owner.capability.onNotificationClicked(second);
  expect(second).not.toHaveBeenCalled();
  off();
  f.click('next');
  await vi.waitFor(() => expect(second).toHaveBeenCalledExactlyOnceWith('next'));
  expect(first).toHaveBeenCalledOnce();
  f.owner.dispose();
  expect(f.remove).toHaveBeenCalledOnce();
});

it('refreshes the native session after account change and cannot deliver an older drain into new subscribers', async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.bridge.notificationTakeClicks).toHaveBeenCalled());
  let finish!: () => void;
  f.bridge.notificationTakeClicks.mockImplementationOnce(() => {
    // Native takeClicks removes the batch at request execution; only its response
    // is delayed. Keep that real ownership rule in this bridge race fixture.
    const batch = f.take();
    return new Promise((resolve) => { finish = () => resolve(batch); });
  });
  const clicked = vi.fn();
  f.owner.capability.onNotificationClicked(clicked);
  f.click('old');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  f.bridge.notificationSession.mockResolvedValue({ session: 'account-b' });
  await f.owner.refreshSession();
  finish();
  await f.owner.capability.showSystemNotification({ title: 'New', notificationId: 'new' });
  expect(f.bridge.notificationShow).toHaveBeenLastCalledWith({ title: 'New', notificationId: 'new', session: 'account-b' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(clicked).not.toHaveBeenCalled();
  f.owner.dispose();
});

it.each(['not-authorized-or-undecided', 'notifications-disabled', 'channel-disabled', 'session-expired'])(
  'records expected OS block %s without rejecting fire-and-forget consumers', async (status) => {
    const f = fixture();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    f.bridge.notificationShow.mockResolvedValue({ status });
    await expect(f.owner.capability.showSystemNotification({ title: 'Notice', force: true })).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith(expect.stringContaining(status));
    f.owner.dispose();
  },
);

it('diagnoses a bridge fault and removes a listener that attaches after disposal', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = fixture();
  f.bridge.notificationShow.mockRejectedValue(new Error('native error'));
  await expect(f.owner.capability.showSystemNotification({ title: 'Notice' })).resolves.toBeUndefined();
  expect(error).toHaveBeenCalledWith(expect.stringContaining('show failed'), expect.any(Error));
  f.owner.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.remove).toHaveBeenCalledOnce();
  await f.owner.capability.showSystemNotification({ title: 'after dispose' });
  expect(f.bridge.notificationShow).toHaveBeenCalledOnce();
});

it('records an entry while the existing session is pending, then records bridge pending and completion', async () => {
  const f = fixture();
  const session = deferred<{ session: string }>();
  const post = deferred<{ status: string }>();
  f.bridge.notificationSession.mockReturnValueOnce(session.promise);
  f.bridge.notificationShow.mockReturnValueOnce(post.promise);
  const refresh = f.owner.refreshSession();
  const send = f.owner.capability.showSystemNotification({ title: 'private title', notificationId: 'private-id' });
  expect(f.owner.diagnostics.getLocalSnapshot()).toMatchObject({ session: 'unknown', lastSend: { status: 'waiting-session' } });
  expect(f.bridge.notificationShow).not.toHaveBeenCalled();
  session.resolve({ session: 'SECRET_SESSION' });
  await refresh;
  expect(f.owner.diagnostics.getLocalSnapshot()).toMatchObject({ session: 'present', lastSend: { status: 'sending' } });
  post.resolve({ status: 'posted' });
  await expect(send).resolves.toBeUndefined();
  expect(f.owner.diagnostics.getLocalSnapshot().lastSend?.status).toBe('posted');
  expect(JSON.stringify(f.owner.diagnostics.getLocalSnapshot())).not.toMatch(/SECRET|private/);
  f.owner.dispose();
});

it('does not let an older completion or a previous generation overwrite the latest observation', async () => {
  const f = fixture();
  const old = deferred<{ status: string }>();
  f.bridge.notificationShow.mockReturnValueOnce(old.promise);
  const first = f.owner.capability.showSystemNotification({ title: 'first' });
  await vi.waitFor(() => expect(f.bridge.notificationShow).toHaveBeenCalledOnce());
  await f.owner.capability.showSystemNotification({ title: 'second' });
  const newest = f.owner.diagnostics.getLocalSnapshot().lastSend;
  old.resolve({ status: 'channel-disabled' });
  await first;
  expect(f.owner.diagnostics.getLocalSnapshot().lastSend).toBe(newest);
  const stale = deferred<{ status: string }>();
  f.bridge.notificationShow.mockReturnValueOnce(stale.promise);
  const beforeReset = f.owner.capability.showSystemNotification({ title: 'old account' });
  await vi.waitFor(() => expect(f.bridge.notificationShow).toHaveBeenCalledTimes(3));
  await f.owner.refreshSession();
  expect(f.owner.diagnostics.getLocalSnapshot().lastSend).toBeNull();
  await f.owner.capability.showSystemNotification({ title: 'new account' });
  const next = f.owner.diagnostics.getLocalSnapshot().lastSend;
  stale.reject(new Error('old secret'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await beforeReset;
  expect(f.owner.diagnostics.getLocalSnapshot().lastSend).toBe(next);
  f.owner.dispose();
  expect(f.owner.diagnostics.getLocalSnapshot()).toEqual({ session: 'unknown', lastSend: null });
});

it('keeps tests separate from real observations and never logs or returns raw test errors/statuses', async () => {
  const f = fixture(true);
  const control = createNotificationTest(f.owner);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  await f.owner.capability.showSystemNotification({ title: 'Real' });
  const real = f.owner.diagnostics.getLocalSnapshot().lastSend;
  f.bridge.notificationShow.mockResolvedValueOnce({ status: 'SECRET_RETURN_VALUE' });
  expect((await control.sendDiagnosticTest()).status).toBe('UNKNOWN_STATUS');
  f.bridge.notificationShow.mockResolvedValueOnce(null as never);
  expect((await control.sendDiagnosticTest()).status).toBe('UNKNOWN_STATUS');
  f.bridge.notificationShow.mockRejectedValueOnce({ code: 'SECRET_CODE', message: 'SECRET_ERROR' });
  expect((await control.sendDiagnosticTest()).status).toBe('BRIDGE_ERROR');
  f.bridge.notificationShow.mockRejectedValueOnce({ code: 'NOTIFICATION_FAILED', message: 'SECRET_NATIVE_ERROR' });
  expect((await control.sendDiagnosticTest()).status).toBe('NOTIFICATION_FAILED');
  expect(f.owner.diagnostics.getLocalSnapshot().lastSend).toBe(real);
  expect(JSON.stringify(control.getSnapshot())).not.toContain('SECRET');
  expect(error).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
  const pending = deferred<{ status: string }>();
  f.bridge.notificationShow.mockReturnValueOnce(pending.promise);
  const sending = control.sendDiagnosticTest();
  await vi.waitFor(() => expect(control.getSnapshot()?.status).toBe('sending'));
  await f.owner.refreshSession();
  pending.resolve({ status: 'posted' });
  await sending;
  expect(control.getSnapshot()).toBeNull();
  expect(f.owner.diagnostics.getLocalSnapshot().lastSend).toBeNull();
  f.owner.dispose();
});

it('reports empty or failed sessions without fetching another session or retrying a send', async () => {
  const f = fixture(true);
  const control = createNotificationTest(f.owner);
  f.bridge.notificationSession.mockResolvedValueOnce({ session: '' });
  await f.owner.refreshSession();
  expect(f.owner.diagnostics.getLocalSnapshot().session).toBe('absent');
  await f.owner.capability.showSystemNotification({ title: 'empty' });
  expect(f.owner.diagnostics.getLocalSnapshot().lastSend?.status).toBe('missing-session');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  f.bridge.notificationSession.mockRejectedValueOnce(new Error('session error'));
  await f.owner.refreshSession();
  expect(f.owner.diagnostics.getLocalSnapshot().session).toBe('unknown');
  expect((await control.sendDiagnosticTest()).status).toBe('missing-session');
  expect(f.bridge.notificationSession).toHaveBeenCalledTimes(3);
  expect(f.bridge.notificationShow).not.toHaveBeenCalled();
  f.owner.dispose();
});

it('reads diagnostics without refreshing, sending or dismissing and clamps independent unknown fields', async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.bridge.notificationTakeClicks).toHaveBeenCalled());
  const sessions = f.bridge.notificationSession.mock.calls.length;
  f.bridge.notificationDiagnostics.mockResolvedValueOnce({ runtimePermission: 'not-granted', appEnabled: null, channel: 'present', channelBlocked: true });
  expect(await f.owner.diagnostics.readSystem()).toEqual({ runtimePermission: 'not-granted', appEnabled: null, channel: 'present', channelBlocked: true });
  f.bridge.notificationDiagnostics.mockResolvedValueOnce({ runtimePermission: 'SECRET', appEnabled: 'SECRET', channel: 'SECRET', channelBlocked: true } as never);
  expect(await f.owner.diagnostics.readSystem()).toEqual({ runtimePermission: 'unknown', appEnabled: null, channel: 'unknown', channelBlocked: null });
  expect(f.bridge.notificationSession).toHaveBeenCalledTimes(sessions);
  expect(f.bridge.notificationShow).not.toHaveBeenCalled();
  expect(f.bridge.notificationDismiss).not.toHaveBeenCalled();
  f.owner.dispose();
  await f.owner.diagnostics.readSystem();
  expect(f.bridge.notificationDiagnostics).toHaveBeenCalledTimes(2);
});

it('does not install an active test entry or test state on normal adapters', () => {
  const f = fixture();
  expect(f.owner).not.toHaveProperty('diagnosticHost');
  expect(f.owner).not.toHaveProperty('sendDiagnosticNotice');
  expect(f.owner).not.toHaveProperty('getTestSnapshot');
  expect(f.owner).not.toHaveProperty('subscribeTest');
  expect(() => createNotificationTest(f.owner)).toThrow('unavailable');
  expect(f.bridge.notificationShow).not.toHaveBeenCalled();
  f.owner.dispose();
});

it('acceptance-owned test state rejects older completions and is cleared on dispose', async () => {
  const f = fixture(true);
  const control = createNotificationTest(f.owner);
  const older = deferred<{ status: string }>();
  f.bridge.notificationShow.mockReturnValueOnce(older.promise);
  const first = control.sendDiagnosticTest();
  await vi.waitFor(() => expect(f.bridge.notificationShow).toHaveBeenCalledOnce());
  await control.sendDiagnosticTest();
  const latest = control.getSnapshot();
  older.resolve({ status: 'channel-disabled' });
  await first;
  expect(control.getSnapshot()).toBe(latest);
  const pending = deferred<{ status: string }>();
  f.bridge.notificationShow.mockReturnValueOnce(pending.promise);
  const last = control.sendDiagnosticTest();
  await vi.waitFor(() => expect(f.bridge.notificationShow).toHaveBeenCalledTimes(3));
  f.owner.dispose();
  expect(control.getSnapshot()).toBeNull();
  pending.resolve({ status: 'posted' });
  await last;
  expect(control.getSnapshot()).toBeNull();
  await control.sendDiagnosticTest();
  expect(f.bridge.notificationShow).toHaveBeenCalledTimes(3);
});
