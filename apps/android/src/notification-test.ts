import type { NotificationSendObservation } from '@silverhand/client';
import type { createAndroidNotifications } from './notifications';
import { locale } from '@/lib/i18n';
import { notificationObservationText } from '@/pages/settings/components/notification-diagnostics-pane';

/** Payload, active sender, result state and subscriptions exist only here. */
export function createNotificationTest(owner: ReturnType<typeof createAndroidNotifications>) {
  const host = owner.diagnosticHost;
  if (!host) throw new Error('Acceptance notification executor unavailable');
  let generation = host.generation();
  let sequence = 0;
  let disposed = host.closed();
  let result: NotificationSendObservation | null = null;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) { try { listener(); } catch {} } };
  const unsubscribe = owner.diagnostics.subscribeLocal(() => {
    if (generation === host.generation() && !host.closed()) return;
    generation = host.generation();
    sequence++;
    result = null;
    publish();
    if (host.closed()) { disposed = true; unsubscribe(); listeners.clear(); }
  });
  return {
    getSnapshot: () => result,
    subscribe(handler: () => void) { listeners.add(handler); return () => { listeners.delete(handler); }; },
    // No caller-supplied data or ID. The same executor forwards this fixed input
    // to notificationShow; native acceptance policy validates it independently.
    async sendDiagnosticTest() {
      const current = ++sequence;
      if (disposed) return { status: 'invalidated' as const, at: Date.now() };
      return host.execute({ title: 'Silverhand 通知测试', body: '这是一条验收测试通知', force: true, diagnosticTest: true }, (observation) => {
        if (!disposed && current === sequence) { result = observation; publish(); }
      });
    },
  };
}

/** This entire module is imported only by the acceptance build-time branch. */
export function installNotificationTest(owner: ReturnType<typeof createAndroidNotifications>) {
  const control = createNotificationTest(owner);
  owner.diagnostics.mountTestControl = (host) => {
    const row = document.createElement('div');
    row.className = 'flex flex-wrap items-center gap-3 text-sm';
    row.dataset.acceptanceNotificationTest = '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rounded-(--control-radius) border border-border-subtle px-3 py-2 text-text-primary';
    button.textContent = locale === 'zh' ? '发送一条测试通知' : 'Send one test notification';
    const status = document.createElement('span');
    status.className = 'text-text-secondary';
    status.setAttribute('role', 'status');
    const render = () => {
      const observation = control.getSnapshot();
      button.disabled = observation?.status === 'waiting-session' || observation?.status === 'sending';
      status.textContent = `${locale === 'zh' ? '验收测试' : 'Acceptance test'} · ${notificationObservationText(observation)}`;
    };
    button.onclick = () => {
      if (button.disabled) return;
      void control.sendDiagnosticTest();
    };
    row.append(button, status);
    host.append(row);
    const unsubscribe = control.subscribe(render);
    render();
    return () => { unsubscribe(); button.onclick = null; row.remove(); };
  };
  return control;
}
