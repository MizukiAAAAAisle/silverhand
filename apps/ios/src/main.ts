import { configurePlatform, mountApp, resumeApp } from "@silverhand/app-ui";
import { nativeBridge } from "./bridge";
import { createIOSPlatform } from "./platform";
import "./mobile.css";

// This WebView has one native profile. Never retain server-scoped browser state
// across logout or origin changes, including modules hydrated at import time.
function resetApplication(): void {
  localStorage.clear();
  sessionStorage.clear();
  window.location.replace(window.location.origin + "/");
}

const TOUCH_TITLEBAR_ROW = 48;

async function start(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing root element");
  await nativeBridge.addListener("sessionInvalidated", resetApplication);
  // Keep the React tree and pending send identities alive across suspension.
  // Native closes sockets in the background; resume revalidates and refetches.
  await nativeBridge.addListener("foreground", () => {
    void resumeApp();
  });
  // A docked keyboard already covers the home-indicator area. Do not add
  // that screen-edge inset a second time above the keyboard/accessory bar.
  await nativeBridge.addListener("keyboardChanged", ({ docked }) => {
    const style = document.documentElement.style;
    if (docked) style.setProperty("--input-safe-area-bottom", "0px");
    else style.removeProperty("--input-safe-area-bottom");
  });
  // iPad titlebar: touch-sized controls in every mode. In windowed mode the
  // row starts below any status bar over the window and is mirrored around
  // the window-controls centre line, so the controls and the row share one
  // axis. Full screen keeps the safe-area inset above a touch-height row.
  await nativeBridge.addListener("windowControls", ({ top, height, statusBar }) => {
    const style = document.documentElement.style;
    style.setProperty("--titlebar-control-size", "32px");
    style.setProperty("--titlebar-icon-size", "18px");
    style.setProperty("--titlebar-text-size", "13px");
    if (height === 0) {
      document.documentElement.dataset["windowControls"] = "hidden";
      style.removeProperty("--titlebar-inset-top");
      style.setProperty("--titlebar-row-height", `${TOUCH_TITLEBAR_ROW}px`);
      return;
    }
    delete document.documentElement.dataset["windowControls"];
    const row = 2 * (top + height / 2 - statusBar);
    style.setProperty("--titlebar-inset-top", `${statusBar}px`);
    style.setProperty("--titlebar-row-height", `${Math.max(TOUCH_TITLEBAR_ROW, row)}px`);
  });
  configurePlatform(createIOSPlatform(nativeBridge, resetApplication));
  await nativeBridge.getProfile();
  mountApp(root, { loginFirst: true, showServerAddress: true });
}

void start().catch((error) => {
  const root = document.getElementById("root");
  if (root) root.textContent = `Unable to start Silverhand: ${String(error)}`;
});
