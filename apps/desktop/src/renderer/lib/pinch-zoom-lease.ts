import { useEffect } from "react";

/**
 * Trackpad pinch (`ctrl+wheel`) must be enabled process-wide through the preload
 * `setPinchZoom` before Chromium dispatches it to ANY frame — macOS Electron
 * disables it by default. Three previewers want it (the image Lightbox, the
 * Mermaid Lightbox, and the HTML attachment tab) and their lifetimes overlap: an
 * HTML tab stays mounted under an open Lightbox. A per-component boolean toggle
 * races — the last component to unmount writes `false` and kills pinch for a
 * still-open peer. This lease refcounts: the first acquire enables, only the
 * last release disables.
 *
 * `makePinchZoomLease` is exported for tests; the app uses the shared hook.
 */
export function makePinchZoomLease(apply: (enabled: boolean) => void): {
  acquire: () => () => void;
} {
  let count = 0;
  return {
    acquire(): () => void {
      count += 1;
      if (count === 1) apply(true);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        count -= 1;
        if (count === 0) apply(false);
      };
    },
  };
}

const lease = makePinchZoomLease((enabled) => {
  // Optional-chained so a renderer on a not-yet-restarted preload can't throw.
  window.silverhand.setPinchZoom?.(enabled);
});

/** Hold the process-wide pinch lease while `active`. */
export function usePinchZoomLease(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    return lease.acquire();
  }, [active]);
}
