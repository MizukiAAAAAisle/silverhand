import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { join, resolve } from 'node:path';
import { startBackend, createFileLogger, type RunningBackend, type FileLogger } from '@silverhand/backend';
import { loadOrCreateServerConfig, databasePath, silverhandDir, writeServerConfig } from './config.js';

let backend: RunningBackend | null = null;
let logger: FileLogger | null = null;
let eventsWindow: BrowserWindow | null = null;

/** Set `SILVERHAND_HEADLESS=1` to boot the backend without a window.
 *  Useful for curl-driven smoke tests and integration scripts — see
 *  `pnpm dev:headless`. The process keeps the backend alive until
 *  SIGINT / SIGTERM. */
const HEADLESS = process.env.SILVERHAND_HEADLESS === '1';

/**
 * Resolve how to spawn the chat-bridge MCP server.
 *
 * Dev: spawn the workspace-local `tsx` binary directly with the raw `.ts`
 *   entry as its only arg. We use an absolute path so the chat-bridge
 *   doesn't depend on the spawn cwd — agent processes have their cwd set
 *   to the channel's workspace_path (e.g. `~/.silverhand/workspaces/foo`),
 *   which is outside this monorepo, so a bare `npx tsx` walking up from
 *   that cwd can't find our locally-installed tsx and silently fails to
 *   launch the MCP server. The result is exactly the kind of "agent runs
 *   tools but never replies" symptom we have to debug from logs.
 *
 *   slock-ai uses `npx <pkg>` because its daemon is npm-installed at an
 *   unpredictable location; we know exactly where tsx lives in dev, so
 *   we resolve once at startup and pass the absolute path.
 *
 * Release: re-use the Electron binary as a node host via
 *   `ELECTRON_RUN_AS_NODE=1` (otherwise spawning `process.execPath`
 *   would re-launch the GUI). Chat-bridge is built to `dist/cli.js` by
 *   `pnpm -r build` (the recursive build pulls in the `chat-bridge`
 *   package's `tsc` script).
 *
 *   NOTE: `app.getAppPath()` in a packaged build resolves to
 *   `<appBundle>/Contents/Resources/app[.asar]`, so the `../..` walk
 *   below currently assumes the chat-bridge package sits at
 *   `Resources/packages/chat-bridge/...`. When packaging is set up
 *   (electron-builder/forge), wire `extraResources` so the chat-bridge
 *   `dist/` lands at that path — or revisit this resolver.
 */
function resolveChatBridgeLauncher(): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  const repoRoot = resolve(app.getAppPath(), '../..');
  if (!app.isPackaged) {
    const tsxBin = join(repoRoot, 'packages/chat-bridge/node_modules/.bin/tsx');
    const entry = join(repoRoot, 'packages/chat-bridge/src/cli.ts');
    return { command: tsxBin, args: [entry] };
  }
  const entry = join(repoRoot, 'packages/chat-bridge/dist/cli.js');
  return {
    command: process.execPath,
    args: [entry],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

async function bootstrap(): Promise<void> {
  try {
    const config = await loadOrCreateServerConfig();
    logger = createFileLogger({
      dir: join(silverhandDir(), 'logs'),
      alsoConsole: !app.isPackaged,
      base: { app: 'silverhand-desktop' },
    });
    logger.info({ logFile: logger.filePath }, 'logger initialized');
    backend = await startBackend({
      dbPath: databasePath(),
      silverhandDir: silverhandDir(),
      serverConfig: config,
      chatBridgeLauncher: resolveChatBridgeLauncher(),
      logger,
      logDir: join(silverhandDir(), 'logs'),
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

  win.on('ready-to-show', () => win.show());

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
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/events.html`);
  } else {
    win.loadFile(join(__dirname, '../renderer/events.html'));
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

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[])
      : []),
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

app.on('before-quit', async () => {
  if (backend) {
    await backend.close();
    backend = null;
  }
  if (logger) {
    await logger.close();
    logger = null;
  }
});
