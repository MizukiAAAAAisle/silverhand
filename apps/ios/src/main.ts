import { configurePlatform, mountApp, resumeApp } from '@silverhand/app-ui';
import { nativeBridge } from './bridge';
import { createIOSPlatform } from './platform';
import './mobile.css';

// This WebView has one native profile. Never retain server-scoped browser state
// across logout or origin changes, including modules hydrated at import time.
function resetApplication(): void {
  localStorage.clear();
  sessionStorage.clear();
  window.location.replace(window.location.origin + '/');
}

async function start(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing root element');
  await nativeBridge.addListener('sessionInvalidated', resetApplication);
  // Keep the React tree and pending send identities alive across suspension.
  // Native closes sockets in the background; resume revalidates and refetches.
  await nativeBridge.addListener('foreground', () => {
    void resumeApp();
  });
  // A docked keyboard already covers the home-indicator area. Do not add
  // that screen-edge inset a second time above the keyboard/accessory bar.
  await nativeBridge.addListener('keyboardChanged', ({ docked }) => {
    const style = document.documentElement.style;
    if (docked) style.setProperty('--input-safe-area-bottom', '0px');
    else style.removeProperty('--input-safe-area-bottom');
  });
  configurePlatform(createIOSPlatform(nativeBridge, resetApplication));
  await nativeBridge.getProfile();
  mountApp(root, { loginFirst: true });
}

void start().catch((error) => {
  const root = document.getElementById('root');
  if (root) root.textContent = `Unable to start Silverhand: ${String(error)}`;
});
