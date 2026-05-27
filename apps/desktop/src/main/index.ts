import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, session as electronSession, shell, type MenuItemConstructorOptions } from 'electron';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AuthSessionResponseSchema,
  EMBEDDED_BOOTSTRAP_FILENAME,
  EVENT_WS_SESSION_COOKIE,
  HostClaimOrCreateResponseSchema,
  HostRevokeResponseSchema,
  HostRotateTokenEmbeddedResponseSchema,
  ServerInfoSchema,
  UserDtoSchema,
  X_SILVERHAND_LEGACY_USER_ID_HEADER,
  X_SILVERHAND_PRINCIPAL_HEADER,
  apiPaths,
  authPaths,
  isSafeOpenExtension,
  type AuthLoginInput,
  type AuthSignupInput,
  type HostDto,
  type ServerInfo,
  type UserDto,
} from '@silverhand/shared';
import {
  createCategorizedLoggers,
  startEmbeddedSilverhandServer,
  type CategorizedLoggers,
  type RunningBackend,
  type FileLogger,
} from '@silverhand/server';
import { HostClient, spawnDaemonChild, type DaemonHandle } from '@silverhand/host';
import { loadOrCreateServerConfig, silverhandDir, writeServerConfig } from './config.js';
import { waitForDaemonGeneration } from './daemon-generation-attach.js';
import { applyFatalExitToClaim } from './local-host-failure.js';
import {
  buildHostClaimInput,
  loadOrCreateInstallationId,
  daemonHostConfigPath,
  readDaemonHostConfig,
  removeDaemonHostConfig,
  applyRotateSideEffects,
  applyRevokeSideEffects,
  assertApiProxyPath,
  writeDaemonHostConfig,
  type LocalHostClaimStatus,
} from './local-host-claim.js';
import {
  startAttachWatchdog,
  type ExpectedAttachWindow,
} from './outbound-attach.js';
import { gracefullyDetachOutbound } from './outbound-detach.js';

let backend: RunningBackend | null = null;
let daemon: DaemonHandle | null = null;
let hostClient: HostClient | null = null;
let logger: FileLogger | null = null;
let loggers: CategorizedLoggers | null = null;
let mainWindow: BrowserWindow | null = null;
let eventsWindow: BrowserWindow | null = null;
let activeConversation: ActiveConversationInfo = { workspaceId: null, conversationId: null };
let userSessionToken: string | null = null;
let userSessionUser: UserDto | null = null;
let localHostClaim: LocalHostClaimStatus = { status: 'unclaimed', hostId: null };

/** Set `SILVERHAND_HEADLESS=1` to boot the backend without a window.
 *  Useful for curl-driven smoke tests and integration scripts — see
 *  `pnpm dev:headless`. The process keeps the backend alive until
 *  SIGINT / SIGTERM. */
const HEADLESS = process.env.SILVERHAND_HEADLESS === '1';

interface RemoteDebuggingConfig {
  enabled: boolean;
  port: number | null;
  reason?: string;
  envName?: string;
}

const remoteDebugging = configureRemoteDebugging();

interface ActiveConversationInfo {
  workspaceId: string | null;
  conversationId: string | null;
}

type DesktopAuthState =
  | { status: 'authenticated'; signup_enabled: boolean; user: UserDto }
  | { status: 'unauthenticated'; signup_enabled: boolean };

interface BackendProxyRequest {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  bodyText?: string;
  responseType?: 'text' | 'arrayBuffer';
}

interface BackendProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyBytes?: Uint8Array;
}

interface BackendUploadField {
  name: string;
  value: string;
}

interface BackendUploadFile {
  fieldName: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

interface BackendUploadRequest {
  path: string;
  fields?: BackendUploadField[];
  files: BackendUploadFile[];
}

type DesktopAuthResult =
  | { ok: true; user: UserDto }
  | { ok: false; status: number; statusText: string; bodyText: string };

/**
 * Expose Electron's renderer targets over local-only CDP.
 *
 * Dev mode keeps the historical default of 9222 when the renderer dev server
 * is active. Packaged builds are opt-in only: set
 * `SILVERHAND_REMOTE_DEBUG_PORT=<port>` to open the endpoint for profiling.
 */
function configureRemoteDebugging(): RemoteDebuggingConfig {
  const explicit = readRemoteDebugPortEnv();
  const hasRendererDevServer = Boolean(process.env['ELECTRON_RENDERER_URL']);
  if (!explicit && app.isPackaged) {
    return { enabled: false, port: null, reason: 'packaged_env_absent' };
  }
  if (!explicit && !hasRendererDevServer) {
    return { enabled: false, port: null, reason: 'no_renderer_dev_server' };
  }

  const raw = explicit?.value ?? '9222';
  const value = raw.trim();
  if (/^(0|false|off|disabled)$/i.test(value)) {
    return {
      enabled: false,
      port: null,
      reason: 'disabled_by_env',
      envName: explicit?.name,
    };
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.warn(
      `[main] invalid ${explicit?.name ?? 'default CDP port'}=${JSON.stringify(raw)}; CDP remote debugging disabled`,
    );
    return {
      enabled: false,
      port: null,
      reason: 'invalid_port',
      envName: explicit?.name,
    };
  }

  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(port));
  process.stderr.write(`[silverhand] remote debugging on 127.0.0.1:${port}\n`);
  return { enabled: true, port, envName: explicit?.name };
}

function readRemoteDebugPortEnv(): { name: string; value: string } | null {
  const candidates = [
    'SILVERHAND_REMOTE_DEBUG_PORT',
    'SILVERHAND_CDP_PORT',
    'SILVERHAND_REMOTE_DEBUGGING_PORT',
  ] as const;
  for (const name of candidates) {
    const value = process.env[name];
    if (value !== undefined) return { name, value };
  }
  return null;
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
  hostConfigPath: string;
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
    hostConfigPath: daemonHostConfigPath(silverhandDir()),
  };
}

function desktopSessionPath(): string {
  return join(silverhandDir(), 'desktop', 'session.bin');
}

function embeddedBootstrapPath(): string {
  return join(silverhandDir(), EMBEDDED_BOOTSTRAP_FILENAME);
}

function requireBackend(): RunningBackend {
  if (!backend) throw new Error('backend not ready');
  return backend;
}

function backendUrl(path: string): string {
  return new URL(path, requireBackend().url).toString();
}

function eventWsCookieUrl(): string {
  return new URL(apiPaths.eventWebSocket, requireBackend().url).toString();
}

function backendOrigin(): string {
  return new URL(requireBackend().url).origin;
}

async function syncEventWsSessionCookie(token: string | null): Promise<void> {
  if (!backend) return;
  const url = eventWsCookieUrl();
  await electronSession.defaultSession.cookies
    .remove(url, EVENT_WS_SESSION_COOKIE)
    .catch(err => {
      logger?.warn({ err }, 'failed to clear event websocket session cookie');
    });
  if (!token) return;
  await electronSession.defaultSession.cookies
    .set({
      url,
      name: EVENT_WS_SESSION_COOKIE,
      value: token,
      httpOnly: true,
      sameSite: 'strict',
      secure: new URL(requireBackend().url).protocol === 'https:',
      path: apiPaths.eventWebSocket,
    })
    .catch(err => {
      logger?.warn({ err }, 'failed to set event websocket session cookie');
    });
}

function installEventWsOriginOverride(): void {
  const running = backend;
  if (!running) return;
  const expectedOrigin = backendOrigin();
  const expectedUrl = new URL(apiPaths.eventWebSocket, running.url);
  expectedUrl.protocol = expectedUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  electronSession.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${expectedUrl.protocol}//${expectedUrl.host}${apiPaths.eventWebSocket}`] },
    (details, callback) => {
      const url = new URL(details.url);
      if (url.origin === expectedUrl.origin && url.pathname === apiPaths.eventWebSocket) {
        delete details.requestHeaders.origin;
        delete details.requestHeaders.cookie;
        details.requestHeaders.Origin = expectedOrigin;
        if (userSessionToken) {
          details.requestHeaders.Cookie =
            `${EVENT_WS_SESSION_COOKIE}=${encodeURIComponent(userSessionToken)}`;
        } else {
          delete details.requestHeaders.Cookie;
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    },
  );
}

function clearPersistedUserSession(): void {
  try {
    unlinkSync(desktopSessionPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger?.warn({ err }, 'failed to remove desktop auth session blob');
    }
  }
}

function loadPersistedUserSessionToken(): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    logger?.warn('desktop auth session storage unavailable; encrypted session restore disabled');
    return null;
  }
  const path = desktopSessionPath();
  if (!existsSync(path)) return null;
  try {
    const token = safeStorage.decryptString(readFileSync(path)).trim();
    return token.length > 0 ? token : null;
  } catch (err) {
    logger?.warn({ err }, 'failed to decrypt desktop auth session; clearing blob');
    clearPersistedUserSession();
    return null;
  }
}

function persistUserSessionToken(token: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    logger?.warn('desktop auth session storage unavailable; keeping token in memory only');
    return;
  }
  const path = desktopSessionPath();
  mkdirSync(join(silverhandDir(), 'desktop'), { recursive: true });
  writeFileSync(path, safeStorage.encryptString(token), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch (err) {
    logger?.warn({ err }, 'failed to chmod desktop auth session blob');
  }
}

async function storeUserSession(token: string, user: UserDto): Promise<void> {
  userSessionToken = token;
  userSessionUser = user;
  persistUserSessionToken(token);
  await syncEventWsSessionCookie(token);
}

async function clearUserSession(): Promise<void> {
  userSessionToken = null;
  userSessionUser = null;
  localHostClaim = { status: 'unclaimed', hostId: null };
  // D3.a Commit 4: any in-flight attach watchdog targets the session
  // we're about to drop. Abort it so the polling timer doesn't outlive
  // the credential it was meant to verify.
  activeAttachWatchdog?.abort();
  activeAttachWatchdog = null;
  clearPersistedUserSession();
  await syncEventWsSessionCookie(null);
  try {
    removeDaemonHostConfig(silverhandDir());
  } catch (err) {
    logger?.warn({ err }, 'failed to remove daemon host config');
  }
}

async function clearUserSessionAfterUnauthorized(source: string): Promise<void> {
  if (!userSessionToken && !userSessionUser) return;
  logger?.warn({ source }, 'desktop auth session rejected; clearing local session');
  await clearUserSession();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function fetchServerInfo(): Promise<ServerInfo> {
  const res = await fetch(backendUrl(apiPaths.serverInfo));
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  const parsed = ServerInfoSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    throw new Error(`invalid server info response: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function validateUserSessionToken(token: string): Promise<UserDto | null> {
  const res = await fetch(backendUrl(apiPaths.me), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const parsed = UserDtoSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

async function hydrateDesktopSession(): Promise<boolean> {
  const token = loadPersistedUserSessionToken();
  if (!token) return false;
  const user = await validateUserSessionToken(token).catch(err => {
    logger?.warn({ err }, 'failed to validate persisted desktop auth session');
    return null;
  });
  if (!user) {
    await clearUserSession();
    return false;
  }
  await storeUserSession(token, user);
  await claimLocalHostForUserSession();
  return true;
}

async function desktopAuthState(): Promise<DesktopAuthState> {
  const info = await fetchServerInfo();
  if (userSessionToken && userSessionUser) {
    return {
      status: 'authenticated',
      signup_enabled: info.signup_enabled,
      user: userSessionUser,
    };
  }
  return { status: 'unauthenticated', signup_enabled: info.signup_enabled };
}

async function postAuthSession(
  path: typeof authPaths.signup | typeof authPaths.login,
  input: AuthSignupInput | AuthLoginInput,
): Promise<DesktopAuthResult> {
  const res = await fetch(backendUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      statusText: res.statusText,
      bodyText: text,
    };
  }
  const parsed = AuthSessionResponseSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    return {
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      bodyText: JSON.stringify({ error: 'invalid auth response' }),
    };
  }
  await storeUserSession(parsed.data.user_token, parsed.data.user);
  await claimLocalHostForUserSession();
  return { ok: true, user: parsed.data.user };
}

async function bootstrapEmbeddedUserSession(): Promise<boolean> {
  if (requireBackend().context.serverConfig.mode !== 'embedded') return false;
  const path = embeddedBootstrapPath();
  if (!existsSync(path)) return false;
  const token = readFileSync(path, 'utf8').trim();
  if (!token) return false;
  const res = await fetch(backendUrl(authPaths.embeddedBootstrap), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const text = await res.text();
  if (!res.ok) {
    logger?.warn(
      { status: res.status, statusText: res.statusText },
      'embedded bootstrap session request failed',
    );
    return false;
  }
  const parsed = AuthSessionResponseSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    logger?.warn(
      { err: parsed.error.message },
      'embedded bootstrap returned invalid auth response',
    );
    return false;
  }
  await storeUserSession(parsed.data.user_token, parsed.data.user);
  await claimLocalHostForUserSession();
  return true;
}

async function claimLocalHostForUserSession(): Promise<void> {
  const token = userSessionToken;
  const running = backend;
  if (!token || !running) {
    localHostClaim = { status: 'unclaimed', hostId: null };
    return;
  }

  const dir = silverhandDir();
  const existingConfig = readDaemonHostConfig(dir);
  try {
    const installationId = loadOrCreateInstallationId(dir);
    const claimInput = buildHostClaimInput({
      installationId,
      existingConfig,
    });
    const res = await fetch(backendUrl(apiPaths.hostClaimOrCreate), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(claimInput),
    });
    const text = await res.text();

    if (res.status === 401) {
      await clearUserSessionAfterUnauthorized('local host claim');
      return;
    }
    if (res.status === 409) {
      localHostClaim = {
        status: 'revoked',
        hostId: existingConfig?.host_id ?? null,
      };
      logger?.warn('local host claim failed: host revoked');
      return;
    }
    if (!res.ok) {
      throw new Error(`local host claim failed: ${res.status} ${res.statusText}`);
    }

    const parsed = HostClaimOrCreateResponseSchema.safeParse(parseJson(text));
    if (!parsed.success) {
      throw new Error(`invalid local host claim response: ${parsed.error.message}`);
    }

    const hostToken =
      parsed.data.host_token ??
      (existingConfig?.host_id === parsed.data.host_id
        ? existingConfig.host_token
        : null);
    if (!hostToken) {
      throw new Error('local host claim response omitted host_token without reusable config');
    }

    // D3.a Commit 4: capture freshness window BEFORE writing the
    // config + firing the IPC. The daemon may attach the outbound WS
    // before its `host_outbound_attach` ack returns to main, so an
    // "after-ack" lower bound would exclude the very attach we want.
    // See `outbound-attach.ts` for the full freshness contract.
    const localHostId = parsed.data.host_id;
    const attachWindow = captureAttachWindow(localHostId);

    writeDaemonHostConfig(dir, {
      server_url: running.url,
      host_id: localHostId,
      host_token: hostToken,
    });
    localHostClaim = { status: 'claimed', hostId: localHostId };

    // Fire-and-forget: the claim itself has succeeded; the outbound
    // attach is a parallel control-plane action. UI keeps showing
    // `connecting` until the watchdog observes a fresh attachment;
    // attach failures stay diagnostic and do NOT mutate the
    // user-facing `local_host_status` enum.
    void triggerLocalHostOutboundAttach({
      localHostId,
      configPath: daemonHostConfigPath(dir),
      attachWindow,
    });
  } catch (err) {
    localHostClaim = {
      status: 'error',
      hostId: existingConfig?.host_id ?? localHostClaim.hostId,
    };
    logger?.warn({ err }, 'local host claim failed');
  }
}

async function logoutUserSession(): Promise<{ ok: true }> {
  const token = userSessionToken;
  await clearUserSession();
  if (token) {
    await fetch(backendUrl(authPaths.logout), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(err => {
      logger?.warn({ err }, 'desktop auth logout revoke failed');
    });
  }
  return { ok: true };
}

/** Renderer-facing return shape for `hosts:rotate` / `hosts:revoke`.
 *  Deliberately omits `host_token` — main always strips it before
 *  the IPC reply so it never crosses the renderer boundary. The
 *  `local_host_*` fields mirror `BackendInfo` so the renderer can
 *  refresh in one round-trip. */
type DesktopHostMutationResult =
  | {
      ok: true;
      host: HostDto;
      local_host_id: string | null;
      local_host_status: LocalHostClaimStatus['status'];
      local_host_ws_attached_at: number | null;
    }
  | {
      ok: false;
      code:
        | 'unauthorized'
        | 'not_current_host'
        | 'host_not_found'
        | 'host_revoked'
        | 'kind_not_supported'
        | 'invalid_response'
        | 'network_error';
      message?: string;
    };

function snapshotLocalHostInfo(): {
  local_host_id: string | null;
  local_host_status: LocalHostClaimStatus['status'];
  local_host_ws_attached_at: number | null;
} {
  return {
    local_host_id:
      localHostClaim.status === 'claimed' ? localHostClaim.hostId : null,
    local_host_status: localHostClaim.status,
    // D3.a Commit 4: diagnostic-only field. The renderer can display
    // "connected since" but MUST NOT use this to derive a new status
    // word — the user-facing status enum is the 5-value
    // `local_host_status` and nothing else (per the D3.a/D3.d locked
    // scope on host status semantics).
    local_host_ws_attached_at:
      localHostClaim.status === 'claimed'
        ? backend?.context.hostWsController?.()?.getAttachment(localHostClaim.hostId)?.attachedAt ?? null
        : null,
  };
}

/**
 * D3.a Commit 4 — snapshot the freshness window BEFORE writing
 * `daemon-config.json` and firing the `host_outbound_attach` IPC.
 * See `outbound-attach.ts` for the full freshness contract: the
 * daemon may attach the outbound WS before its IPC ack returns,
 * which is exactly why the lower bound has to be captured here
 * (pre-IPC) rather than after `await`.
 */
function captureAttachWindow(localHostId: string): ExpectedAttachWindow {
  const controller = backend?.context.hostWsController?.() ?? null;
  const prev = controller?.getAttachment(localHostId) ?? null;
  return {
    expectedHostId: localHostId,
    previousConnectionId: prev?.connectionId ?? null,
    expectAttachSince: Date.now(),
  };
}

/** Aborts the active attach watchdog, if any, so logout / app quit
 *  doesn't leak a polling timer past its useful life. */
let activeAttachWatchdog: { abort(): void } | null = null;

/**
 * D3.a Commit 4 — fire the `host_outbound_attach` IPC and spawn a
 * watchdog that polls the backend's `HostWsServerController` until a
 * fresh attachment for `localHostId` lands (or the timeout budget
 * elapses). All outcomes are diagnostic; nothing here mutates
 * `localHostClaim` or the user-facing status enum.
 *
 * The "fresh" predicate is the load-bearing detail (see
 * `outbound-attach.ts` header). Two non-obvious choices baked in:
 *   - `attachWindow.expectAttachSince` is captured BEFORE the IPC
 *     by the caller (in `captureAttachWindow`), not here, because
 *     the daemon may attach before its IPC ack returns.
 *   - On attach IPC failure we log the typed reason but do NOT
 *     fail the surrounding claim flow — the host row is already
 *     valid server-side; subsequent rotate-token / re-login can
 *     re-attempt the attach.
 */
async function triggerLocalHostOutboundAttach(input: {
  localHostId: string;
  configPath: string;
  attachWindow: ExpectedAttachWindow;
}): Promise<void> {
  const client = hostClient;
  const running = backend;
  if (!client || !running) {
    logger?.warn(
      { localHostId: input.localHostId },
      'D3.a host_outbound_attach skipped — host client or backend not ready',
    );
    return;
  }

  let result;
  try {
    result = await client.hostOutboundAttach({ config_path: input.configPath });
  } catch (err) {
    // Genuine IPC transport error (socket closed, daemon dead). Logs
    // only — D3.b supervisor restart will retry.
    logger?.warn(
      { err, localHostId: input.localHostId },
      'D3.a host_outbound_attach IPC failed (transport)',
    );
    return;
  }

  if (!result.attached) {
    logger?.warn(
      {
        localHostId: input.localHostId,
        reason: result.reason,
        message: result.message,
      },
      'D3.a host_outbound_attach refused by daemon',
    );
    return;
  }

  logger?.info(
    {
      localHostId: input.localHostId,
      action: result.action,
    },
    'D3.a host_outbound_attach ack',
  );

  // Cancel any previously-running watchdog (rotate-token / re-login
  // can fire while a prior one is still polling).
  activeAttachWatchdog?.abort();
  const controller = running.context.hostWsController?.() ?? null;
  if (!controller) {
    // No controller (mode-specific edge); we still acked the IPC, so
    // attach itself is fine — just can't observe it from main.
    return;
  }
  const watchdog = startAttachWatchdog(input.attachWindow, {
    getAttachment: hostId => controller.getAttachment(hostId),
  });
  activeAttachWatchdog = watchdog;
  watchdog.promise
    .then(outcome => {
      if (activeAttachWatchdog === watchdog) activeAttachWatchdog = null;
      if (outcome.ok) {
        logger?.info(
          {
            localHostId: input.localHostId,
            elapsedMs: outcome.elapsedMs,
            attachedAt: outcome.attachment.attachedAt,
            connectionId: outcome.attachment.connectionId,
          },
          'D3.a host outbound WS attached',
        );
      } else if (outcome.reason === 'timeout') {
        logger?.warn(
          { localHostId: input.localHostId, elapsedMs: outcome.elapsedMs },
          'D3.a host outbound WS attach watchdog timed out (UI status stays connecting)',
        );
      }
    })
    .catch(err => {
      logger?.warn({ err }, 'D3.a attach watchdog promise rejected unexpectedly');
    });
}

/** Rotate the long-lived credential for the desktop's CURRENT local
 *  host. Only allowed for `hostId === daemon-config.host_id` (the
 *  source-of-truth for what identity this desktop is currently using).
 *  Mid-flight token bytes never cross the renderer IPC boundary. */
async function rotateHostToken(
  hostId: string,
): Promise<DesktopHostMutationResult> {
  const token = userSessionToken;
  const running = backend;
  if (!token || !running) {
    return { ok: false, code: 'unauthorized' };
  }
  if (!hostId) {
    return { ok: false, code: 'host_not_found', message: 'missing host id' };
  }
  const dir = silverhandDir();
  const existingConfig = readDaemonHostConfig(dir);
  if (!existingConfig || existingConfig.host_id !== hostId) {
    // Stage B.4 hard guard: rotate is only legal for the host this
    // desktop is currently bound to. Rotating any other owned host
    // and writing the returned token to local daemon-config would
    // silently re-bind the daemon to a different host identity.
    // Refuse without contacting the server so we don't leak whether
    // the requested host even exists.
    return {
      ok: false,
      code: 'not_current_host',
      message:
        'rotate is only supported for the host this desktop is currently bound to',
    };
  }

  let res: Response;
  try {
    res = await fetch(backendUrl(apiPaths.hostRotateToken(hostId)), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    logger?.warn({ err }, 'host rotate-token request failed');
    return { ok: false, code: 'network_error' };
  }
  const text = await res.text();
  const body = parseJson(text);
  if (res.status === 401) {
    await clearUserSessionAfterUnauthorized('host rotate');
    return { ok: false, code: 'unauthorized' };
  }
  if (res.status === 404) {
    return { ok: false, code: 'host_not_found' };
  }
  if (res.status === 409) {
    const code =
      typeof body === 'object' && body !== null && 'error_code' in body
        ? String((body as { error_code: unknown }).error_code)
        : 'host_revoked';
    return {
      ok: false,
      code: code === 'kind_not_supported' ? 'kind_not_supported' : 'host_revoked',
    };
  }
  if (!res.ok) {
    return { ok: false, code: 'network_error', message: `${res.status} ${res.statusText}` };
  }

  const parsed = HostRotateTokenEmbeddedResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, code: 'invalid_response' };
  }

  // Token bytes land here and ONLY here. Persist to daemon-config
  // before we return; the renderer reply below has no token.
  applyRotateSideEffects({
    silverhandDir: dir,
    serverUrl: running.url,
    hostId: parsed.data.host_id,
    hostToken: parsed.data.host_token,
  });
  localHostClaim = { status: 'claimed', hostId: parsed.data.host_id };
  return {
    ok: true,
    host: parsed.data.host,
    ...snapshotLocalHostInfo(),
  };
}

/** Revoke a host the user owns. If the revoked host is the desktop's
 *  current local host, also clear `daemon-config.json` and update
 *  `localHostClaim` so subsequent `BackendInfo` reads reflect the
 *  new state. Other owned hosts only update the server; local state
 *  is unchanged. */
async function revokeHost(
  hostId: string,
): Promise<DesktopHostMutationResult> {
  const token = userSessionToken;
  if (!token || !backend) {
    return { ok: false, code: 'unauthorized' };
  }
  if (!hostId) {
    return { ok: false, code: 'host_not_found', message: 'missing host id' };
  }

  let res: Response;
  try {
    res = await fetch(backendUrl(apiPaths.hostRevoke(hostId)), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    logger?.warn({ err }, 'host revoke request failed');
    return { ok: false, code: 'network_error' };
  }
  const text = await res.text();
  const body = parseJson(text);
  if (res.status === 401) {
    await clearUserSessionAfterUnauthorized('host revoke');
    return { ok: false, code: 'unauthorized' };
  }
  if (res.status === 404) {
    return { ok: false, code: 'host_not_found' };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: 'network_error',
      message: `${res.status} ${res.statusText}`,
    };
  }
  const parsed = HostRevokeResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, code: 'invalid_response' };
  }

  // If we just revoked the host this desktop was bound to, drop the
  // local daemon-config and surface `revoked` through the
  // `BackendInfo` IPC so the renderer can prompt the user to log in
  // again (which provisions a fresh active host row under the new
  // active-only partial-unique index).
  const reconcile = applyRevokeSideEffects({ silverhandDir: silverhandDir(), hostId });
  if (reconcile === 'cleared') {
    localHostClaim = { status: 'revoked', hostId };
  }
  return {
    ok: true,
    host: parsed.data.host,
    ...snapshotLocalHostInfo(),
  };
}

function proxyHeaders(input: Record<string, string> | undefined): Headers {
  const headers = new Headers();
  const blocked = new Set([
    'authorization',
    X_SILVERHAND_PRINCIPAL_HEADER.toLowerCase(),
    X_SILVERHAND_LEGACY_USER_ID_HEADER.toLowerCase(),
    'host',
    'content-length',
    'connection',
  ]);
  for (const [name, value] of Object.entries(input ?? {})) {
    const key = name.toLowerCase();
    if (blocked.has(key)) continue;
    headers.set(name, value);
  }
  return headers;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function marshalBackendResponse(
  res: Response,
  responseType: 'text' | 'arrayBuffer',
): Promise<BackendProxyResponse> {
  const base = {
    status: res.status,
    statusText: res.statusText,
    headers: responseHeaders(res.headers),
  };
  if (responseType === 'arrayBuffer' && res.ok) {
    return {
      ...base,
      bodyBytes: new Uint8Array(await res.arrayBuffer()),
    };
  }
  return { ...base, bodyText: await res.text() };
}

async function proxyBackendRequest(
  input: BackendProxyRequest,
): Promise<BackendProxyResponse> {
  assertApiProxyPath(input.path);
  if (!userSessionToken) {
    return {
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({ error: 'unauthorized' }),
    };
  }
  const headers = proxyHeaders(input.headers);
  headers.set('Authorization', `Bearer ${userSessionToken}`);
  if (input.bodyText !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(backendUrl(input.path), {
    method: input.method ?? 'GET',
    headers,
    body: input.bodyText,
  });
  if (res.status === 401) {
    await clearUserSessionAfterUnauthorized('backend request');
  }
  return marshalBackendResponse(res, input.responseType ?? 'text');
}

async function proxyBackendUpload(
  input: BackendUploadRequest,
): Promise<BackendProxyResponse> {
  assertApiProxyPath(input.path);
  if (!userSessionToken) {
    return {
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({ error: 'unauthorized' }),
    };
  }
  const form = new FormData();
  for (const field of input.fields ?? []) {
    form.append(field.name, field.value);
  }
  for (const file of input.files) {
    const bytes = Buffer.from(file.bytes);
    const blob = new Blob([bytes], {
      type: file.contentType || 'application/octet-stream',
    });
    form.append(file.fieldName, blob, file.filename);
  }
  const res = await fetch(backendUrl(input.path), {
    method: 'POST',
    headers: { Authorization: `Bearer ${userSessionToken}` },
    body: form,
  });
  if (res.status === 401) {
    await clearUserSessionAfterUnauthorized('backend upload');
  }
  return marshalBackendResponse(res, 'text');
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
        pathPatch: pathResult,
      },
      'logger initialized',
    );
    if (remoteDebugging.enabled) {
      logger.info(
        {
          port: remoteDebugging.port,
          url: `http://127.0.0.1:${remoteDebugging.port}`,
          env: remoteDebugging.envName ?? 'dev-default',
        },
        'CDP remote debugging enabled',
      );
    }
    // Spawn silverhand-daemon and connect a HostClient. Daemon is the
    // only supported runtime path; backend routes every spawn / wake
    // / inbox delivery through this client. On connect failure we
    // tear down what we partially created and re-throw — there is no
    // runtime fallback (#task:512 cleanup Commit B deleted the
    // in-process ConversationManager runtime, Commit C removed the
    // env switch). Recovery is fixing the daemon spawn / socket.
    const paths = daemonPaths();
    daemon = await spawnDaemonChild({
      launcher: resolveDaemonLauncher(),
      socketPath: paths.socketPath,
      pidFilePath: paths.pidFilePath,
      logDir: paths.logDir,
      // D3.a Commit 4: the daemon is spawned WITHOUT --host-config so
      // it cannot dial a stale `daemon-config.json` left over from a
      // previous user. Outbound attach is triggered after login via
      // the `host_outbound_attach` IPC (see `attachLocalHostOutbound`
      // below). `paths.hostConfigPath` is still the destination the
      // post-login claim writes to — only the CLI-time auto-start is
      // removed from this code path.
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
      await hostClient.close().catch(() => undefined);
      hostClient = null;
      await daemon?.kill({ gracefulMs: 1_000 }).catch(() => undefined);
      daemon = null;
      throw new Error(
        'silverhand-daemon: HostClient failed to connect to the spawned daemon. ' +
          'There is no runtime fallback — daemon is the only supported runtime path. ' +
          'Recovery: ensure silverhand-daemon is spawnable / its socket is reachable. ' +
          `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    daemon.onExit(info => {
      logger?.error(
        { kind: info.kind, reason: info.reason, code: info.code },
        'silverhand-daemon exited fatally',
      );
      // D3.b Commit 2 — flip `local_host_status` to `'failed'` when
      // (and only when) the supervisor's terminal exit means no
      // automatic recovery is in flight. Strict source rule (Cindy
      // `#task:627` / `#task:629` review gates) is enforced by
      // `applyFatalExitToClaim`:
      //   - `kind === 'restart_budget_exhausted'` → flips to failed
      //     (modulo the `revoked` carve-out inside the helper)
      //   - `kind === 'respawn_handshake_failed'` → leaves state alone
      //     (recovery-surface ambiguous; logged only)
      //   - attach-watchdog timeout / typed `host_outbound_attach`
      //     failure / backend 401 → do NOT call this helper at all
      // See `local-host-failure.ts` for the full classification.
      localHostClaim = applyFatalExitToClaim(localHostClaim, info);
    });
    // D3.b Commit 1 — re-attach outbound after daemon generation change.
    //
    // Why this hook exists: D3.a Commit 4 deliberately spawns the local
    // daemon WITHOUT `--host-config` so it never dials a stale config
    // pre-login. When `spawnDaemonChild` respawns after a crash, the
    // new daemon process is "empty" — its `OutboundSupervisor` has no
    // attach config loaded — so main must re-fire `host_outbound_attach`
    // for the currently-claimed local host. Without this, a daemon
    // crash silently drops outbound and never recovers.
    //
    // Architectural framing (R1/R4): this IPC is a V1 desktop-embedded
    // local supervisor adapter. It is NOT part of the server↔daemon
    // formal protocol — terminal-state daemon is started by launchd
    // with a keychain-loaded host_token and attaches without main, at
    // which point this hook (and `spawnDaemonChild`) disappear.
    //
    // Dedup by `instanceId` only — the canonical daemon-generation
    // discriminator. `attachmentSatisfies` freshness (connectionId /
    // attachedAt) remains the only attach-success proof; this set is
    // strictly hook-reentry guard.
    const reattachedGenerations = new Set<string>();
    daemon.onDaemonGenerationChanged(info => {
      if (reattachedGenerations.has(info.instanceId)) {
        logger?.debug?.(
          { instanceId: info.instanceId, attempt: info.attempt },
          'D3.b daemon generation hook: already reattached, skipping',
        );
        return;
      }
      reattachedGenerations.add(info.instanceId);
      void (async () => {
        logger?.info(
          {
            pid: info.pid,
            daemonVersion: info.daemonVersion,
            instanceId: info.instanceId,
            startedAt: info.startedAt,
            attempt: info.attempt,
          },
          'D3.b daemon generation changed (post-crash respawn)',
        );
        const claim = localHostClaim;
        if (claim.status !== 'claimed' || claim.hostId === null) {
          // No active host claim yet — login flow has not run, or the
          // user is logged out. The post-login claim path will fire
          // its own `triggerLocalHostOutboundAttach` against the fresh
          // daemon when it runs.
          logger?.info(
            { instanceId: info.instanceId, status: claim.status },
            'D3.b daemon generation changed but no active local host claim; skipping re-attach',
          );
          return;
        }
        const client = hostClient;
        if (!client) {
          logger?.warn(
            { instanceId: info.instanceId },
            'D3.b daemon generation changed but hostClient is null; skipping re-attach',
          );
          return;
        }
        try {
          // HostClient.connect() is idempotent and serialises on its
          // internal readyPromise; if the socket is still reconnecting
          // we await the same handle as the live consumers. But
          // connect() ALONE doesn't prove the transport is talking to
          // *this* daemon generation (Cindy `#task:627` P1-A): it can
          // return a still-resolved readyPromise pointing at the old
          // generation's transport, or land on a different generation
          // mid-reconnect. The generation gate observes the client's
          // own reconnect loop until `negotiated.instanceId` matches
          // the one we got from the supervisor's hook.
          const ready = await waitForDaemonGeneration(client, info.instanceId);
          if (!ready.ok) {
            logger?.warn(
              {
                instanceId: info.instanceId,
                reason: ready.reason,
                err: ready.error,
              },
              'D3.b host client did not reach expected daemon generation; skipping re-attach',
            );
            return;
          }
        } catch (err) {
          logger?.warn(
            { err, instanceId: info.instanceId },
            'D3.b host client generation gate threw unexpectedly',
          );
          return;
        }
        const localHostId = claim.hostId;
        // Re-capture freshness window — the previous attachment died
        // with the old daemon, so its `previousConnectionId` is stale.
        const attachWindow = captureAttachWindow(localHostId);
        await triggerLocalHostOutboundAttach({
          localHostId,
          configPath: daemonHostConfigPath(silverhandDir()),
          attachWindow,
        });
      })().catch(err => {
        logger?.error(
          { err, instanceId: info.instanceId },
          'D3.b daemon generation re-attach unexpectedly threw',
        );
      });
    });
    backend = await startEmbeddedSilverhandServer({
      dataDir: silverhandDir(),
      serverConfig: config,
      silverhandCliLauncher: resolveSilverhandCliLauncher(),
      logger,
      loggers: loggers ?? undefined,
      logDir: join(silverhandDir(), 'logs'),
      hostClient,
    });
    await writeServerConfig(backend.context.serverConfig);
    installEventWsOriginOverride();
    if (!HEADLESS) {
      const hydrated = await hydrateDesktopSession();
      if (!hydrated) {
        await bootstrapEmbeddedUserSession();
      }
    }
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
    ...snapshotLocalHostInfo(),
  };
});

ipcMain.handle('auth:getState', () => desktopAuthState());

ipcMain.handle('auth:signup', (_event, input: AuthSignupInput) =>
  postAuthSession(authPaths.signup, input),
);

ipcMain.handle('auth:login', (_event, input: AuthLoginInput) =>
  postAuthSession(authPaths.login, input),
);

ipcMain.handle('auth:logout', () => logoutUserSession());

ipcMain.handle('backend:request', (_event, input: BackendProxyRequest) =>
  proxyBackendRequest(input),
);

ipcMain.handle('backend:upload', (_event, input: BackendUploadRequest) =>
  proxyBackendUpload(input),
);

ipcMain.handle('hosts:rotate', (_event, input: { hostId: string }) =>
  rotateHostToken(input?.hostId ?? ''),
);

ipcMain.handle('hosts:revoke', (_event, input: { hostId: string }) =>
  revokeHost(input?.hostId ?? ''),
);

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

// ── Selection export pipeline ─────────────────────────────────────────
//
// Renderer hands over PNG bytes (image) or transcript text (markdown);
// main owns the filesystem boundary (showSaveDialog + writeFile) and
// the clipboard write for images. MessageList / SelectionToolbar /
// the preview modal don't import `fs` or `dialog` directly — Cindy's
// IPC boundary review.
//
// Both save handlers return one of three result shapes so the renderer
// can render an appropriate toast:
//   { ok: true, path: '...' } | { ok: false, canceled: true }
//                              | { ok: false, error: string }
// `canceled` is distinguished from `error` because the user dismissing
// the save dialog is not a failure — toasting "save failed" in that
// case would feel wrong.

type ExportSaveResult =
  | { ok: true; path: string }
  | { ok: false; canceled: true }
  | { ok: false; error: string };

type ExportCopyResult = { ok: true } | { ok: false; error: string };

function sanitizeExportFilename(input: unknown, ext: string): string {
  // Coerce + strip path separators, control chars, and characters that
  // are unsafe on common file systems. Falls back to `transcript<ext>`
  // when the input is missing or empty after cleaning. Trusting the
  // renderer's suggested filename is fine for label purposes, but we
  // still re-sanitize here because the renderer is the *untrusted*
  // boundary in this pipeline.
  const raw = typeof input === 'string' ? input : '';
  const cleaned = raw
    .replace(/[\\/]/g, '_')
    .replace(/[\x00-\x1f]+/g, '')
    .replace(/[:*?"<>|]/g, '')
    .trim()
    .slice(0, 200);
  if (!cleaned) return `transcript${ext}`;
  // Always coerce the extension — guards against the renderer
  // suggesting `foo.md` for a PNG export by mistake.
  return cleaned.toLowerCase().endsWith(ext)
    ? cleaned
    : `${cleaned.replace(/\.[^.]+$/, '')}${ext}`;
}

function bytesFromPayload(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

ipcMain.handle(
  'export:savePng',
  async (
    event,
    input: { pngBytes?: unknown; suggestedName?: unknown },
  ): Promise<ExportSaveResult> => {
    const buf = bytesFromPayload(input?.pngBytes);
    if (!buf || buf.length === 0) {
      return { ok: false, error: 'invalid_payload' };
    }
    const safeName = sanitizeExportFilename(input?.suggestedName, '.png');
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showSaveDialog(win!, {
      title: 'Save image',
      defaultPath: safeName,
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(result.filePath, buf);
      return { ok: true, path: result.filePath };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
);

ipcMain.handle(
  'export:copyPng',
  async (
    _event,
    input: { pngBytes?: unknown },
  ): Promise<ExportCopyResult> => {
    // Renderer-side `navigator.clipboard.write([new ClipboardItem({...})])`
    // for images is brittle on Electron / macOS — easier and more
    // reliable to construct an NSImage in main and let Electron handle
    // the OS pasteboard format negotiation.
    const buf = bytesFromPayload(input?.pngBytes);
    if (!buf || buf.length === 0) {
      return { ok: false, error: 'invalid_payload' };
    }
    try {
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return { ok: false, error: 'decode_failed' };
      clipboard.writeImage(img);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
);

ipcMain.handle('notification:show', (event, opts: unknown) => {
  if (!opts || typeof opts !== 'object') return;
  const { title, body, force, notificationId } = opts as Partial<
    Record<string, unknown>
  >;
  if (typeof title !== 'string' || typeof body !== 'string') return;
  // Fire ordinary system notifications only when no Electron window is
  // focused. Direct human mentions opt into `force` so an active-but-
  // different channel still produces an OS notification instead of only
  // changing the unread dot.
  if (force !== true && BrowserWindow.getFocusedWindow() !== null) return;
  const n = new Notification({ title, body });
  // Click handler — only wired when the renderer attached a
  // `notificationId`. Bring a window forward (the user clicked, that's
  // the intent) and forward the id back so the renderer can navigate
  // to the right conversation. Without an id this is just an alert and
  // we keep the legacy "show only" behavior.
  if (typeof notificationId === 'string' && notificationId.length > 0) {
    n.on('click', () => {
      // Prefer the sender's window (the renderer that called us); fall
      // back to any visible window. macOS keeps windows around in the
      // dock even when minimized, so showing the first one is safe.
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const target =
        senderWindow ?? BrowserWindow.getAllWindows().find(w => !w.isDestroyed()) ?? null;
      if (target) {
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
      }
      // Best-effort focus the app itself (e.g. when another app is
      // frontmost). On macOS this nudges Silverhand to the foreground.
      if (process.platform === 'darwin') app.focus({ steal: true });
      if (!event.sender.isDestroyed()) {
        event.sender.send('notification:clicked', notificationId);
      }
    });
  }
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
        bootstrap_token_path: backend!.context.embeddedBootstrap.enabled
          ? backend!.context.embeddedBootstrap.filePath
          : null,
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
    // D3.b Commit 3 — best-effort outbound-detach hint, sent BEFORE
    // `backend.close()` because the backend itself owns the
    // `HostWsServerController` registry we want to observe go null.
    // Closing backend first would tear down the registry and reduce
    // this step to a fire-and-forget daemon-only signal (still
    // useful, just less observable). The detach is bounded by an
    // internal 1.5s budget and never blocks shutdown — any
    // outcome (RPC throw, timeout, registry never clears) just gets
    // logged. See `outbound-detach.ts` for the full contract.
    if (hostClient) {
      const claimedHostId =
        localHostClaim.status === 'claimed' ? localHostClaim.hostId : null;
      const getAttachment = backend
        ? (hostId: string) =>
            backend!.context.hostWsController?.()?.getAttachment(hostId) ?? null
        : undefined;
      const detachOutcome = await gracefullyDetachOutbound({
        client: hostClient,
        hostId: claimedHostId,
        getAttachment,
      });
      logger?.info(
        {
          kind: 'shutdown.outbound_detach',
          rpc_ok: detachOutcome.rpc.ok,
          rpc_action: detachOutcome.rpc.ok ? detachOutcome.rpc.action : null,
          rpc_error: !detachOutcome.rpc.ok ? detachOutcome.rpc.error : null,
          rpc_error_code: !detachOutcome.rpc.ok
            ? detachOutcome.rpc.code ?? null
            : null,
          registry_cleared: detachOutcome.registryCleared,
          elapsed_ms: detachOutcome.elapsedMs,
          budget_exhausted: detachOutcome.budgetExhausted,
          host_id: claimedHostId,
        },
        'outbound detach hint result on shutdown',
      );
    }
  } catch (err) {
    // The helper itself never throws — this catch covers truly
    // unexpected exceptions (e.g. logger blowing up). Swallow so
    // the rest of shutdown still runs.
    console.error('[main] outbound detach hint failed unexpectedly:', err);
  }

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
