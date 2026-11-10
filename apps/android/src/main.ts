import {
  configurePlatform,
  initializeThemePersistence,
  mountApp,
  resumeApp,
  type ThemeId,
} from '@silverhand/app-ui';
import { nativeBridge } from '../../ios/src/bridge';
import { createAndroidPlatform } from './platform';
import { createAndroidNotices } from './notices';
import { createAndroidNotifications, type AndroidNotificationBridge } from './notifications';
import './notices.css';
import '../../ios/src/mobile.css';
import './short-viewport.css';
import { bindShortViewport } from './short-viewport';

// These methods belong only to the Android implementation of the existing
// proxy. Do not advertise them on the reused iOS bridge/platform contract.
const themeBridge = nativeBridge as typeof nativeBridge & {
  getTheme(): Promise<{ theme?: ThemeId | null }>;
  saveTheme(input: { theme: ThemeId }): Promise<void>;
};

let notices: ReturnType<typeof createAndroidNotices> | undefined;
let notifications: ReturnType<typeof createAndroidNotifications> | undefined;
function disposePresentation() {
  notices?.dispose();
  notifications?.dispose();
}
function resetApplication() {
  disposePresentation();
  const appearance = localStorage.getItem('silverhand:appearance');
  localStorage.clear();
  if (appearance !== null) localStorage.setItem('silverhand:appearance', appearance);
  sessionStorage.clear();
  location.replace(location.origin + '/');
}
async function start() {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing root element');
  await nativeBridge.addListener('sessionInvalidated', resetApplication);
  await nativeBridge.addListener('foreground', () => {
    void resumeApp();
  });
  notices = createAndroidNotices();
  // Android-only methods on the existing plugin, not an addition to the iOS bridge contract.
  notifications = createAndroidNotifications(nativeBridge as unknown as AndroidNotificationBridge);
  window.addEventListener('pagehide', disposePresentation, { once: true });
  configurePlatform(createAndroidPlatform(resetApplication, notices, notifications));
  await nativeBridge.getProfile();
  await initializeThemePersistence({
    getTheme: async () => (await themeBridge.getTheme()).theme,
    saveTheme: (theme) => themeBridge.saveTheme({ theme }),
  });
  mountApp(root, { loginFirst: true, showServerAddress: true });
  const releaseShortViewport = bindShortViewport();
  window.addEventListener('pagehide', releaseShortViewport, { once: true });
}
void start().catch((error) => {
  disposePresentation();
  const root = document.getElementById('root');
  if (root) root.textContent = `Unable to start Silverhand: ${String(error)}`;
});
