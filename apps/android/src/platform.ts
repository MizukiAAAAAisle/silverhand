import type { ClientPlatform } from '@silverhand/client';
import { createIOSPlatform } from '../../ios/src/platform';
import { nativeBridge } from '../../ios/src/bridge';
import type { createAndroidNotices } from './notices';
import { createSystemBack } from './system-back';

// Reuse upstream mobile auth/epoch/socket semantics. Android supplies its own
// presentation without advertising iOS navigation or changing shared UI policy.
export function createAndroidPlatform(
  reset: () => void,
  notices: Pick<ReturnType<typeof createAndroidNotices>, 'banner' | 'toast'>,
): ClientPlatform {
  const mobile = createIOSPlatform(nativeBridge, reset);
  return {
    client: mobile.client,
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
