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
  configurePlatform(createIOSPlatform(nativeBridge, resetApplication));
  const profile = await nativeBridge.getProfile();
  if (profile.server_url) {
    mountApp(root);
    return;
  }

  const form = document.createElement('form');
  form.className = 'ios-server-setup';
  form.innerHTML =
    '<h1>Connect to Silverhand</h1><label for="server">Server address</label><input id="server" name="server" type="url" inputmode="url" autocomplete="url" placeholder="https://your-server.example" required /><button type="submit">Connect</button><p role="alert"></p>';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = form.querySelector('input')!;
    const button = form.querySelector('button')!;
    const message = form.querySelector('p')!;
    button.disabled = true;
    message.textContent = '';
    try {
      await nativeBridge.saveProfile({ serverUrl: input.value.trim() });
      resetApplication();
    } catch (error) {
      message.textContent = String(error);
      button.disabled = false;
    }
  });
  root.replaceChildren(form);
}

void start().catch((error) => {
  const root = document.getElementById('root');
  if (root) root.textContent = `Unable to start Silverhand: ${String(error)}`;
});
