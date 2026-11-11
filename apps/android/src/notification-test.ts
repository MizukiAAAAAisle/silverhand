import type { createAndroidNotifications } from './notifications';
import { locale } from '@/lib/i18n';
import { notificationObservationText } from '@/pages/settings/components/notification-diagnostics-pane';

/** This entire module is imported only by the acceptance build-time branch. */
export function installNotificationTest(owner: ReturnType<typeof createAndroidNotifications>) {
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
      const observation = owner.getTestSnapshot();
      button.disabled = observation?.status === 'waiting-session' || observation?.status === 'sending';
      status.textContent = `${locale === 'zh' ? '验收测试' : 'Acceptance test'} · ${notificationObservationText(observation)}`;
    };
    button.onclick = () => {
      if (button.disabled) return;
      void owner.sendDiagnosticNotice({ title: 'Silverhand 通知测试', body: '这是一条验收测试通知', force: true });
    };
    row.append(button, status);
    host.append(row);
    const unsubscribe = owner.subscribeTest(render);
    render();
    return () => { unsubscribe(); button.onclick = null; row.remove(); };
  };
}
