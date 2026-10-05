import type { NativeBridge } from "./bridge";

const TOUCH_TITLEBAR_ROW = 48;

/** Mirrors native device chrome (iPad window controls, iPhone Duo bars and
 * fold) onto the document root, where the shared styles read it. */
export async function installDeviceChrome(bridge: NativeBridge): Promise<void> {
  const root = document.documentElement;

  // iPad titlebar: touch-sized controls in every mode. In windowed mode the
  // row starts below any status bar over the window and is mirrored around
  // the window-controls centre line, so the controls and the row share one
  // axis. Full screen keeps the safe-area inset above a touch-height row.
  await bridge.addListener("windowControls", ({ top, height, statusBar }) => {
    root.style.setProperty("--titlebar-control-size", "32px");
    root.style.setProperty("--titlebar-icon-size", "18px");
    root.style.setProperty("--titlebar-text-size", "13px");
    if (height === 0) {
      root.dataset["windowControls"] = "hidden";
      root.style.removeProperty("--titlebar-inset-top");
      root.style.setProperty("--titlebar-row-height", `${TOUCH_TITLEBAR_ROW}px`);
      return;
    }
    delete root.dataset["windowControls"];
    const row = 2 * (top + height / 2 - statusBar);
    root.style.setProperty("--titlebar-inset-top", `${statusBar}px`);
    root.style.setProperty("--titlebar-row-height", `${Math.max(TOUCH_TITLEBAR_ROW, row)}px`);
  });

  // iPhone Duo stands the system tab bar on a side edge; it then replaces the
  // page's navigation rail in every layout.
  await bridge.addListener("verticalBar", ({ edge }) => {
    if (edge) {
      root.dataset["verticalBar"] = edge;
    } else {
      delete root.dataset["verticalBar"];
    }
  });

  // A half-open iPhone Duo divides the display at the fold; `start`/`end` are
  // the band's edges along the dividing axis.
  await bridge.addListener("fold", (fold) => {
    if (!fold.axis) {
      delete root.dataset["fold"];
      root.style.removeProperty("--fold-start");
      root.style.removeProperty("--fold-end");
      return;
    }
    root.dataset["fold"] = fold.axis;
    root.style.setProperty("--fold-start", `${fold.start}px`);
    root.style.setProperty("--fold-end", `${fold.end}px`);
  });
}
