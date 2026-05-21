import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell, type MenuItemConstructorOptions } from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isSafeOpenExtension } from '@silverhand/shared';
import { startBackend, createCategorizedLoggers, type CategorizedLoggers, type RunningBackend, type FileLogger } from '@silverhand/backend';
import { HostClient, spawnDaemonChild, type DaemonHandle } from '@silverhand/host';
import { loadOrCreateServerConfig, databasePath, silverhandDir, writeServerConfig } from './config.js';

let backend: RunningBackend | null = null;
let daemon: DaemonHandle | null = null;
let hostClient: HostClient | null = null;
let logger: FileLogger | null = null;
let loggers: CategorizedLoggers | null = null;
let mainWindow: BrowserWindow | null = null;
let eventsWindow: BrowserWindow | null = null;
let activeConversation: ActiveConversationInfo = { workspaceId: null, conversationId: null };

/** Set `SILVERHAND_HEADLESS=1` to boot the backend without a window.
 *  Useful for curl-driven smoke tests and integration scripts — see
 *  `pnpm dev:headless`. The process keeps the backend alive until
 *  SIGINT / SIGTERM. */
const HEADLESS = process.env.SILVERHAND_HEADLESS === '1';

interface DevRemoteDebuggingConfig {
  enabled: boolean;
  port: number | null;
  reason?: string;
}

const devRemoteDebugging = configureDevRemoteDebugging();

interface ActiveConversationInfo {
  workspaceId: string | null;
  conversationId: string | null;
}

/**
 * In `pnpm dev`, expose Electron's renderer targets over CDP so browser
 * DevTools / VS Code can inspect Network, WS frames, console, and React state
 * without relying on the in-window DevTools UI.
 */
function configureDevRemoteDebugging(): DevRemoteDebuggingConfig {
  if (app.isPackaged) return { enabled: false, port: null, reason: 'packaged' };
  if (!process.env['ELECTRON_RENDERER_URL']) {
    return { enabled: false, port: null, reason: 'no_renderer_dev_server' };
  }

  const raw =
    process.env.SILVERHAND_CDP_PORT ??
    process.env.SILVERHAND_REMOTE_DEBUGGING_PORT ??
    '9222';
  const value = raw.trim();
  if (/^(0|false|off|disabled)$/i.test(value)) {
    return { enabled: false, port: null, reason: 'disabled_by_env' };
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.warn(
      `[main] invalid SILVERHAND_CDP_PORT/SILVERHAND_REMOTE_DEBUGGING_PORT=${JSON.stringify(raw)}; CDP remote debugging disabled`,
    );
    return { enabled: false, port: null, reason: 'invalid_port' };
  }

  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(port));
  return { enabled: true, port };
}

/**
 * macOS: when launched from Finder/Dock, GUI apps inherit launchd's
 * minimal default PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — they do NOT
 * see the PATH from `~/.zshrc` / `config.fish`. That means binaries the
 * user installed via brew (`/opt/homebrew/bin`), nvm, or `npm i -g`
 * (`~/.npm-global/bin`) are invisible, and `detectRuntimes` reports
 * "claude / codex not installed" even though they're on the user's
 * shell PATH.
 *
 * Fix: ask the user's login shell what its PATH actually is, and copy
 * that into `process.env.PATH`. Same trick Slack / Cursor / VS Code use
 * (cf. the `fix-path` package — inlined here to avoid a new dep).
 *
 * Only runs when packaged + macOS; in `pnpm dev` we already inherit
 * the terminal's PATH so this would be wasted work (and could conflict
 * if the dev shell has a different PATH than the user's login shell).
 */
function patchPathFromLoginShell(): { ok: boolean; detail: string } {
  if (!app.isPackaged || process.platform !== 'darwin') {
    return { ok: false, detail: 'skipped (not packaged darwin)' };
  }
  const userShell = process.env.SHELL || '/bin/zsh';
  try {
    // `-i -l -c`: interactive + login so rc/profile files run. Use
    // `printenv` (a real binary, not a shell builtin) instead of
    // `echo $PATH` so the probe stays shell-agnostic — bash/zsh use
    // `${PATH}` while fish needs `{$PATH}`, and we don't want to
    // branch per shell. Sentinel markers protect us from rc-file
    // banner output (oh-my-zsh, fish greetings, etc.).
    const out = execFileSync(
      userShell,
      ['-ilc', 'echo __PATH_BEGIN__; printenv PATH; echo __PATH_END__'],
      { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const m = out.match(/__PATH_BEGIN__\s*\n([\s\S]*?)\n\s*__PATH_END__/);
    if (!m || !m[1]) {
      return {
        ok: false,
        detail: `no marker match (shell=${userShell}, raw=${JSON.stringify(out.slice(0, 200))})`,
      };
    }
    process.env.PATH = m[1].trim();
    return { ok: true, detail: `shell=${userShell}, len=${process.env.PATH.length}` };
  } catch (err) {
    return {
      ok: false,
      detail: `shell=${userShell}, threw=${(err as Error).message}`,
    };
  }
}

/**
 * Resolve how to launch the `silverhand` CLI exposed to agents on PATH.
 *
 * ConversationManager writes a per-spawn `bin/silverhand` shim that forwards
 * here. In both dev and release we reuse the Electron binary as a Node host
 * via `ELECTRON_RUN_AS_NODE=1`; the only difference is where the esbuild
 * bundle lives on disk. The release copy is renamed to `.mjs` so Node treats
 * it as ESM without a sibling `package.json` type=module (dev works as-is
 * because `packages/cli/package.json` provides that). We used to ship a
 * bun-compiled single-file binary in release — that pulled in the Bun
 * runtime (~60MB) for no benefit, because the package already contains a
 * full Node runtime inside Electron.
 */
function resolveSilverhandCliLauncher(): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  const entry = app.isPackaged
    ? join(process.resourcesPath, 'silverhand-cli', 'cli.mjs')
    : join(resolve(app.getAppPath(), '../..'), 'packages/cli/dist/cli.js');
  return {
    command: process.execPath,
    args: [entry],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/**
 * Resolve how to launch the `silverhand-daemon` child process from
 * Electron main. Mirrors `resolveSilverhandCliLauncher` — same trick:
 *
 *  - dev: the daemon entry runs via tsx (installed in
 *    `packages/host/node_modules/.bin/tsx`); we launch it through the
 *    same Electron-as-Node host so `process.execPath` stays the
 *    single canonical Node interpreter for everything we spawn.
 *  - release: the daemon is bundled to `dist/daemon.mjs` and shipped
 *    next to `silverhand-cli/cli.mjs` under `resourcesPath`.
 *
 * PR-1 dev path: we just point at `packages/host/dist/daemon.js`
 * produced by the host's `build` script. Devs run `pnpm --filter
 * @silverhand/host build` once; subsequent `pnpm dev` cycles pick up
 * the bundle. (Wiring this into `scripts/dev.sh` so it's automatic is
 * a follow-up; see TODO at the bottom of this file.)
 */
function resolveDaemonLauncher(): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  const entry = app.isPackaged
    ? join(process.resourcesPath, 'silverhand-daemon', 'daemon.mjs')
    : join(resolve(app.getAppPath(), '../..'), 'packages/host/dist/daemon.js');
  return {
    command: process.execPath,
    args: [entry],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

interface DaemonPaths {
  socketPath: string;
  pidFilePath: string;
  logDir: string;
}

function daemonPaths(): DaemonPaths {
  // All daemon runtime artifacts live under `<silverhand-dir>/run/` so
  // the user can rm -rf the whole thing if their machine ever ends up
  // in a weird state. Logs share the existing `logs/` directory the
  // file logger already writes to.
  const runDir = join(silverhandDir(), 'run');
  return {
    socketPath: join(runDir, 'daemon.sock'),
    pidFilePath: join(runDir, 'daemon.pid'),
    logDir: join(silverhandDir(), 'logs'),
  };
}

async function bootstrap(): Promise<void> {
  try {
    const pathResult = patchPathFromLoginShell();
    const config = await loadOrCreateServerConfig();
    loggers = createCategorizedLoggers({
      dir: join(silverhandDir(), 'logs'),
      alsoConsole: !app.isPackaged,
      base: { app: 'silverhand-desktop' },
    });
    // Historical `logger` is just an alias for the system sink so we
    // don't double-create a `backend-<utc>.log` file.
    logger = loggers.system as FileLogger;
    logger.info(
      {
        logFile: logger.filePath,
        agentLogFile: loggers.agent.filePath,
        cliLogFile: loggers.cli.filePath,
        path: process.env.PATH,
        pathPatch: pathResult,
      },
      'logger initialized',
    );
    if (devRemoteDebugging.enabled) {
      logger.info(
        {
          port: devRemoteDebugging.port,
          url: `http://127.0.0.1:${devRemoteDebugging.port}`,
          env: 'SILVERHAND_CDP_PORT',
        },
        'dev CDP remote debugging enabled',
      );
    }
    // PR-1: spawn the silverhand-daemon child BEFORE backend boots and
    // hand a connected HostClient to startBackend. The daemon is the
    // future home for spawn/inbox/run-state (PR-2); right now it
    // exposes only ping/status/echo. Failure to spawn the daemon must
    // NOT fail the app — backend still boots without it; we log a
    // warning so the operator notices.
    const paths = daemonPaths();
    try {
      daemon = await spawnDaemonChild({
        launcher: resolveDaemonLauncher(),
        socketPath: paths.socketPath,
        pidFilePath: paths.pidFilePath,
        logDir: paths.logDir,
        alsoStderr: !app.isPackaged,
      });
      logger.info(
        {
          pid: daemon.pid,
          socketPath: daemon.socketPath,
          daemonVersion: daemon.daemonVersion,
        },
        'silverhand-daemon spawned',
      );
      hostClient = new HostClient({ socketPath: paths.socketPath });
      try {
        await hostClient.connect();
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'HostClient initial connect failed; continuing without host plumbing',
        );
        await hostClient.close().catch(() => undefined);
        hostClient = null;
      }
      daemon.onExit(info => {
        logger?.error(
          { reason: info.reason, code: info.code },
          'silverhand-daemon exited and exceeded restart budget',
        );
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'failed to spawn silverhand-daemon; backend will boot without host plumbing',
      );
    }
    backend = await startBackend({
      dbPath: databasePath(),
      silverhandDir: silverhandDir(),
      serverConfig: config,
      silverhandCliLauncher: resolveSilverhandCliLauncher(),
      logger,
      loggers: loggers ?? undefined,
      logDir: join(silverhandDir(), 'logs'),
      hostClient: hostClient ?? undefined,
    });
    await writeServerConfig(backend.context.serverConfig);
  } catch (err) {
    console.error('[main] bootstrap failed:', err);
    logger?.error({ err }, 'bootstrap failed');
    throw err;
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // macOS: hide the native title bar so the renderer's <Titlebar/>
    // can draw across the full window width and the channel/workspace
    // info gets the prime real estate. Traffic-lights stay native (we
    // just nudge them to vertically center inside the 36px bar).
    // Win/Linux keep the native frame for now — self-drawn min/max/close
    // is deferred (see docs/app-layout.md §11).
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    trafficLightPosition:
      process.platform === 'darwin' ? { x: 12, y: 11 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  });
  mainWindow = win;

  win.on('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(details => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/**
 * Pop up the dev-only Events window. Single-instance: existing window
 * is focused; closed window is recreated. Cold-start defaults to
 * closed (no persistence) per spec §8.2 — clutter for non-dev users.
 *
 * The window has a standard frame and stays at normal stacking; the
 * "Pin Events Window" menu item flips `setAlwaysOnTop` on top of that.
 */
function showEventsWindow(): void {
  if (eventsWindow && !eventsWindow.isDestroyed()) {
    eventsWindow.show();
    eventsWindow.focus();
    pushActiveConversationToEvents();
    return;
  }
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    title: 'Silverhand Events',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  });
  eventsWindow = win;

  win.on('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (eventsWindow === win) eventsWindow = null;
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL('events.html', process.env['ELECTRON_RENDERER_URL']);
    for (const [key, value] of Object.entries(activeConversationQuery())) {
      url.searchParams.set(key, value);
    }
    win.loadURL(url.toString());
  } else {
    win.loadFile(join(__dirname, '../renderer/events.html'), {
      query: activeConversationQuery(),
    });
  }
}

function activeConversationQuery(): Record<string, string> {
  const query: Record<string, string> = {};
  if (activeConversation.workspaceId) query.workspaceId = activeConversation.workspaceId;
  if (activeConversation.conversationId) query.conversationId = activeConversation.conversationId;
  return query;
}

function pushActiveConversationToEvents(): void {
  const win = eventsWindow;
  if (!win || win.isDestroyed()) return;
  const send = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('active-conversation:update', activeConversation);
    }
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

/**
 * Build a full mac-style application menu. We can't add a single item
 * to the default menu without rebuilding it, so this template covers
 * the standard roles + adds the Developer submenu under View.
 *
 * The Pin item is intentionally always-enabled even when no Events
 * window exists — toggling it then is just a no-op, simpler than
 * rebuilding the menu on window create/destroy.
 */
function buildAppMenu(): Menu {
  const isMac = process.platform === 'darwin';
  const developerSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Show Events Window',
      accelerator: 'Alt+CommandOrControl+E',
      click: () => showEventsWindow(),
    },
  ];

  // macOS convention: "Settings…" lives in the App menu directly under
  // About, with the standard Cmd+, accelerator. Electron's
  // `{ role: 'appMenu' }` shortcut omits Settings, so we hand-build the
  // App submenu here when running on darwin.
  const appMenuItem: MenuItemConstructorOptions = isMac
    ? {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Settings…',
            accelerator: 'CmdOrCtrl+,',
            click: () => openSettings(),
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }
    : { role: 'appMenu' };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenuItem] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Developer', submenu: developerSubmenu },
      ],
    },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

/**
 * Show + focus the main window and tell the renderer to navigate to the
 * Settings page. Triggered by the App menu's "Settings…" item (Cmd+,).
 * If the window was closed (mac-style background app) we recreate it so
 * the shortcut also brings the app back from the dock.
 */
function openSettings(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  const win = mainWindow;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const send = (): void => {
    if (!win.isDestroyed()) win.webContents.send('navigate:settings');
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

ipcMain.handle('backend:info', () => {
  if (!backend) return null;
  return {
    url: backend.url,
    mode: backend.context.serverConfig.mode,
    auth_token: backend.context.serverConfig.auth_token,
  };
});

ipcMain.handle('dialog:pickDirectory', async (event, options?: { defaultPath?: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win ?? undefined!, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: options?.defaultPath,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
});

ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  if (typeof url !== 'string') return;
  // Refuse anything that isn't an http(s) link — preload is a security
  // boundary; agent-rendered content can hand us arbitrary strings.
  if (!/^https?:\/\//i.test(url)) return;
  await shell.openExternal(url);
});

/**
 * Hand an attachment off to the OS default app for that MIME (e.g. open
 * `.html` in the user's browser, `.pdf` in Preview). The renderer
 * fetches the bytes via the authenticated backend route and ships them
 * here over IPC; we write to a per-app temp dir and call
 * `shell.openPath`. macOS resolves the default handler from the
 * extension on disk.
 *
 * Security gate — extension allowlist (`isSafeOpenExtension` in
 * `@silverhand/shared`):
 *   - The attachment system accepts arbitrary files (image, doc,
 *     archive, ...). On macOS, `shell.openPath` goes through Launch
 *     Services, which dispatches on the on-disk extension. A `.command`
 *     would open in Terminal; a `.pkg` in Installer; a `.app` would
 *     launch. None of those are acceptable for "click a chat
 *     attachment to view it".
 *   - We therefore allow only viewer / sandboxed extensions
 *     (html, htm, pdf, txt, log, md, markdown, json, csv, plus image
 *     types). Anything outside that list returns `unsafe_extension` and
 *     the renderer surfaces an error — the user can still download via
 *     a follow-up flow if we add one.
 *   - We deliberately do NOT trust the renderer-supplied MIME as the
 *     primary check: pre-existing attachment rows can carry
 *     `application/octet-stream` from before the MIME contract landed,
 *     so MIME-only gating would either break legitimate `.html` opens
 *     or require a DB backfill.
 *
 * Why not `window.open(blob_url)` in the renderer? Electron's
 * `setWindowOpenHandler` redirects new-window opens to
 * `shell.openExternal`, which can't resolve `blob:` URLs (they're
 * scoped to the renderer process). The result was: clicking any
 * non-image attachment silently did nothing — the symptom that
 * surfaced as the original `.html` bug (`#task:383`).
 *
 * Why not load HTML in a fresh BrowserWindow? Even with sandboxing,
 * keeping untrusted HTML out of any Electron-controlled WebContents is
 * simpler — the OS browser already provides the right sandbox, CSP,
 * and origin isolation. So HTML files leave Electron entirely.
 */
ipcMain.handle(
  'attachment:openExternal',
  async (
    _event,
    input: { filename?: unknown; bytes?: unknown },
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const filenameRaw = input?.filename;
    if (typeof filenameRaw !== 'string' || filenameRaw.length === 0) {
      return { ok: false, reason: 'invalid_filename' };
    }
    const bytesRaw = input?.bytes;
    if (!(bytesRaw instanceof Uint8Array) && !Buffer.isBuffer(bytesRaw)) {
      return { ok: false, reason: 'invalid_payload' };
    }
    const buffer = Buffer.isBuffer(bytesRaw) ? bytesRaw : Buffer.from(bytesRaw);
    if (buffer.length === 0) {
      return { ok: false, reason: 'empty_payload' };
    }
    // Strip path separators / control chars; keep the original
    // extension because that's what the OS uses to pick a handler.
    const safeName = filenameRaw
      .replace(/[\\/]/g, '_')
      .replace(/[\x00-\x1f]+/g, '')
      .trim()
      .slice(0, 255);
    if (!safeName) return { ok: false, reason: 'invalid_filename' };
    // Security gate: refuse extensions that Launch Services would hand
    // to a shell, installer, or runtime. See `isSafeOpenExtension`.
    if (!isSafeOpenExtension(safeName)) {
      return { ok: false, reason: 'unsafe_extension' };
    }
    let dir: string;
    try {
      dir = mkdtempSync(join(tmpdir(), 'silverhand-att-'));
    } catch (err) {
      return {
        ok: false,
        reason: `mkdtemp_failed:${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const fullPath = join(dir, safeName);
    try {
      writeFileSync(fullPath, buffer, { mode: 0o600 });
    } catch (err) {
      return {
        ok: false,
        reason: `write_failed:${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const openErr = await shell.openPath(fullPath);
    if (openErr) {
      return { ok: false, reason: `open_failed:${openErr}` };
    }
    return { ok: true };
  },
);

ipcMain.handle('shell:showItemInFolder', (_event, fullPath: string) => {
  // Reveal a file/dir in Finder/Explorer. Used by the agent profile's
  // "Reveal in Finder" buttons. Path validity is enforced by Electron;
  // an unknown path simply opens the home dir, which is harmless.
  if (typeof fullPath !== 'string' || fullPath.length === 0) return;
  shell.showItemInFolder(fullPath);
});

ipcMain.handle('window:setAlwaysOnTop', (event, pinned: boolean) => {
  // Pin the *sender's* window — works for any future window without
  // hard-wiring a reference here. The Events window uses this to
  // expose Pin as an in-titlebar toggle (see EventsApp).
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.setAlwaysOnTop(!!pinned);
});

ipcMain.handle('active-conversation:set', (_event, next: unknown) => {
  activeConversation = normalizeActiveConversation(next);
  pushActiveConversationToEvents();
});

ipcMain.handle('badge:setCount', (_event, value: unknown) => {
  // macOS dock badge. n=0 clears it; non-finite / negative values are
  // coerced to 0 so a buggy renderer can't paint nonsense on the icon.
  // Renderer drives this from `useMessageUnreadSummary` (sum across
  // workspaces) — no other source feeds the badge.
  const count =
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0;
  app.setBadgeCount(count);
});

ipcMain.handle('notification:show', (_event, opts: unknown) => {
  // Fire a system notification only when no Electron window is focused.
  // `BrowserWindow.getFocusedWindow()` returns null when the app is in
  // the background — more correct than checking mainWindow alone, which
  // would misfire when the Events window or a dialog has focus.
  if (BrowserWindow.getFocusedWindow() !== null) return;
  if (!opts || typeof opts !== 'object') return;
  const { title, body } = opts as Partial<Record<string, unknown>>;
  if (typeof title !== 'string' || typeof body !== 'string') return;
  const n = new Notification({ title, body });
  n.show();
});

function normalizeActiveConversation(value: unknown): ActiveConversationInfo {
  if (!value || typeof value !== 'object') {
    return { workspaceId: null, conversationId: null };
  }
  const v = value as Partial<Record<keyof ActiveConversationInfo, unknown>>;
  return {
    workspaceId: typeof v.workspaceId === 'string' ? v.workspaceId : null,
    conversationId: typeof v.conversationId === 'string' ? v.conversationId : null,
  };
}

app.whenReady().then(async () => {
  await bootstrap();
  if (HEADLESS) {
    // One-line machine-readable handshake on stdout. Test scripts pipe
    // and JSON.parse this. Human-readable extras go to stderr below.
    process.stdout.write(
      JSON.stringify({
        url: backend!.url,
        port: backend!.port,
        auth_token: backend!.context.serverConfig.auth_token,
        silverhand_dir: silverhandDir(),
      }) + '\n',
    );
    console.error('[main] headless backend ready — Ctrl-C to stop');
    return;
  }
  Menu.setApplicationMenu(buildAppMenu());
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // In headless mode there are no windows to begin with — that signal
  // would quit the app immediately. Keep alive until SIGINT.
  if (HEADLESS) return;
  if (process.platform !== 'darwin') app.quit();
});

if (HEADLESS) {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      console.error(`[main] received ${sig}, shutting down`);
      app.quit();
    });
  }
}

// Set true once we've started the async shutdown path so a re-fire of
// `before-quit` (Electron may emit it again after `app.exit`/`app.quit`
// in some platform sequences) doesn't restart the work or loop.
let isShuttingDown = false;

async function shutdown(): Promise<void> {
  // Notify the renderer so it can show a progress overlay while we
  // clean up — prevents the window from looking frozen.
  const pushProgress = (step: string): void => {
    try {
      mainWindow?.webContents.send('shutdown:progress', step);
    } catch {
      /* window may already be destroyed — ignore */
    }
  };

  try {
    if (backend) {
      pushProgress('正在停止 agents…');
      await backend.close();
      pushProgress('清理完成');
      backend = null;
    }
  } catch (err) {
    console.error('[main] backend.close() failed:', err);
  }
  try {
    // Tear down host plumbing AFTER backend so any final pings during
    // shutdown have something to talk to. HostClient first (drops the
    // socket cleanly so daemon doesn't log a "peer error"); then
    // daemon (SIGTERM → graceful drain → SIGKILL fallback).
    if (hostClient) {
      await hostClient.close().catch(() => undefined);
      hostClient = null;
    }
    if (daemon) {
      await daemon.kill({ gracefulMs: 5_000 }).catch(() => undefined);
      daemon = null;
    }
  } catch (err) {
    console.error('[main] host shutdown failed:', err);
  }
  try {
    // `logger` is just an alias for `loggers.system`; close it via the
    // categorized triple to avoid double-close.
    if (loggers) {
      await Promise.allSettled([
        loggers.system.close(),
        loggers.agent.close(),
        loggers.cli.close(),
      ]);
      loggers = null;
      logger = null;
    } else if (logger) {
      await logger.close();
      logger = null;
    }
  } catch (err) {
    console.error('[main] logger.close() failed:', err);
  }
}

app.on('before-quit', event => {
  // Async work in `before-quit` is silently dropped by Electron unless
  // we preventDefault and re-quit ourselves: the handler's returned
  // Promise is NOT awaited by the quit sequence, so without this guard
  // the main process exits while `backend.close()` is still running and
  // every spawned agent child is left orphaned. We saw this in practice —
  // claude/codex processes survived an app close, then the next launch
  // spawned duplicates and codex's
  // resume failed with `thread not found` because the orphan still
  // owned the thread server-side.
  if (isShuttingDown) return;
  event.preventDefault();
  isShuttingDown = true;

  // Clear the dock badge synchronously before any async shutdown work —
  // otherwise a stale unread number lingers on the dock icon for the
  // ~10s the shutdown takes, which looks like the app is still alive
  // with new messages waiting.
  app.setBadgeCount(0);

  // Hard ceiling so a wedged shutdown can't hang the app forever.
  // Two sequential budgets share this window:
  //
  //   1. `backend.close()` — `ConversationManager.stop` escalates to
  //      SIGKILL after 10s. Add a couple of seconds of headroom for
  //      activity log flush + HTTP drain + DB close.
  //   2. `daemon.kill({ gracefulMs: 5_000 })` — daemon gets 5s of
  //      SIGTERM before SIGKILL.
  //
  // 10s (CM) + 5s (daemon) + 10s safety margin = 25s. The previous
  // 15s ceiling barely covered the CM stage alone; adding daemon
  // shutdown after it would race the watchdog and cause `app.exit(1)`
  // before the daemon released its pid file / socket, leaving stale
  // state for the next launch. See review of #task:510 PR-1.
  const watchdog = setTimeout(() => {
    console.error('[main] shutdown watchdog fired; forcing exit');
    app.exit(1);
  }, 25_000);
  watchdog.unref();

  void shutdown().finally(() => {
    clearTimeout(watchdog);
    // app.exit (not app.quit) — we've already done the cleanup; quit()
    // would re-fire before-quit and loop through this handler.
    app.exit(0);
  });
});
