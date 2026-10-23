import type { NativeBridge } from "./bridge";

/** Mirrors native chrome (the page bar's extent, and on iPhone Duo the fold)
 * onto the document root, where the shared styles read it. */
export async function installDeviceChrome(bridge: NativeBridge): Promise<void> {
  const root = document.documentElement;

  // Where the native page bar ends, and the height of the view tabs under it.
  // A page drawing its header there clears them (`[data-native-bar-clearance]`).
  // On iPhone Duo the bars stand on a side edge, in place of the wide layout's
  // rail. `corner` is the display's corner radius.
  await bridge.addListener("barMetrics", ({ bottom, tabs, vertical, corner }) => {
    root.style.setProperty("--native-bar-bottom", `${bottom}px`);
    root.style.setProperty("--display-corner-radius", `${corner}px`);
    root.style.setProperty("--native-bar-tabs", `${tabs}px`);
    if (vertical) root.dataset["verticalBar"] = "";
    else delete root.dataset["verticalBar"];
  });

  // The native composer floats over the page. Each is a distance up from the
  // bottom of the window to its top: at rest, at the height its text gives
  // it (the keyboard included), and as drawn; `picker` is the room the
  // candidate list takes over it. Zero while none shows.
  await bridge.addListener("composerMetrics", ({ rest, reserve, overlay, picker }) => {
    root.style.setProperty("--native-composer-rest", `${rest}px`);
    root.style.setProperty("--native-composer-reserve", `${reserve}px`);
    root.style.setProperty("--native-composer-overlay", `${overlay}px`);
    root.style.setProperty("--native-composer-picker", `${picker}px`);
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
