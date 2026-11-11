import type { ClientPlatform, NotificationDiagnosticsCapability, NotificationLocalSnapshot, NotificationSendObservation, NotificationSendStatus, NotificationSystemSnapshot } from '@silverhand/client';
import type { PluginListenerHandle } from '@capacitor/core';

type Capability = NonNullable<ClientPlatform['notifications']>;
type Notice = Parameters<Capability['showSystemNotification']>[0];
type Result = { status: string };
declare const __SILVERHAND_ANDROID_ACCEPTANCE__: boolean;
export interface AndroidNotificationBridge {
  notificationSession(): Promise<{ session: string }>;
  notificationShow(input: Notice & { session: string; diagnosticTest?: true }): Promise<Result>;
  notificationDiagnostics(): Promise<NotificationSystemSnapshot>;
  notificationDismiss(input: { session: string; ids: string[] }): Promise<Result>;
  notificationTakeClicks(input: { session: string }): Promise<{
    clicks: Array<{ id: string; token: string }>;
  }>;
  addListener(event: 'systemNotificationClicked', handler: () => void): Promise<PluginListenerHandle>;
}

// Shared callers deliberately fire-and-forget. Expected OS blocks are distinct
// outcomes; bridge faults are diagnosed here rather than becoming unhandled rejections.
export function createAndroidNotifications(bridge: AndroidNotificationBridge) {
  let disposed = false;
  let generation = 0;
  let session: Promise<string> = Promise.resolve('');
  let listener: PluginListenerHandle | undefined;
  let local: NotificationLocalSnapshot = { session: 'unknown', lastSend: null };
  let realSequence = 0;
  const localListeners = new Set<() => void>();
  const publish = (listeners: Set<() => void>) => {
    // A diagnostic view must never interrupt a business operation.
    for (const listener of listeners) { try { listener(); } catch {} }
  };
  const updateLocal = (next: NotificationLocalSnapshot) => { local = next; publish(localListeners); };

  const handlers = new Set<(id: string) => void>();
  const pending = new Map<string, string>();
  let draining = false;
  let drainAgain = false;
  const diagnose = (method: string, error: unknown) =>
    console.error(`Android notifications ${method} failed`, error);
  const flush = () => {
    if (disposed || handlers.size === 0) return;
    const clicks = [...pending.values()];
    pending.clear();
    for (const id of clicks) for (const handler of handlers) handler(id);
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
        for (const click of result.clicks) pending.set(click.token, click.id);
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
    const owner = ++generation;
    realSequence++;
    pending.clear();
    updateLocal({ session: 'unknown', lastSend: null });
    session = bridge.notificationSession().then((value) => {
      if (!disposed && owner === generation)
        updateLocal({ ...local, session: value.session ? 'present' : 'absent' });
      return value.session;
    }).catch((error) => {
      diagnose('session', error);
      return '';
    });
    await session;
    await drain();
  }

  const statuses = new Set<NotificationSendStatus>([
    'posted', 'suppressed-focused', 'channel-disabled', 'notifications-disabled',
    'not-authorized-or-undecided', 'session-expired', 'permission-request-busy',
    'diagnostic-unavailable', 'diagnostic-invalid',
  ]);
  // The real sender and the acceptance-only controller share this execution
  // path. Observers receive only bounded status/time; execution never stores
  // test state or chooses a test payload.
  async function execute(
    notice: Notice & { diagnosticTest?: true },
    observe: (value: NotificationSendObservation) => void,
    failed?: (error: unknown) => void,
    completed?: (status: NotificationSendStatus) => void,
  ): Promise<NotificationSendObservation> {
    const owner = generation;
    const at = Date.now();
    const record = (status: NotificationSendStatus) => {
      const observation = { status, at };
      if (!disposed && owner === generation) observe(observation);
      return observation;
    };
    if (disposed) return { status: 'invalidated', at };
    record('waiting-session');
    try {
      const token = await session;
      if (disposed || owner !== generation) return { status: 'invalidated', at };
      if (!token) return record('missing-session');
      record('sending');
      const result = await bridge.notificationShow({ ...notice, session: token });
      if (disposed || owner !== generation) return { status: 'invalidated', at };
      const status = statuses.has(result?.status as NotificationSendStatus) ? result.status as NotificationSendStatus : 'UNKNOWN_STATUS';
      completed?.(status);
      return record(status);
    } catch (error) {
      failed?.(error);
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      return record(code === 'NOTIFICATION_FAILED' ? 'NOTIFICATION_FAILED' : 'BRIDGE_ERROR');
    }
  }
  async function show(notice: Notice) {
    const sequence = ++realSequence;
    await execute(notice, (observation) => {
      if (sequence === realSequence) updateLocal({ ...local, lastSend: observation });
    }, (error) => diagnose('show', error), (status) => {
      if (status !== 'posted' && status !== 'suppressed-focused')
        console.info(`Android notifications show: ${status}`);
    });
  }
  const unknownSystem: NotificationSystemSnapshot = {
    runtimePermission: 'unknown', appEnabled: null, channel: 'unknown', channelBlocked: null,
  };
  const diagnostics: NotificationDiagnosticsCapability = {
    async readSystem() {
      if (disposed) return { ...unknownSystem };
      try {
        const value = await bridge.notificationDiagnostics();
        if (disposed || !value) return { ...unknownSystem };
        return {
          runtimePermission: ['granted', 'not-granted', 'not-required'].includes(value.runtimePermission) ? value.runtimePermission : 'unknown',
          appEnabled: typeof value.appEnabled === 'boolean' ? value.appEnabled : null,
          channel: ['present', 'absent'].includes(value.channel) ? value.channel : 'unknown',
          channelBlocked: value.channel === 'present' && typeof value.channelBlocked === 'boolean' ? value.channelBlocked : null,
        };
      } catch { return { ...unknownSystem }; }
    },
    getLocalSnapshot: () => local,
    subscribeLocal(handler) { localListeners.add(handler); return () => { localListeners.delete(handler); }; },
  };
  async function invoke(method: string, action: (token: string) => Promise<Result>) {
    const owner = generation;
    try {
      const token = await session;
      if (disposed || !token || owner !== generation) return;
      const result = await action(token);
      if (result.status !== 'posted' && result.status !== 'dismissed' && result.status !== 'suppressed-focused')
        console.info(`Android notifications ${method}: ${result.status}`);
    } catch (error) {
      diagnose(method, error);
    }
  }
  void refreshSession();
  void bridge.addListener('systemNotificationClicked', () => void drain()).then((handle) => {
    if (disposed) void handle.remove().catch((error) => diagnose('unsubscribe', error));
    else { listener = handle; void drain(); }
  }).catch((error) => diagnose('subscribe', error));

  const capability: Capability = {
    showSystemNotification: async (notice) => { await show(notice); },
    dismissSystemNotifications: (ids) => invoke('dismiss', (token) => bridge.notificationDismiss({ session: token, ids })),
    onNotificationClicked(handler) {
      if (disposed) return () => {};
      handlers.add(handler);
      flush();
      return () => { handlers.delete(handler); };
    },
    // Android's standard badges depend on real active notifications and launcher
    // support, not an app-wide arbitrary count. Do not synthesize a notification.
    setBadgeCount: async () => {},
  };
  return {
    capability,
    diagnostics,
    // Static false in normal builds: no test sender/state installation survives.
    ...(typeof __SILVERHAND_ANDROID_ACCEPTANCE__ !== 'undefined' && __SILVERHAND_ANDROID_ACCEPTANCE__ ? {
      diagnosticHost: {
        execute: (notice: Notice & { diagnosticTest?: true }, observe: (value: NotificationSendObservation) => void) => execute(notice, observe),
        generation: () => generation,
        closed: () => disposed,
      },
    } : {}),
    refreshSession,
    dispose() {
      disposed = true;
      generation++;
      pending.clear();
      handlers.clear();
      updateLocal({ session: 'unknown', lastSend: null });
      localListeners.clear();
      void listener?.remove().catch((error) => diagnose('unsubscribe', error));
      listener = undefined;
    },
  };
}
