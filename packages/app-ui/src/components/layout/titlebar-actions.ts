import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PageBarItem } from "@silverhand/client";
import type { NativeBarAction } from "./native-page-bar";

/*
 * A pane header's buttons, handed to the wide layout's native titlebar where
 * it carries them (beside a vertical tab bar, which leaves no titlebar row).
 * The pane on screen claims; the latest claim still standing shows.
 */

type Claim = { items: PageBarItem[]; run: Map<string, () => void> };

const claims = new Map<symbol, Claim>();
const listeners = new Set<() => void>();
let shown: PageBarItem[] = [];

function publish(): void {
  const latest = [...claims.values()].at(-1)?.items ?? [];
  if (JSON.stringify(latest) === JSON.stringify(shown)) {
    return;
  }
  shown = latest;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The buttons the titlebar shows. */
export function useTitlebarActions(): PageBarItem[] {
  return useSyncExternalStore(subscribe, () => shown);
}

/** Runs the shown button `id`. */
export function runTitlebarAction(id: string): void {
  [...claims.values()].at(-1)?.run.get(id)?.();
}

/** Claims the titlebar's buttons while `actions` is non-null. */
export function useTitlebarActionsClaim(actions: readonly (NativeBarAction | null)[] | null): void {
  const [owner] = useState(() => Symbol("titlebar-actions"));
  const latest = useRef(actions);
  latest.current = actions;
  const shownActions = actions?.filter((action) => action !== null) ?? null;
  const serialized = shownActions
    ? JSON.stringify(shownActions.map(({ run: _, ...item }) => item))
    : null;

  useEffect(() => {
    if (serialized === null) {
      return;
    }

    const run = new Map<string, () => void>();
    for (const action of JSON.parse(serialized) as PageBarItem[]) {
      run.set(action.id, () =>
        latest.current?.find((candidate) => candidate?.id === action.id)?.run(),
      );
    }
    claims.delete(owner);
    claims.set(owner, { items: JSON.parse(serialized) as PageBarItem[], run });
    publish();
    return () => {
      claims.delete(owner);
      publish();
    };
  }, [owner, serialized]);
}
