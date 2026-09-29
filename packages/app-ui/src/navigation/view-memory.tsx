import { createContext, useContext, useRef, useMemo, useLayoutEffect, type ReactNode } from "react";

export interface ReadingPosition {
  anchor?: string;
  top?: number;
  atBottom: boolean;
}
const ViewMemory = createContext<Map<string, ReadingPosition> | null>(null);
/** Lives inside the authenticated boundary; no cross-viewer persistence. */
export function ViewMemoryProvider({ children }: { children: ReactNode }) {
  const memory = useRef(new Map<string, ReadingPosition>());
  return <ViewMemory.Provider value={memory.current}>{children}</ViewMemory.Provider>;
}
export const useViewMemory = () => useContext(ViewMemory);

/** Restore ordinary lists after their cached rows have mounted. */
export function useListReadingPosition(key: string) {
  const memory = useViewMemory();
  const ref = useRef<HTMLElement | null>(null);
  const restore = useMemo(
    () => ({ pending: true, top: memory?.get(key)?.top ?? 0 }),
    [key, memory],
  );
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !restore.pending) return;
    if (restore.top > 0 && node.scrollHeight <= node.clientHeight) return;
    node.scrollTop = restore.top;
    restore.pending = false;
  });
  return {
    ref: (node: HTMLElement | null) => {
      ref.current = node;
    },
    onScroll: () => {
      if (ref.current && !restore.pending)
        memory?.set(key, { top: ref.current.scrollTop, atBottom: false });
    },
  };
}
