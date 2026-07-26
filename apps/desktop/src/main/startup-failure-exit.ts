/**
 * The startup failure exit — presentation and convergence, with the
 * Electron surface injected.
 *
 * `startup-failure-window.ts` supplies the real window; everything that
 * decides *what the user ends up seeing* lives here so it can be
 * falsified without an Electron runtime. The one invariant worth testing
 * is convergence: **whatever goes wrong, the user is told and the
 * process exits non-zero.** A window whose document never loads is the
 * dangerous case — it leaves an invisible window and the same silence
 * this whole module exists to remove (#task:1641 review, @Cindy) — so
 * the window dependency must reject rather than resolve on a failed
 * load, and that rejection lands on the native error box below.
 *
 * Page → main actions travel as intercepted navigations to an
 * unresolvable origin: the document has no preload, therefore no
 * `ipcRenderer`, therefore no dependency on any IPC surface that may be
 * exactly what failed to come up.
 */
import type { StartupFailureNotice } from './startup-failure.js';

export const STARTUP_FAILURE_ACTION_ORIGIN =
  'https://startup-failure.silverhand.invalid';
export const REVEAL_LOGS_URL = `${STARTUP_FAILURE_ACTION_ORIGIN}/reveal-logs`;
export const QUIT_URL = `${STARTUP_FAILURE_ACTION_ORIGIN}/quit`;
export const STARTUP_FAILURE_EXIT_CODE = 1;
export const STARTUP_FAILURE_TITLE = 'Silverhand could not start';

export interface StartupFailureExitDeps {
  /**
   * Opens the failure window on this document, wires `onAction`, and
   * resolves only once the document is actually on screen. MUST reject —
   * leaving no window behind — if the load fails or never settles.
   */
  openWindow: (input: {
    html: string;
    onAction: (url: string) => void;
  }) => Promise<void>;
  /** Native, renderer-free last resort. */
  showErrorBox: (title: string, body: string) => void;
  revealLogs: (dir: string) => void;
  exit: (code: number) => void;
}

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

/**
 * The whole document: no bundle, no preload, no network — the main shell
 * renderer assumes a backend handle, IPC handlers, and a session, none of
 * which exist on this path.
 *
 * `Reveal Logs` + `Quit`, and deliberately no Retry: every path that
 * lands here needs a filesystem or profile repair first, so an in-process
 * retry can only hit the same refusal and teach the user that the app is
 * flaky. Relaunching is the user's own retry.
 */
export function renderStartupFailureDocument(
  notice: StartupFailureNotice,
  logsDir: string | null,
): string {
  const detail = notice.detail
    ? `<p class="detail">${escapeHtml(notice.detail)}</p>`
    : '';
  const logs = logsDir
    ? `<section>
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
      h1 { margin: 0; font-size: 15px; font-weight: 600; }
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
      <h1>${escapeHtml(STARTUP_FAILURE_TITLE)}</h1>
      <p>${escapeHtml(notice.headline)}</p>
      <p><span class="code">${escapeHtml(notice.code)}</span></p>
      ${detail}
    </section>
    ${logs}
    <div class="actions">
      ${revealLogs}
      <a class="button" href="${QUIT_URL}">Quit</a>
    </div>
  </body>
</html>`;
}

export function renderStartupFailureErrorBox(
  notice: StartupFailureNotice,
  logsDir: string | null,
): string {
  const lines = [notice.headline, notice.code];
  if (notice.detail) lines.push(notice.detail);
  if (logsDir) lines.push(`Logs: ${logsDir}`);
  return lines.join('\n\n');
}

/**
 * Shows the failure exit. Resolving means the window owns the process
 * lifetime from here (its close handler exits); any failure to get that
 * window on screen degrades to a native error box and exits immediately.
 * Never throws.
 */
export async function presentStartupFailure(
  input: { notice: StartupFailureNotice; logsDir: string | null },
  deps: StartupFailureExitDeps,
): Promise<void> {
  const { notice, logsDir } = input;
  const onAction = (url: string): void => {
    if (url.startsWith(REVEAL_LOGS_URL)) {
      if (logsDir) deps.revealLogs(logsDir);
      return;
    }
    if (url.startsWith(QUIT_URL)) deps.exit(STARTUP_FAILURE_EXIT_CODE);
  };
  try {
    await deps.openWindow({
      html: renderStartupFailureDocument(notice, logsDir),
      onAction,
    });
  } catch {
    try {
      deps.showErrorBox(
        STARTUP_FAILURE_TITLE,
        renderStartupFailureErrorBox(notice, logsDir),
      );
    } finally {
      deps.exit(STARTUP_FAILURE_EXIT_CODE);
    }
  }
}
