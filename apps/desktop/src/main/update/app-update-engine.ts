import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, autoUpdater as nativeUpdater } from "electron";
import { MacUpdater } from "electron-updater";
import { AppUpdateController, type AppUpdateEngine } from "./app-update-controller.js";

interface UpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
}

type NativeUpdater = Pick<typeof nativeUpdater, "on" | "off" | "checkForUpdates">;

/** Wraps electron-updater so it never downloads or installs without a user action. */
export function createElectronUpdaterEngine(
  updater: MacUpdater,
  native: NativeUpdater = nativeUpdater,
): AppUpdateEngine {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  return {
    async check() {
      const result = await updater.checkForUpdates();
      return result?.isUpdateAvailable ? { version: result.updateInfo.version } : null;
    },
    async download(onProgress) {
      const listener = (p: { transferred: number; total: number }) =>
        onProgress(p.transferred, p.total || null);
      updater.on("download-progress", listener);
      try {
        await updater.downloadUpdate();
      } finally {
        updater.off("download-progress", listener);
      }
    },
    // With autoInstallOnAppQuit off, MacUpdater stops after pointing Squirrel's
    // feed at the downloaded zip; this check makes Squirrel fetch and verify it.
    // Once staged, Squirrel installs on the next quit.
    stage() {
      return new Promise<void>((resolve, reject) => {
        const settle = (err?: Error): void => {
          native.off("update-downloaded", onReady);
          native.off("error", settle);
          if (err) reject(err);
          else resolve();
        };
        const onReady = (): void => settle();
        native.on("update-downloaded", onReady);
        native.on("error", settle);
        native.checkForUpdates();
      });
    },
    quitAndInstall() {
      updater.quitAndInstall();
    },
  };
}

/**
 * Only signed release builds carry `app-update.yml` (its channel selects the
 * variant's feed); every other build has no update channel.
 */
export function createAppUpdateController(logger?: UpdaterLogger): AppUpdateController | null {
  if (process.platform !== "darwin" || !app.isPackaged) return null;
  if (!existsSync(join(process.resourcesPath, "app-update.yml"))) return null;
  const updater = new MacUpdater();
  updater.logger = logger ?? null;
  return new AppUpdateController(createElectronUpdaterEngine(updater), app.getVersion());
}
