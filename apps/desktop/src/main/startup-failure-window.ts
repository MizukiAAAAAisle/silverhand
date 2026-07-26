/**
 * The startup failure exit — the only thing a fail-closed launch shows.
 *
 * Before this existed, `bootstrap()` logged and rethrew into an
 * un-`.catch`ed `app.whenReady().then(…)`: double-clicking a build whose
 * layout migration or server profile was refused did nothing visible at
 * all. Every refusal is deliberate and recoverable, but only if the user
 * is told which layer refused and where the evidence is.
 *
 * Deliberate shape:
 *   - **Its own minimal window.** The main shell renderer assumes a
 *     backend handle, IPC handlers, and a session; none of that exists
 *     on this path, so the exit renders self-contained HTML in a fresh
 *     `BrowserWindow` (no preload, no bundle, sandboxed) instead of
 *     routing a failure state through the app UI.
 *   - **Three facts, in this order:** which layer failed · whether the
 *     data was touched · where the logs are. The code and log path are
 *     selectable text because the next step is usually pasting them.
 *   - **`Reveal Logs` + `Quit`, no Retry.** Nothing here is retryable
 *     in-process: every path that lands here needs a filesystem or
 *     profile repair first, and a Retry button that relaunches into the
 *     same refusal teaches the user that the app is flaky rather than
 *     that something is wrong. Relaunching is the user's own retry.
 *
 * Page → main actions travel as intercepted navigations to an
 * unresolvable origin (no preload script, therefore no `ipcRenderer`).
 * Both the click channel and the window itself are wrapped: if anything
 * about the window fails, the exit degrades to a native error box, never
 * to silence.
 */
import { app, BrowserWindow, dialog, shell } from 'electron';
import type { StartupFailureNotice } from './startup-failure.js';

const ACTION_ORIGIN = 'https://startup-failure.silverhand.invalid';
const REVEAL_LOGS_URL = `${ACTION_ORIGIN}/reveal-logs`;
const QUIT_URL = `${ACTION_ORIGIN}/quit`;
const EXIT_CODE = 1;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function renderHtml(notice: StartupFailureNotice, logsDir: string | null): string {
  const detail = notice.detail
    ? `<p class="detail">${escapeHtml(notice.detail)}</p>`
    : '';
  const data = notice.dataUntouched
    ? '<p class="data">Your data was not modified.</p>'
    : '';
  const logs = logsDir
    ? `<section class="logs">
        <h2>Logs</h2>
        <p class="path">${escapeHtml(logsDir)}</p>
      </section>`
    : '';
  const revealLogs = logsDir
    ? `<a class="button" href="${REVEAL_LOGS_URL}">Reveal Logs</a>`
    : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
    <title>Silverhand</title>
    <style>
      :root {
        color-scheme: light dark;
        --fg: #1c1c1e;
        --fg-muted: #6b6b70;
        --bg: #f6f6f7;
        --line: rgba(0, 0, 0, 0.12);
        --surface: rgba(0, 0, 0, 0.04);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --fg: #ececf1;
          --fg-muted: #9a9aa1;
          --bg: #1f1f22;
          --line: rgba(255, 255, 255, 0.14);
          --surface: rgba(255, 255, 255, 0.06);
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 20px 22px 18px;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
        color: var(--fg);
        background: var(--bg);
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-height: 100vh;
        user-select: text;
        -webkit-user-select: text;
      }
      h1 {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
      }
      h2 {
        margin: 0 0 2px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--fg-muted);
      }
      p { margin: 0; }
      .code, .path, .detail {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11.5px;
      }
      .code {
        display: inline-block;
        padding: 1px 5px;
        border: 1px solid var(--line);
        background: var(--surface);
        color: var(--fg-muted);
      }
      .detail, .path { color: var(--fg-muted); word-break: break-all; }
      .data { color: var(--fg-muted); }
      section { display: flex; flex-direction: column; gap: 4px; }
      .actions {
        margin-top: auto;
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .button {
        display: inline-flex;
        align-items: center;
        padding: 4px 12px;
        border: 1px solid var(--line);
        border-radius: 5px;
        background: var(--surface);
        color: var(--fg);
        font-size: 12px;
        text-decoration: none;
        user-select: none;
        -webkit-user-select: none;
      }
    </style>
  </head>
  <body>
    <section>
      <h1>Silverhand could not start</h1>
      <p>${escapeHtml(notice.headline)}</p>
      <p><span class="code">${escapeHtml(notice.code)}</span></p>
      ${detail}
    </section>
    ${data}
    ${logs}
    <div class="actions">
      ${revealLogs}
      <a class="button" href="${QUIT_URL}">Quit</a>
    </div>
  </body>
</html>`;
}

function fallbackErrorBox(
  notice: StartupFailureNotice,
  logsDir: string | null,
): void {
  const lines = [notice.headline, notice.code];
  if (notice.detail) lines.push(notice.detail);
  if (notice.dataUntouched) lines.push('Your data was not modified.');
  if (logsDir) lines.push(`Logs: ${logsDir}`);
  dialog.showErrorBox('Silverhand could not start', lines.join('\n\n'));
}

/**
 * Shows the failure exit and takes ownership of the process lifetime:
 * whichever way the window goes away (Quit, close box, ⌘Q), the app
 * exits non-zero. Never throws — a broken window falls back to a native
 * error box, and a broken error box still exits.
 */
export function showStartupFailureWindow(input: {
  notice: StartupFailureNotice;
  logsDir: string | null;
}): void {
  const { notice, logsDir } = input;
  try {
    const win = new BrowserWindow({
      width: 520,
      height: 340,
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

    const act = (url: string): void => {
      if (url.startsWith(REVEAL_LOGS_URL) && logsDir) {
        void shell.openPath(logsDir);
        return;
      }
      if (url.startsWith(QUIT_URL)) app.exit(EXIT_CODE);
    };

    win.webContents.on('will-navigate', (event, url) => {
      // Every navigation in this window is an action, never a page load:
      // the only document is the data URL below.
      event.preventDefault();
      act(url);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      act(url);
      return { action: 'deny' };
    });
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => app.exit(EXIT_CODE));

    void win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        renderHtml(notice, logsDir),
      )}`,
    );
  } catch {
    try {
      fallbackErrorBox(notice, logsDir);
    } finally {
      app.exit(EXIT_CODE);
    }
  }
}
