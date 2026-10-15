import { useSyncExternalStore } from "react";

/**
 * Which chat sidebar the viewer reads: `tree` groups conversations under their
 * workspace in the viewer's own order; `recent` is one flat list ordered by the
 * latest message, each row carrying its preview. Owned by Settings > Appearance.
 *
 * A module store for the same reason as the message-layout mode: the writer
 * (Settings) and the reader (the sidebar) are different surfaces mounted at the
 * same time, and a same-window `localStorage` write raises no `storage` event.
 */
export type SidebarStyle = "tree" | "recent";

export const SIDEBAR_STYLES: ReadonlyArray<SidebarStyle> = ["tree", "recent"];

const STORAGE_KEY = "silverhand:layout.sidebar-style";
const DEFAULT_STYLE: SidebarStyle = "tree";

function parse(raw: string | null): SidebarStyle {
  return raw === "tree" || raw === "recent" ? raw : DEFAULT_STYLE;
}

function readStored(): SidebarStyle {
  try {
    return parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_STYLE;
  }
}

let style: SidebarStyle = readStored();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) {
    return;
  }

  const next = parse(event.newValue);
  if (next !== style) {
    style = next;
    emit();
  }
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function getSnapshot(): SidebarStyle {
  return style;
}

export function setSidebarStyle(next: SidebarStyle): void {
  if (next === style) {
    return;
  }

  style = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Private mode or quota: the in-memory switch still applies this session.
  }
  emit();
}

export function useSidebarStyle(): SidebarStyle {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
