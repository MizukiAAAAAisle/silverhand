import { useSyncExternalStore } from "react";
import type { AppUpdateInstallMode, AppUpdateState } from "@silverhand/client";
import { getPlatform } from "@/platform";

let state: AppUpdateState | null = null;
let dialogOpen = false;
let started = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Mirrors main's single update state; null when the platform cannot update itself.
 * Started at mount so a menu "show dialog" request is never missed.
 */
export function startAppUpdateStore(): void {
  if (started) return;
  started = true;
  const appUpdate = getPlatform().appUpdate;
  if (!appUpdate) return;
  appUpdate.subscribe((next) => {
    state = next;
    emit();
  });
  appUpdate.onShowDialog(() => openAppUpdateDialog());
  void appUpdate.getState().then((initial) => {
    if (state === null) {
      state = initial;
      emit();
    }
  });
}

function subscribe(listener: () => void): () => void {
  startAppUpdateStore();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppUpdateState(): AppUpdateState | null {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => null,
  );
}

export function useAppUpdateDialogOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => dialogOpen,
    () => false,
  );
}

export function openAppUpdateDialog(): void {
  dialogOpen = true;
  emit();
}

export function closeAppUpdateDialog(): void {
  dialogOpen = false;
  emit();
}

/** An update the user can act on: worth an entry point outside the dialog. */
export function hasActionableUpdate(s: AppUpdateState | null): boolean {
  return (
    s?.status === "available" ||
    s?.status === "downloading" ||
    s?.status === "downloaded" ||
    s?.status === "installing" ||
    s?.status === "scheduled" ||
    (s?.status === "error" && s.version !== null)
  );
}

/** One user intent: find the update if not yet known, then download it. */
async function update(): Promise<void> {
  const appUpdate = getPlatform().appUpdate;
  if (!appUpdate) return;
  const current = await appUpdate.getState();
  if (current?.status === "idle" || (current?.status === "error" && current.version === null)) {
    await appUpdate.check();
  }
  const next = await appUpdate.getState();
  if (next?.status === "available" || (next?.status === "error" && next.version !== null)) {
    await appUpdate.download();
  }
}

export const appUpdateActions = {
  update,
  check: () => getPlatform().appUpdate?.check(),
  download: () => getPlatform().appUpdate?.download(),
  install: (mode: AppUpdateInstallMode) => getPlatform().appUpdate?.install(mode),
};
