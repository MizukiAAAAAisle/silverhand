import { useSyncExternalStore } from "react";

export const COMPACT_QUERY = "(max-width: 767px)";
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(COMPACT_QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
export function useCompactLayout(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(COMPACT_QUERY).matches,
    () => false,
  );
}
