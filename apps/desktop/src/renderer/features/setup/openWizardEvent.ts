/**
 * D4.a Commit 5d-fixup (Cindy P1-2) — small renderer-only event
 * channel for opening the SetupWizard modal from places that
 * aren't the App menu IPC subscriber.
 *
 * Why a custom DOM event:
 *   - The App menu's "Connect to backend…" item already opens the
 *     wizard via `window.agentHub.onNavigateSetupWizard`, which is
 *     a main-→-renderer push.
 *   - The `BackendUnreachableGate` is renderer-only and shouldn't
 *     round-trip through IPC just to open a sibling React modal;
 *     a DOM `CustomEvent` keeps the dispatch in-process and stays
 *     fully local.
 *   - The modal subscribes to BOTH the IPC AND this DOM event,
 *     keeping the App-menu path untouched.
 */

const OPEN_SETUP_WIZARD_EVENT = 'silverhand:open-setup-wizard';

export function dispatchOpenSetupWizard(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETUP_WIZARD_EVENT));
}

export function subscribeOpenSetupWizard(handler: () => void): () => void {
  const listener = (): void => handler();
  window.addEventListener(OPEN_SETUP_WIZARD_EVENT, listener);
  return () => {
    window.removeEventListener(OPEN_SETUP_WIZARD_EVENT, listener);
  };
}
