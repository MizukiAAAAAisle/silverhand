import { useSyncExternalStore } from "react";

/**
 * The single source of layout classes. Width and input are independent axes:
 * an iPad is regular width with a coarse pointer, a narrow desktop window is
 * compact with a fine one.
 *
 * - Width class: `compact` below the breakpoint, `regular` above. CSS reads it
 *   only through `<html data-layout>`, never through its own width query, so a
 *   new class or breakpoint changes this file alone.
 * - Input: `(pointer: coarse)`. Touch affordances (long-press menus, no
 *   autofocus that raises the keyboard) follow input, not width.
 */
export type LayoutClass = "compact" | "regular";

export const COMPACT_QUERY = "(max-width: 767px)";
const COARSE_POINTER_QUERY = "(pointer: coarse)";

function mediaStore(query: string) {
  return {
    subscribe: (notify: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", notify);
      return () => media.removeEventListener("change", notify);
    },
    read: () => window.matchMedia(query).matches,
  };
}

const compactMedia = mediaStore(COMPACT_QUERY);
const coarseMedia = mediaStore(COARSE_POINTER_QUERY);

export function readLayoutClass(): LayoutClass {
  return compactMedia.read() ? "compact" : "regular";
}

export function useCompactLayout(): boolean {
  return useSyncExternalStore(compactMedia.subscribe, compactMedia.read, () => false);
}

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(coarseMedia.subscribe, coarseMedia.read, () => false);
}

/** Mirrors the width class onto `<html data-layout>` so portaled surfaces
 *  (dialogs, menus, the signed-out screen) match the same selectors. */
export function bindLayoutAttribute(root: HTMLElement): () => void {
  const apply = () => {
    root.dataset.layout = readLayoutClass();
  };
  apply();
  const stop = compactMedia.subscribe(apply);
  return () => {
    stop();
    delete root.dataset.layout;
  };
}
