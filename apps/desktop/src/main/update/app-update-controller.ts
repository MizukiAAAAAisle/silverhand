import type { AppUpdateInstallMode, AppUpdateState } from '@silverhand/client';

/** The install mechanism; supplied once a release channel exists. */
export interface AppUpdateEngine {
  /** The newer version this build may update to, or null when current. */
  check(): Promise<{ version: string } | null>;
  download(onProgress: (transferred: number, total: number | null) => void): Promise<void>;
  /** Hands the downloaded bundle to the OS installer, which verifies its signature. */
  stage(): Promise<void>;
  /** Quits and installs a staged update. */
  quitAndInstall(): void;
}

export const APP_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Owns the single update state; checks never download, downloads and installs need a user action. */
export class AppUpdateController {
  private state: AppUpdateState = { status: 'idle', lastCheckedAt: null };
  private readonly listeners = new Set<(state: AppUpdateState) => void>();
  private inflightCheck: Promise<void> | null = null;
  private inflightDownload: Promise<void> | null = null;
  private inflightStage: Promise<void> | null = null;
  private quitting = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly engine: AppUpdateEngine,
    private readonly now: () => number = Date.now,
  ) {}

  getState(): AppUpdateState {
    return this.state;
  }

  subscribe(listener: (state: AppUpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Checks now, then every interval while the app lives. */
  start(intervalMs = APP_UPDATE_CHECK_INTERVAL_MS): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  check(): Promise<void> {
    // A found or downloaded update is not displaced by a later check.
    const s = this.state.status;
    if (s === 'downloading' || s === 'downloaded' || s === 'installing' || s === 'scheduled')
      return Promise.resolve();
    if (this.inflightCheck) return this.inflightCheck;
    const previous = this.state;
    this.set({ status: 'checking' });
    this.inflightCheck = this.engine
      .check()
      .then(
        (found) =>
          this.set(
            found
              ? { status: 'available', version: found.version }
              : { status: 'idle', lastCheckedAt: this.now() },
          ),
        (err: unknown) =>
          this.set(
            previous.status === 'available'
              ? previous
              : { status: 'error', message: errorMessage(err), version: null },
          ),
      )
      .finally(() => {
        this.inflightCheck = null;
      });
    return this.inflightCheck;
  }

  download(): Promise<void> {
    if (this.inflightDownload) return this.inflightDownload;
    const version = downloadableVersion(this.state);
    if (version === null) return Promise.resolve();
    this.set({ status: 'downloading', version, transferred: 0, total: null });
    this.inflightDownload = this.engine
      .download((transferred, total) => {
        if (this.state.status === 'downloading') {
          this.set({ status: 'downloading', version, transferred, total });
        }
      })
      .then(
        () => this.set({ status: 'downloaded', version }),
        (err: unknown) => this.set({ status: 'error', message: errorMessage(err), version }),
      )
      .finally(() => {
        this.inflightDownload = null;
      });
    return this.inflightDownload;
  }

  /**
   * The user's install choice. A staged update installs on the next normal
   * quit; "now" also quits immediately. While staging, the first choice wins.
   */
  install(mode: AppUpdateInstallMode): Promise<void> {
    if (this.state.status === 'scheduled') {
      if (mode === 'now') this.quitAndInstallOnce();
      return Promise.resolve();
    }
    if (this.inflightStage) return this.inflightStage;
    if (this.state.status !== 'downloaded') return Promise.resolve();
    const version = this.state.version;
    this.set({ status: 'installing', version });
    this.inflightStage = this.engine
      .stage()
      .then(
        () => {
          this.set({ status: 'scheduled', version });
          if (mode === 'now') this.quitAndInstallOnce();
        },
        // Retrying downloads again, which reuses electron-updater's verified cache.
        (err: unknown) => this.set({ status: 'error', message: errorMessage(err), version }),
      )
      .finally(() => {
        this.inflightStage = null;
      });
    return this.inflightStage;
  }

  // Quitting runs async cleanup in before-quit; a second request must not start another quit.
  private quitAndInstallOnce(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.engine.quitAndInstall();
  }

  private set(next: AppUpdateState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

function downloadableVersion(state: AppUpdateState): string | null {
  if (state.status === 'available') return state.version;
  if (state.status === 'error') return state.version;
  return null;
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500) || 'Update failed.';
}
