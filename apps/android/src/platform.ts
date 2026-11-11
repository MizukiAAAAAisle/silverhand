import type { ClientPlatform } from '@silverhand/client';
import { createIOSPlatform } from '../../ios/src/platform';
import { nativeBridge } from '../../ios/src/bridge';
import type { createAndroidNotices } from './notices';
import type { createAndroidNotifications } from './notifications';
import { createSystemBack } from './system-back';

// Reuse upstream mobile auth/epoch/socket semantics. Android supplies its own
// presentation without advertising iOS navigation or changing shared UI policy.
export function createAndroidPlatform(
  reset: () => void,
  notices: Pick<ReturnType<typeof createAndroidNotices>, 'banner' | 'toast'>,
  notifications: Pick<ReturnType<typeof createAndroidNotifications>, 'capability' | 'refreshSession' | 'diagnostics'>,
): ClientPlatform {
  const mobile = createIOSPlatform(nativeBridge, reset);
  const authenticate = async (request: ReturnType<typeof mobile.client.login>) => {
    const result = await request;
    if (result.ok) await notifications.refreshSession();
    return result;
  };
  return {
    client: {
      ...mobile.client,
      login: (input) => authenticate(mobile.client.login(input)),
      signup: (input) => authenticate(mobile.client.signup(input)),
    },
    notifications: notifications.capability,
    notificationDiagnostics: notifications.diagnostics,
    banner: notices.banner,
    toast: notices.toast,
    files: {
      openExternal: mobile.files.openExternal,
      saveAttachment: mobile.files.saveAttachment,
      sharePngExport: mobile.files.sharePngExport,
      savePngExport: mobile.files.savePngExport,
      copyPngExport: mobile.files.copyPngExport,
    },
    getAppVersion: mobile.getAppVersion,
    systemBack: createSystemBack(),
  };
}
