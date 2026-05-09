import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

/**
 * Per-sidebar slide animation state machine. Wraps the user's persisted
 * "visible" intent with the four-phase mount lifecycle so the surface can:
 *   - mount one paint *before* the slide-in transition starts (so the
 *     transition has somewhere to interpolate *from*),
 *   - stay mounted *during* the slide-out transition (so the transform can
 *     run to completion),
 *   - unmount cleanly *after* the slide-out completes.
 *
 * Phase model:
 *
 *   closed  ──setVisible(true)──▶  opening  ──rAF (post-paint)──▶  open
 *      ▲                                ▲                              │
 *      │                                │                              │
 *   timer (ANIM_MS)                  setVisible(true)            setVisible(false)
 *      │                                │                              │
 *   closing  ◀─────────────────────────┴──────────────────────────────┘
 *
 * Notes / optimizations:
 *   - **flushSync + double rAF** when entering. flushSync forces React 18 to
 *     commit the `opening` paint synchronously; the double rAF ensures we
 *     wait one *full* paint cycle before flipping to `open` so the CSS
 *     transition starts from the closed transform (`translate3d(-100%,0,0)`)
 *     instead of being collapsed to a zero-frame jump.
 *   - **Reverse mid-animation**: toggling while in `closing` skips back to
 *     `open` immediately; CSS interpolates from the current mid-transform
 *     value back to 0 because the surface stays mounted the whole time.
 *   - **`prefers-reduced-motion`** short-circuits both directions to
 *     `open`/`closed` synchronously (no rAF, no setTimeout), so the
 *     surface mounts/unmounts without any 220 ms wait.
 *   - **Timer cleanup**: every transition cancels any in-flight rAF or
 *     setTimeout from the previous transition, so rapid toggles don't leak
 *     ghost events that would resurrect the wrong phase later.
 */

const SIDEBAR_ANIM_MS = 220;

type Phase = 'closed' | 'opening' | 'open' | 'closing';

interface PaneState {
  phase: Phase;
  visible: boolean;
}

interface UseSidebarPaneOptions {
  /** localStorage key for the user's persisted visible intent. */
  storageKey: string;
  /** Default visible value when storage is empty or unreadable. */
  defaultVisible: boolean;
}

export interface SidebarPane {
  /** User's persisted visible intent (drives icon, splitter mount). */
  visible: boolean;
  /** Should the surface be in the React tree at all (true during the
   *  full open + closing cycle, false only when fully closed). */
  present: boolean;
  /** Drives the slot's `data-state` for slide animation. `open` while
   *  visible (and during the brief closing tail), `closed` while hidden. */
  surfaceState: 'open' | 'closed';
  /** True only while the open/close transition is in flight. Consumers
   *  use this to gate CSS transitions on layout properties (slot
   *  flex-basis, margin-right) so a drag-resize that updates
   *  `--sidebar-width` doesn't get animated through 220 ms — that
   *  reads as severe input lag during pointermove. */
  transitioning: boolean;
  /** Set the persisted intent; runs the appropriate animation. */
  setVisible: (next: boolean) => void;
  /** Convenience flip of `visible`. */
  toggle: () => void;
}

function readVisible(key: string, defaultVisible: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return defaultVisible;
  } catch {
    return defaultVisible;
  }
}

function persistVisible(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* private mode / quota — in-memory state still wins */
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useSidebarPane({
  storageKey,
  defaultVisible,
}: UseSidebarPaneOptions): SidebarPane {
  const [state, setState] = useState<PaneState>(() => {
    const v = readVisible(storageKey, defaultVisible);
    return { phase: v ? 'open' : 'closed', visible: v };
  });

  // In-flight enter rAF id and exit timer id. We always cancel both before
  // scheduling a new transition so a fast toggle (open → close → open
  // within ANIM_MS) can't accidentally fire a stale timer that would put
  // us back in the wrong phase.
  const enterRaf = useRef<number | null>(null);
  const enterRaf2 = useRef<number | null>(null);
  const exitTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (enterRaf.current !== null) cancelAnimationFrame(enterRaf.current);
      if (enterRaf2.current !== null) cancelAnimationFrame(enterRaf2.current);
      if (exitTimer.current !== null) clearTimeout(exitTimer.current);
    };
  }, []);

  const setVisible = useCallback(
    (next: boolean) => {
      persistVisible(storageKey, next);

      // Cancel any in-flight transition timers from the previous toggle.
      if (enterRaf.current !== null) {
        cancelAnimationFrame(enterRaf.current);
        enterRaf.current = null;
      }
      if (enterRaf2.current !== null) {
        cancelAnimationFrame(enterRaf2.current);
        enterRaf2.current = null;
      }
      if (exitTimer.current !== null) {
        clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }

      // prefers-reduced-motion: snap to terminal phase synchronously so
      // the surface mounts/unmounts without the 220ms perceptual delay.
      if (prefersReducedMotion()) {
        setState({ phase: next ? 'open' : 'closed', visible: next });
        return;
      }

      if (next) {
        // Show: if the surface is unmounted, we must paint the closed-state
        // transform first before flipping to open, otherwise CSS has no
        // "from" value and the transition collapses to a zero-frame jump.
        // If it's still mounted (we were mid-closing), reuse the existing
        // surface and let CSS reverse the in-flight transform interpolation.
        flushSync(() => {
          setState(s =>
            s.phase === 'open' || s.phase === 'closing'
              ? { phase: 'open', visible: true }
              : { phase: 'opening', visible: true },
          );
        });
        // Two rAFs to guarantee a paint in the `opening` (translate -100%)
        // state before flipping to `open` (translate 0). One rAF can fire
        // before paint in some cases; two is the well-known safe pattern
        // for "do this after the next visible frame".
        enterRaf.current = requestAnimationFrame(() => {
          enterRaf.current = null;
          enterRaf2.current = requestAnimationFrame(() => {
            enterRaf2.current = null;
            setState(s =>
              s.phase === 'opening'
                ? { phase: 'open', visible: true }
                : s,
            );
          });
        });
      } else {
        // Hide: flip surface class to closed-state immediately; the
        // transform transition runs over the next ANIM_MS frames; once it
        // settles, the timer below unmounts the surface.
        setState(s =>
          s.phase === 'closed'
            ? { ...s, visible: false }
            : { phase: 'closing', visible: false },
        );
        exitTimer.current = window.setTimeout(() => {
          exitTimer.current = null;
          setState(s =>
            s.phase === 'closing'
              ? { phase: 'closed', visible: false }
              : s,
          );
        }, SIDEBAR_ANIM_MS);
      }
    },
    [storageKey],
  );

  // Keep `visible` accessible to the latest `toggle` without re-creating
  // the callback per render — fewer effect/callback re-runs downstream.
  const stateRef = useRef(state);
  stateRef.current = state;
  const toggle = useCallback(() => {
    setVisible(!stateRef.current.visible);
  }, [setVisible]);

  return {
    visible: state.visible,
    present: state.phase !== 'closed',
    surfaceState: state.phase === 'open' ? 'open' : 'closed',
    transitioning: state.phase === 'opening' || state.phase === 'closing',
    setVisible,
    toggle,
  };
}
