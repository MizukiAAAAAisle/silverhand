import { afterEach, expect, it, vi } from 'vitest';
import { createAndroidNotifications, type AndroidNotificationBridge } from './notifications';

function fixture() {
  let receive: (() => void) | undefined;
  let clicks: Array<{ id: string; token: string }> = [];
  const take = () => { const value = clicks; clicks = []; return { clicks: value }; };
  const remove = vi.fn(async () => {});
  const bridge = {
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
afterEach(() => vi.restoreAllMocks());

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

it('does not send while session is empty or stale and never retries', async () => {
  const f = fixture();
  f.bridge.notificationSession.mockResolvedValueOnce({ session: '' });
  await f.owner.refreshSession();
  await f.owner.capability.showSystemNotification({ title: 'empty' });
  expect(f.bridge.notificationShow).not.toHaveBeenCalled();
  let finish!: (value: { session: string }) => void;
  f.bridge.notificationSession.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const oldRefresh = f.owner.refreshSession();
  const oldSend = f.owner.capability.showSystemNotification({ title: 'stale' });
  f.bridge.notificationSession.mockResolvedValueOnce({ session: 'new' });
  await f.owner.refreshSession(); finish({ session: 'old' });
  await Promise.all([oldRefresh, oldSend]);
  expect(f.bridge.notificationShow).not.toHaveBeenCalled();
  await f.owner.capability.showSystemNotification({ title: 'current', notificationId: 'current' });
  expect(f.bridge.notificationShow).toHaveBeenCalledExactlyOnceWith({ title: 'current', notificationId: 'current', session: 'new' });
  f.owner.dispose();
});
