import type { ClientPlatform } from '@silverhand/client';
import { createIOSPlatform } from '../../ios/src/platform';
import { nativeBridge } from '../../ios/src/bridge';
import { createSystemBack } from './system-back';

// Reuse upstream mobile auth/epoch/socket semantics. Presentation capabilities
// are deliberately absent: shared React already owns these fallback paths.
export function createAndroidPlatform(reset: () => void): ClientPlatform {
  const mobile = createIOSPlatform(nativeBridge, reset);
  return {
    client: mobile.client,
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
