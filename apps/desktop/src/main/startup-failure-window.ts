/**
 * Electron surface for the startup failure exit.
 *
 * Everything decided here is about the window itself; what the user sees
 * and how failures converge lives in `startup-failure-exit.ts` (unit
 * tested). The contract this file has to honour is the one the exit
 * depends on: **`openWindow` resolves only when the document is on
 * screen, and rejects — with no window left behind — otherwise.**
 * `loadURL` is asynchronous, so a fire-and-forget `void win.loadURL(…)`
 * would swallow a failed load: no `ready-to-show`, an invisible window
 * kept alive, and the user back to zero feedback (#task:1641 review,
 * @Cindy). Hence: await the load, show explicitly on success, and tear
 * the window down before rethrowing.
 */
import { app, BrowserWindow, dialog, shell } from 'electron';
import { BUILD_COMMIT, BUILD_DIRTY } from './build-metadata.js';
import {
  presentStartupFailure,
  STARTUP_FAILURE_EXIT_CODE,
  type StartupFailureExitDeps,
} from './startup-failure-exit.js';
import type { StartupFailureNotice } from './startup-failure.js';

/**
 * A local `data:` document has no network to wait on, so anything slower
 * than this is a stuck web contents rather than slow I/O. Treated as a
 * load failure: the exit falls back to the native box, which is worse
 * looking and far better than an invisible window.
 */
const LOAD_BUDGET_MS = 5_000;

const openWindow: StartupFailureExitDeps['openWindow'] = async ({
  html,
  onAction,
}) => {
  const win = new BrowserWindow({
    width: 520,
    height: 380,
    minWidth: 420,
    minHeight: 260,
    title: 'Silverhand',
    show: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Every navigation in this window is an action, never a page load: the
  // only document is the one passed in.
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    onAction(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    onAction(url);
    return { action: 'deny' };
  });
  // The window owns the process lifetime once it is up: closing it by any
  // means (Quit, close box, ⌘Q) exits non-zero.
  win.on('closed', () => app.exit(STARTUP_FAILURE_EXIT_CODE));

  let budget: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`),
      new Promise<never>((_, reject) => {
        budget = setTimeout(
          () => reject(new Error('startup failure window did not load')),
          LOAD_BUDGET_MS,
        );
      }),
    ]);
    win.show();
  } catch (err) {
    // Drop the close handler first: destroying the window fires `closed`,
    // and exiting there would pre-empt the native error box the caller is
    // about to show.
    win.removeAllListeners('closed');
    if (!win.isDestroyed()) win.destroy();
    throw err;
  } finally {
    if (budget) clearTimeout(budget);
  }
};

export function showStartupFailureWindow(input: {
  notice: StartupFailureNotice;
  logsDir: string | null;
}): void {
  // Resolved here rather than passed in: this is the Electron-facing
  // adapter, and `app.getVersion()` is the release-version SoT
  // (`build-metadata.ts` deliberately carries only the commit identity).
  // Defensive like the logs directory — a failure this early must not
  // depend on any resolution succeeding to be able to say what happened.
  let version: string | null = null;
  try {
    version = app.getVersion();
  } catch {
    version = null;
  }
  void presentStartupFailure(
    {
      ...input,
      build: { version, commit: BUILD_COMMIT, dirty: BUILD_DIRTY },
    },
    {
      openWindow,
      showErrorBox: (title, body) => dialog.showErrorBox(title, body),
      revealLogs: dir => {
        void shell.openPath(dir);
      },
      exit: code => app.exit(code),
    },
  );
}
