import type { ClientPlatform, NotificationClickTarget } from '@silverhand/client';
import type { PluginListenerHandle } from '@capacitor/core';

type Capability = NonNullable<ClientPlatform['notifications']>;
type Notice = Parameters<Capability['showSystemNotification']>[0];
type Result = { status: string };
type Click = { id: string; token: string; clickTarget?: NotificationClickTarget };
function validTarget(
  id: string,
  target: NotificationClickTarget | undefined,
): target is NotificationClickTarget {
  return (
    !!target &&
    typeof target.messageId === 'string' &&
    !!target.messageId.trim() &&
    id === `alert:${target.messageId}` &&
    typeof target.channelId === 'string' &&
    !!target.channelId.trim() &&
    (target.threadRootId === null ||
      (typeof target.threadRootId === 'string' && !!target.threadRootId.trim())) &&
    (target.workspaceId === null ||
      (typeof target.workspaceId === 'string' && !!target.workspaceId.trim()))
  );
}
export interface AndroidNotificationBridge {
  notificationSession(): Promise<{ session: string }>;
  notificationShow(input: Notice & { session: string }): Promise<Result>;
  notificationDismiss(input: { session: string; ids: string[] }): Promise<Result>;
  notificationTakeClicks(input: { session: string }): Promise<{
    clicks: Click[];
  }>;
  addListener(
    event: 'systemNotificationClicked',
    handler: () => void,
  ): Promise<PluginListenerHandle>;
}

// Shared callers deliberately fire-and-forget. Expected OS blocks are distinct
// outcomes; bridge faults are diagnosed here rather than becoming unhandled rejections.
export function createAndroidNotifications(bridge: AndroidNotificationBridge) {
  let disposed = false;
  let generation = 0;
  let session: Promise<string> = Promise.resolve('');
  let listener: PluginListenerHandle | undefined;
  const handlers = new Set<Parameters<Capability['onNotificationClicked']>[0]>();
  const pending = new Map<string, Click>();
  const delivered = new Set<string>();
  let draining = false;
  let drainAgain = false;
  const diagnose = (method: string, error: unknown) =>
    console.error(`Android notifications ${method} failed`, error);
  const flush = () => {
    if (disposed || handlers.size === 0) return;
    const clicks = [...pending.values()];
    pending.clear();
    for (const click of clicks) {
      if (delivered.has(click.token)) continue;
      delivered.add(click.token);
      while (delivered.size > 32) delivered.delete(delivered.values().next().value!);
      for (const handler of handlers) {
        if (validTarget(click.id, click.clickTarget)) handler(click.id, click.clickTarget);
        else handler(click.id);
      }
    }
  };
  async function drain() {
    drainAgain = true;
    if (draining || disposed) return;
    draining = true;
    try {
      while (drainAgain && !disposed) {
        drainAgain = false;
        const owner = generation;
        const token = await session;
        if (!token || disposed || owner !== generation) continue;
        const result = await bridge.notificationTakeClicks({ session: token });
        if (disposed || owner !== generation) continue;
        for (const click of result.clicks) pending.set(click.token, click);
        while (pending.size > 32) pending.delete(pending.keys().next().value!);
        flush();
      }
    } catch (error) {
      diagnose('click delivery', error);
    } finally {
      draining = false;
    }
  }
  async function refreshSession() {
    if (disposed) return;
    generation++;
    pending.clear();
    delivered.clear();
    session = bridge
      .notificationSession()
      .then((value) => value.session)
      .catch((error) => {
        diagnose('session', error);
        return '';
      });
    await session;
    await drain();
  }
  async function invoke(method: string, action: (token: string) => Promise<Result>) {
    const owner = generation;
    try {
      const token = await session;
      if (disposed || !token || owner !== generation) return;
      const result = await action(token);
      if (
        result.status !== 'posted' &&
        result.status !== 'dismissed' &&
        result.status !== 'suppressed-focused'
      )
        console.info(`Android notifications ${method}: ${result.status}`);
    } catch (error) {
      diagnose(method, error);
    }
  }
  void refreshSession();
  void bridge
    .addListener('systemNotificationClicked', () => void drain())
    .then((handle) => {
      if (disposed) void handle.remove().catch((error) => diagnose('unsubscribe', error));
      else {
        listener = handle;
        void drain();
      }
    })
    .catch((error) => diagnose('subscribe', error));

  const capability: Capability = {
    showSystemNotification: (notice) =>
      invoke('show', (token) => bridge.notificationShow({ ...notice, session: token })),
    dismissSystemNotifications: (ids) =>
      invoke('dismiss', (token) => bridge.notificationDismiss({ session: token, ids })),
    onNotificationClicked(handler) {
      if (disposed) return () => {};
      handlers.add(handler);
      flush();
      return () => {
        handlers.delete(handler);
      };
    },
    // Android's standard badges depend on real active notifications and launcher
    // support, not an app-wide arbitrary count. Do not synthesize a notification.
    setBadgeCount: async () => {},
  };
  return {
    capability,
    refreshSession,
    dispose() {
      disposed = true;
      generation++;
      pending.clear();
      delivered.clear();
      handlers.clear();
      void listener?.remove().catch((error) => diagnose('unsubscribe', error));
      listener = undefined;
    },
  };
}
