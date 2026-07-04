import { app, BrowserWindow, ipcMain, Menu, session as electronSession, shell, type MenuItemConstructorOptions } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  AuthSessionResponseSchema,
  EMBEDDED_BOOTSTRAP_FILENAME,
  EVENT_WS_SESSION_COOKIE,
  HostClaimOrCreateResponseSchema,
  HostRevokeResponseSchema,
  HostRotateTokenEmbeddedResponseSchema,
  RuntimeKindSchema,
  X_SILVERHAND_LEGACY_USER_ID_HEADER,
  X_SILVERHAND_PRINCIPAL_HEADER,
  apiPaths,
  authPaths,
  classifyServerUrl,
  readAllowInsecureRemoteFlag,
  readForceEmbeddedFlag,
  redactServerConnectionProfile,
  type AuthLoginInput,
  type AuthSignupInput,
  type HostDto,
  type RuntimeKind,
  type ServerConnectionProfile,
  type ServerConnectionProfileView,
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
import {
  DESKTOP_ALLOW_INSECURE_REMOTE,
  DESKTOP_REMOTE_ONLY,
  PACKAGED_DEFAULT_SERVER_URL,
} from '../build-flags.js';
import {
  HostClient,
  HostClientError,
  spawnDaemonChild,
  type DaemonHandle,
} from '@silverhand/host';
import {
  electronUserDataPath,
  loadOrCreateServerConfig,
  silverhandDir,
  writeServerConfig,
} from './config.js';
import { resolveEffectiveBootProfile } from './desktop-build-config.js';
import { waitForDaemonGeneration } from './daemon-generation-attach.js';
import { applyFatalExitToClaim } from './local-host-failure.js';
import {
  classifyMeFetchOutcome,
  executeHydrate,
  type HydrateOutcome,
  type SessionValidationResult,
} from './auth-hydrate.js';
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
import {
  performOutboundReload,
  bindAttachmentAccessor,
  type OutboundReloadOutcome,
} from './outbound-reload.js';
import {
  performProfilePhase2,
  derivePartialApplyState,
  reconcilePartialApplyAtBoot,
  type PartialApplyState,
  type PerformProfilePhase2Deps,
  type ProfilePhase2Outcome,
} from './profile-phase2.js';
import { gracefullyDetachOutbound } from './outbound-detach.js';
import {
  clearServerConnectionProfile,
  readServerConnectionProfile,
  readServerConnectionProfileViewOrNull,
  writeServerConnectionProfile,
} from './server-connection-profile.js';
import {
  clearPersistedDesktopSession,
  loadPersistedDesktopSessionToken,
  persistDesktopSessionToken,
} from './desktop-session-storage.js';
import {
  decideBackendBootMode,
  evaluateProfileCommitGuard,
  executeBackendStartup,
  planBackendStartup,
  ProfileUnusableError,
} from './backend-boot-mode.js';
import {
  buildRemoteBackendHandle,
  type RemoteBackendHandle,
} from './remote-backend-handle.js';
import {
  probeServerInfo,
  type ProbeServerInfoResult,
} from './server-connection-test.js';
import { fetchServerInfoWithRetry } from './fetch-server-info.js';
import { registerEventWsDiagnosticIpcHandler } from './ipc/event-ws-diagnostics.js';
import { registerSelectionExportIpcHandlers } from './ipc/selection-export.js';
import {
  registerSurfaceIpcHandlers,
  type ActiveConversationInfo,
} from './ipc/surface-ipc.js';

/**
 * D4.a Commit 5d — typed union of the two boot-time backend
 * adapters. The desktop main process always has either a local
 * embedded backend (`startEmbeddedSilverhandServer` produced a
 * `RunningBackend`) or a remote one (the user's profile pointed at a
 * remote URL; main built a `RemoteBackendHandle` instead). Code that
 * needs the URL goes through {@link requireBackendUrl}; code that
 * actually depends on in-process embedded surface (the
 * `BackendContext`, the local `HostWsServerController` registry, the
 * `ServerConfig` for legacy on-disk persistence) goes through
 * {@link requireEmbeddedBackend} or {@link getEmbeddedHostWsController}
 * — both of which `null` / typed-fail on the remote arm so a remote
 * boot can never silently consume an embedded-only side effect.
 */
type BackendHandle =
  | { readonly kind: 'embedded'; readonly running: RunningBackend }
  | RemoteBackendHandle;

interface DesktopHostProxyConfig {
  proxy_url: string | null;
  proxy_runtimes: RuntimeKind[];
}

type DesktopHostProxyConfigResult =
  | { ok: true; config: DesktopHostProxyConfig }
  | {
      ok: false;
      code:
        | 'not_local_host'
        | 'daemon_unavailable'
        | 'daemon_error'
        | 'invalid_input';
      message?: string;
    };

class RemoteOnlyServerProfileRequiredError extends Error {
  constructor(reason: string) {
    super(
      `This Silverhand Desktop package was built as remote-only, but no ` +
        `usable remote server profile is available. ${reason} ` +
        `Repackage with --server-url <https-origin>, or save a non-loopback ` +
        `remote server profile before launching this build.`,
    );
    this.name = 'RemoteOnlyServerProfileRequiredError';
  }
}

let backend: BackendHandle | null = null;
let daemon: DaemonHandle | null = null;
let hostClient: HostClient | null = null;

if (process.env.SILVERHAND_DIR) {
  app.setPath('userData', electronUserDataPath());
}
let logger: FileLogger | null = null;
let loggers: CategorizedLoggers | null = null;
let mainWindow: BrowserWindow | null = null;
let eventsWindow: BrowserWindow | null = null;
let activeConversation: ActiveConversationInfo = { workspaceId: null, conversationId: null };
let userSessionToken: string | null = null;
let userSessionUser: UserDto | null = null;
let localHostClaim: LocalHostClaimStatus = { status: 'unclaimed', hostId: null };

/**
 * D4.a Commit 5c-2 — in-memory state describing whether the desktop's
 * view of the server connection profile has been fully applied to the
 * daemon's running config (per `docs/remote-backend-architecture-notes.md §3`).
 *
 * Lives on the desktop main process only — NOT serialized to disk
 * (the source of truth is the comparison `profile.version` vs
 * `daemon-config.profile_version`, which 5c-3 reconciliation re-derives
 * on boot). NOT crossed into the wire / daemon protocol per §7.6 — R4
 * boundary: this is a local desktop UX concept, not a backend-observable
 * fact.
 *
 * Initial value is `{ kind: 'fully_applied' }`. Phase-2 transitions it
 * to `partial_apply_pending` on failure; a successful Retry or boot
 * reconciliation transitions it back. Renderer reads via the
 * `partialApply:get` IPC and triggers a re-attempt via
 * `partialApply:retry`.
 */
let partialApplyState: PartialApplyState = { kind: 'fully_applied' };

/** Set `SILVERHAND_HEADLESS=1` to boot the backend without a window.
 *  Useful for curl-driven smoke tests and integration scripts — see
 *  `pnpm dev:headless`. The process keeps the backend alive until
 *  SIGINT / SIGTERM. */
const HEADLESS = process.env.SILVERHAND_HEADLESS === '1';

function desktopAllowsInsecureRemote(): boolean {
  return (
    DESKTOP_ALLOW_INSECURE_REMOTE ||
    readAllowInsecureRemoteFlag(process.env)
  );
}

interface RemoteDebuggingConfig {
  enabled: boolean;
  port: number | null;
  reason?: string;
  envName?: string;
}

const remoteDebugging = configureRemoteDebugging();

type DesktopAuthState =
  | { status: 'authenticated'; signup_enabled: boolean; user: UserDto }
  | { status: 'unauthenticated'; signup_enabled: boolean }
  // D4.a Commit 5d-fixup (Cindy P1-2): typed backend-unreachable arm.
  // Pinned to `preload/index.ts` and `preload/api.d.ts` — the three
  // copies stay in lock-step. **No `signup_enabled`** — unknown
  // when the server is unreachable.
  | { status: 'backend_unreachable'; server_url: string; message: string };

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

function appendExistingPathEntries(
  rawPath: string,
  candidates: readonly string[],
): { path: string; added: string[] } {
  const parts = rawPath.split(delimiter).filter(Boolean);
  const seen = new Set(parts);
  const added = candidates.filter(candidate => {
    if (seen.has(candidate)) return false;
    if (!existsSync(candidate)) return false;
    seen.add(candidate);
    return true;
  });
  return { path: [...added, ...parts].join(delimiter), added };
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
 *
 * The login-shell probe is necessary but not sufficient: users can have
 * version-manager shims installed in common per-user locations without
 * exporting those directories from their shell rc files. We prepend only
 * existing fallback directories so packaged daemon children can find
 * runtime shims like `~/.local/bin/claude` without inventing PATH entries.
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
    const patched = appendExistingPathEntries(m[1].trim(), [
      join(homedir(), '.local', 'bin'),
      join(homedir(), '.npm-global', 'bin'),
      join(homedir(), '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
    ]);
    process.env.PATH = patched.path;
    return {
      ok: true,
      detail: `shell=${userShell}, len=${process.env.PATH.length}, added=${patched.added.join(':') || 'none'}`,
    };
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
  runtimePidRootDir: string;
  agentHomeRootDir: string;
  hostConfigPath: string;
  proxyConfigPath: string;
  controlPlaneServerUrlPath: string;
  /** Local outbound frame socket — the daemon binds it and the embedded
   *  backend dials it for the D5.a R4-unified outbound envelope. */
  localOutboundSocketPath: string;
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
    runtimePidRootDir: join(runDir, 'runtime-pids'),
    agentHomeRootDir: join(silverhandDir(), 'agents'),
    hostConfigPath: daemonHostConfigPath(silverhandDir()),
    proxyConfigPath: join(silverhandDir(), 'daemon', 'proxy-config.json'),
    controlPlaneServerUrlPath: join(runDir, 'control-plane-server-url'),
    localOutboundSocketPath: join(runDir, 'daemon-outbound.sock'),
  };
}

function embeddedBootstrapPath(): string {
  return join(silverhandDir(), EMBEDDED_BOOTSTRAP_FILENAME);
}

/**
 * D4.a Commit 5d — narrow accessors over the {@link BackendHandle}
 * union. Replaced the legacy `requireBackend()` (which returned the
 * embedded-only `RunningBackend` directly) so callers cannot
 * accidentally read embedded-only context (`backend.context.*`) on
 * the remote arm via optional-chain or `as` cast. Every callsite
 * picks the helper that matches its actual dependency:
 *
 *   - {@link requireBackendUrl} — works on both arms; returns the
 *     active backend's URL (embedded loopback or remote origin).
 *     Use for HTTP/WS/proxy URL construction and origin overrides.
 *
 *   - {@link requireEmbeddedBackend} — typed-throw on remote arm.
 *     Use ONLY for code that genuinely depends on in-process
 *     embedded surface (e.g. the `BackendContext`, `ServerConfig`
 *     for legacy on-disk write). The `reason` argument is logged
 *     in the throw so a regression that calls this on the remote
 *     arm fails loud at the offending site.
 *
 *   - {@link getEmbeddedHostWsController} — `null` on remote arm.
 *     Use for graceful-shutdown detach observability: on remote
 *     there is no in-process registry to observe, so the helper
 *     returns `null` and the consumer falls back to RPC-only path.
 *     This MUST be `null`, not `undefined`, so the caller can
 *     distinguish "registry deliberately absent" from "registry
 *     accessor missing because of an upstream bug".
 */
function requireBackendUrl(): string {
  if (!backend) throw new Error('backend not ready');
  return backend.kind === 'embedded' ? backend.running.url : backend.url;
}

function requireEmbeddedBackend(reason: string): RunningBackend {
  if (!backend) {
    throw new Error(`backend not ready (caller: ${reason})`);
  }
  if (backend.kind !== 'embedded') {
    throw new Error(
      `embedded backend required but desktop is in remote mode (caller: ${reason})`,
    );
  }
  return backend.running;
}

function getEmbeddedHostWsController(): ReturnType<
  NonNullable<RunningBackend['context']['hostWsController']>
> | null {
  if (!backend || backend.kind !== 'embedded') return null;
  return backend.running.context.hostWsController?.() ?? null;
}

function backendUrl(path: string): string {
  return new URL(path, requireBackendUrl()).toString();
}

function eventWsCookieUrl(): string {
  return new URL(apiPaths.eventWebSocket, requireBackendUrl()).toString();
}

function backendOrigin(): string {
  return new URL(requireBackendUrl()).origin;
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
      secure: new URL(requireBackendUrl()).protocol === 'https:',
      path: apiPaths.eventWebSocket,
    })
    .catch(err => {
      logger?.warn({ err }, 'failed to set event websocket session cookie');
    });
}

/**
 * D4.a Commit 5d (Cindy review boundary 3) — install the Origin /
 * Cookie override for the event-WS upgrade. Works on **both**
 * embedded and remote arms: the origin is read from the active
 * {@link BackendHandle} via {@link backendOrigin}, and the URL filter
 * pattern is built from `requireBackendUrl()`. The function does NOT
 * assume embedded loopback — for a remote https profile the protocol
 * flips to `wss:`, the host is the remote backend's host, and the
 * `Origin` header is the remote backend's origin (which is exactly
 * what its CORS policy expects).
 *
 * Renamed from `installEventWsOriginOverride` to
 * {@link installBackendEventWsOriginOverride} so the name no longer
 * suggests an embedded-only assumption.
 */
function installBackendEventWsOriginOverride(): void {
  if (!backend) return;
  const expectedOrigin = backendOrigin();
  const expectedUrl = new URL(apiPaths.eventWebSocket, requireBackendUrl());
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
  clearPersistedDesktopSession({ silverhandRoot: silverhandDir(), logger });
}

function loadPersistedUserSessionToken(): string | null {
  return loadPersistedDesktopSessionToken({ silverhandRoot: silverhandDir(), logger });
}

function persistUserSessionToken(token: string): void {
  persistDesktopSessionToken({ silverhandRoot: silverhandDir(), token, logger });
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
  return fetchServerInfoWithRetry({
    url: backendUrl(apiPaths.serverInfo),
  });
}

async function validateUserSessionToken(
  token: string,
): Promise<SessionValidationResult> {
  // D4.a Commit 6 fixup (Cindy P1 #task:658 follow-up): the
  // previous implementation returned `UserDto | null` and the
  // `null` arm collapsed "server rejected (401/403)" with
  // "couldn't reach the server (DNS/TLS/5xx/throw)". The latter
  // was used by `hydrateDesktopSession` to clear local state,
  // which violated D4.a's `backend_unreachable` recoverability
  // invariant. We now return a typed three-arm union via the
  // pure `classifyMeFetchOutcome` classifier (see auth-hydrate.ts).
  let res: Response;
  try {
    res = await fetch(backendUrl(apiPaths.me), {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return classifyMeFetchOutcome({ kind: 'throw', error: err });
  }
  // Only attempt to read the body when the status is 2xx — the
  // classifier doesn't need a body for non-2xx arms (it routes
  // on status alone), and pulling bytes off a 5xx response wastes
  // time on the failure path.
  let body: unknown = null;
  if (res.ok) {
    body = await res.json().catch(() => null);
  }
  return classifyMeFetchOutcome({
    kind: 'response',
    status: res.status,
    body,
  });
}

// D4.a Commit 6 fixup (Cindy P1 #task:658 follow-up): in-flight
// guard so concurrent IPC handlers (boot-time bootstrap +
// renderer `getAuthState` poll) cannot race two `executeHydrate`
// orchestrations against the same persisted token. `store` /
// `claim` are not idempotent against concurrent re-runs.
let hydrateInFlight: Promise<HydrateOutcome> | null = null;

async function runHydrate(): Promise<HydrateOutcome> {
  if (hydrateInFlight) return hydrateInFlight;
  hydrateInFlight = executeHydrate({
    loadToken: loadPersistedUserSessionToken,
    validate: validateUserSessionToken,
    store: storeUserSession,
    clear: clearUserSession,
    claim: claimLocalHostForUserSession,
    log: {
      info: (obj, msg) => logger?.info(obj, msg),
      warn: (obj, msg) => logger?.warn(obj, msg),
    },
  }).finally(() => {
    hydrateInFlight = null;
  });
  return hydrateInFlight;
}

async function hydrateDesktopSession(): Promise<boolean> {
  const outcome = await runHydrate();
  return outcome === 'authenticated';
}

async function desktopAuthState(): Promise<DesktopAuthState> {
  // D4.a Commit 5d-fixup (Cindy P1-2): typed surface for backend
  // unreachability. On the remote arm a network failure (server
  // down / DNS / TLS / unreachable) MUST land on a typed
  // `backend_unreachable` arm so the renderer renders a connect
  // gate instead of the IPC promise rejecting and leaving the UI
  // stuck on a Loading spinner. We deliberately do NOT include
  // `signup_enabled` in this arm — when the server is unreachable
  // we don't know its policy, and a default would leak a guess
  // into the gate UI. Intentionally narrow what we catch:
  // `fetch` rejections + `Error` instances thrown by `fetchServerInfo`.
  let info: ServerInfo;
  try {
    info = await fetchServerInfo();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const url = backendUrl('');
    logger?.warn(
      { err, server_url: url },
      'desktopAuthState: backend unreachable (server_info fetch failed)',
    );
    return {
      status: 'backend_unreachable',
      server_url: url,
      message,
    };
  }
  // D4.a Commit 6 fixup (Cindy P1 #task:658 follow-up): recovery
  // path. If our in-memory session is empty but a persisted token
  // still sits on disk, hydrate was deferred at boot due to a
  // transient `backend_unreachable` (rather than rejected — the
  // rejected arm would have cleared the persisted blob). Now that
  // `fetchServerInfo()` just succeeded, retry validation against
  // the live backend. On valid → promote to in-memory session +
  // claim host, no re-login required. On rejected → clear. On
  // still-unreachable (e.g. `/api/me` 5xx while `/api/server/info`
  // is OK) → fall through and we'll surface a backend_unreachable
  // arm below rather than push the user toward unauthenticated.
  if (
    (!userSessionToken || !userSessionUser) &&
    loadPersistedUserSessionToken()
  ) {
    await runHydrate();
  }
  if (userSessionToken && userSessionUser) {
    return {
      status: 'authenticated',
      signup_enabled: info.signup_enabled,
      user: userSessionUser,
    };
  }
  // D4.a Commit 6 fixup (Cindy P1 #task:658 follow-up): if we
  // still have a persisted token on disk but nothing in memory
  // after the hydrate attempt above, validation hit the
  // `unreachable` arm (rejected would have cleared the blob).
  // Surface as `backend_unreachable` so the renderer shows the
  // unreachable gate and the user can click Retry — DO NOT route
  // them to the registration / login gate, because their
  // persisted session is still valid as far as we know; we just
  // can't ask the server right now.
  if (loadPersistedUserSessionToken()) {
    const url = backendUrl('');
    return {
      status: 'backend_unreachable',
      server_url: url,
      message:
        'session validation pending — /api/me did not return a verdict',
    };
  }
  return { status: 'unauthenticated', signup_enabled: info.signup_enabled };
}

async function postAuthSession(
  path: typeof authPaths.signup | typeof authPaths.login,
  input: AuthSignupInput | AuthLoginInput,
): Promise<DesktopAuthResult> {
  // D4.a Commit 5d-fixup (Cindy P1-2): typed network-failure surface.
  // A remote backend that disappears between renderer mount and
  // login submit MUST NOT throw an untyped IPC rejection; we report
  // `status: 0` ("Network Error") with a typed body so the renderer
  // surfaces a connect gate instead of a generic "something went
  // wrong". `ApiError` on the renderer special-cases status 0 and
  // exposes `kind: 'backend_unreachable'`.
  let res: Response;
  try {
    res = await fetch(backendUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      statusText: 'Network Error',
      bodyText: JSON.stringify({ error: 'backend_unreachable', message }),
    };
  }
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
  // D4.a Commit 5d — embedded-only path. The bootstrap token comes
  // from a file the embedded backend itself writes on first run; on
  // the remote arm there is no such file and no embedded backend —
  // login flows through `/auth/login` driven by user input. Guard on
  // the union discriminator (no `as` / no `?.`).
  if (backend?.kind !== 'embedded') return false;
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
  if (!token || !backend) {
    localHostClaim = { status: 'unclaimed', hostId: null };
    return;
  }

  // D4.a Commit 5d (Cindy 5d review boundary 2 + 4): the claim path
  // works on BOTH embedded and remote arms. `backendUrl()` resolves
  // against `requireBackendUrl()`, which returns the active backend
  // URL — embedded loopback on the embedded arm, the canonical
  // remote origin on the remote arm. The fetch failure path below
  // (try/catch around lines `localHostClaim = { status: 'error', … }`)
  // already handles a remote backend that's unreachable: claim is
  // logged + status flips to `error`; no throw escapes, no embedded
  // fallback, no main crash. This satisfies the §4.2 hard gate
  // "remote profile saved → next launch must not crash even if the
  // remote backend is down".
  const backendUrlSnapshot = requireBackendUrl();
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

    // D4.a Commit 5c-1 (per `docs/remote-backend-architecture-notes.md §3`):
    // when a server connection profile is committed, claim writes the
    // profile generation into daemon-config so the daemon's fingerprint
    // (5b) stays in sync with desktop's view of the current profile.
    // Embedded mode without a profile (no Setup Wizard run yet) leaves
    // the field undefined — the on-disk file omits it, the daemon
    // fingerprint treats it as `<none>`, and the absence is itself a
    // stable state distinct from any explicit version.
    const profileRead = readServerConnectionProfile({
      silverhandRoot: silverhandDir(),
      logger: logger ?? undefined,
    });
    const profileVersion =
      profileRead.ok ? profileRead.profile.version : undefined;
    const allowInsecureRemote = desktopAllowsInsecureRemote();

    writeDaemonHostConfig(dir, {
      server_url: backendUrlSnapshot,
      host_id: localHostId,
      host_token: hostToken,
      ...(allowInsecureRemote ? { allow_insecure_remote: true } : {}),
      ...(profileVersion !== undefined ? { profile_version: profileVersion } : {}),
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
 *  refresh in one round-trip. D3.c Commit 4 added
 *  `local_host_server_url` to the `BackendInfo` surface, and these
 *  mutation payloads are built via `...snapshotLocalHostInfo()`, so
 *  the typed surface MUST include it (Cindy `#task:634` re-review P2). */
type DesktopHostMutationResult =
  | {
      ok: true;
      host: HostDto;
      local_host_id: string | null;
      local_host_status: LocalHostClaimStatus['status'];
      local_host_ws_attached_at: number | null;
      local_host_server_url: string | null;
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
  local_host_server_url: string | null;
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
        ? getEmbeddedHostWsController()?.getAttachment(localHostClaim.hostId)?.attachedAt ?? null
        : null,
    // D3.c Commit 4: surface the daemon-config `server_url` so the
    // Settings "Server" pane (and any future Hosts page readout) can
    // distinguish "what the daemon dials" from `backend.url` ("what
    // this desktop's embedded backend listens on"). Sourced directly
    // from `readDaemonHostConfig`; returns null when no daemon-config
    // exists (pre-claim state). Re-reads on every `backend:info`
    // refetch so post-save invalidation surfaces the new URL.
    local_host_server_url:
      readDaemonHostConfig(silverhandDir())?.server_url ?? null,
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
  const controller = getEmbeddedHostWsController();
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
  if (!client || !backend) {
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
  // D4.a Commit 5d — controller is `null` on the remote arm (no
  // in-process registry) AND on the embedded arm if `hostWsController`
  // is unavailable. Both cases mean "we acked the attach IPC but
  // can't observe the WS attachment locally"; the watchdog stays
  // un-armed and the user-facing status enum simply waits for
  // `local_host_status` updates from a different surface (renderer
  // poll / typed claim error) instead of from registry observation.
  const controller = getEmbeddedHostWsController();
  if (!controller) {
    // No controller (remote arm, or embedded edge); we still acked
    // the IPC, so attach itself is fine — just can't observe it
    // from main.
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
  if (!token || !backend) {
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
    serverUrl: requireBackendUrl(),
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

function normalizeDesktopHostProxyConfig(
  input: unknown,
): DesktopHostProxyConfig | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as {
    proxy_url?: unknown;
    proxy_runtimes?: unknown;
  };
  const rawUrl = obj.proxy_url;
  if (rawUrl !== null && typeof rawUrl !== 'string') return null;
  const proxy_url =
    typeof rawUrl === 'string' && rawUrl.trim().length > 0
      ? rawUrl.trim()
      : null;
  if (!Array.isArray(obj.proxy_runtimes)) return null;
  const proxy_runtimes: RuntimeKind[] = [];
  const seen = new Set<string>();
  for (const value of obj.proxy_runtimes) {
    const parsed = RuntimeKindSchema.safeParse(value);
    if (!parsed.success || seen.has(parsed.data)) continue;
    seen.add(parsed.data);
    proxy_runtimes.push(parsed.data);
  }
  return { proxy_url, proxy_runtimes };
}

async function getHostProxyConfig(
  hostId: string,
): Promise<DesktopHostProxyConfigResult> {
  if (!hostId || localHostClaim.status !== 'claimed' || hostId !== localHostClaim.hostId) {
    return { ok: false, code: 'not_local_host' };
  }
  if (!hostClient || !hostClient.isConnected()) {
    return { ok: false, code: 'daemon_unavailable' };
  }
  try {
    const result = await hostClient.hostProxyConfigGet();
    return { ok: true, config: result.config };
  } catch (err) {
    logger?.warn(
      { err: err instanceof Error ? err.message : String(err), hostId },
      'host proxy config get failed',
    );
    return {
      ok: false,
      code:
        err instanceof HostClientError && err.code === 'disconnected'
          ? 'daemon_unavailable'
          : 'daemon_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function saveHostProxyConfig(input: {
  hostId: string;
  config: unknown;
}): Promise<DesktopHostProxyConfigResult> {
  if (!input.hostId || localHostClaim.status !== 'claimed' || input.hostId !== localHostClaim.hostId) {
    return { ok: false, code: 'not_local_host' };
  }
  const config = normalizeDesktopHostProxyConfig(input.config);
  if (!config) return { ok: false, code: 'invalid_input' };
  if (!hostClient || !hostClient.isConnected()) {
    return { ok: false, code: 'daemon_unavailable' };
  }
  try {
    const result = await hostClient.hostProxyConfigSet(config);
    return { ok: true, config: result.config };
  } catch (err) {
    logger?.warn(
      { err: err instanceof Error ? err.message : String(err), hostId: input.hostId },
      'host proxy config set failed',
    );
    return {
      ok: false,
      code:
        err instanceof HostClientError && err.code === 'disconnected'
          ? 'daemon_unavailable'
          : 'daemon_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * D3.c Commit 3 — Settings "save server URL" handler.
 *
 * Wires the IPC payload to `performOutboundReload` with real
 * deps. The orchestrator (`outbound-reload.ts`) owns the full
 * decision tree; this thin handler only:
 *   - Pulls the current `host_token` from `daemon-config.json`
 *     via `readDaemonHostConfig` — the token NEVER appears in
 *     the renderer-supplied input. Treats missing/parse failure
 *     as `not_attached` (orchestrator's reason enum).
 *   - Pulls the current `local_host_id` from `localHostClaim`
 *     (the desktop's single source of truth for "what host am
 *     I bound to right now").
 *   - Aborts any active attach watchdog on success — analogous
 *     to the rotate-token / re-login paths that also pass
 *     through `triggerLocalHostOutboundAttach` and don't want
 *     two pollers racing for the same hostId.
 *
 * The returned `OutboundReloadOutcome` is structurally
 * identical to the renderer-side `DesktopSaveServerUrlResult`
 * declared in `preload/api.d.ts`; the IPC layer serializes the
 * tagged-union shape directly so both sides see the same
 * `kind`/`reason` discriminator.
 */
async function saveServerUrlFromSettings(
  rawServerUrl: string,
): Promise<OutboundReloadOutcome> {
  const client = hostClient;
  if (!client || !backend) {
    // Pre-backend / post-shutdown — the orchestrator would itself
    // surface this as a reload IPC transport failure mapped to
    // `not_attached`, but we short-circuit here so the renderer
    // sees the actionable reason without the daemon-side
    // round-trip-attempt log spam.
    return {
      ok: false,
      kind: 'reload_rejected',
      reason: 'not_attached',
      message: 'backend or host client not ready',
    };
  }

  const dir = silverhandDir();
  // **Controller snapshot (Cindy `#task:634` review P2)**: bind
  // `getAttachment` to a NON-NULL controller ONLY when one exists.
  // If we instead passed a function that always returns null, the
  // orchestrator's `no_attachment_controller` arm would be
  // unreachable in production — every "missing controller" case
  // would silently fall through to starting the watchdog, polling
  // nothing for 10s, and surfacing as `connectivity_unverified`.
  // Snapshotting upfront makes the arm reachable and saves a full
  // watchdog budget when verification is structurally impossible.
  // Mirrors the D3.b `host_outbound_detach` controller-snapshot
  // pattern.
  //
  // D4.a Commit 5d / `#task:1021`: derive `remoteMode` from the
  // backend discriminant DIRECTLY, NOT from `controller === null`.
  // `getEmbeddedHostWsController()` returns null in TWO distinct cases
  // (`:556-561`): `backend.kind !== 'embedded'` (genuinely remote) AND
  // embedded-but-`hostWsController?.()` missing (a registry-missing edge
  // that SHOULD surface as `no_attachment_controller`). Binding
  // `remoteMode = controller === null` would conflate them and promote
  // that embedded edge to a `reloaded_remote` success — swallowing the
  // failure the orchestrator is supposed to expose (Cindy `#task:1021`
  // review P1). So: `remoteMode = backend.kind === 'remote'` (explicit),
  // and the controller is still snapshotted separately for
  // `bindAttachmentAccessor` (null on the remote arm → no local watchdog;
  // connectivity is shown by the renderer's connection indicator, which
  // polls remote host-status `availability` — #task:1010).
  const controller = getEmbeddedHostWsController();
  const allowInsecureRemote = desktopAllowsInsecureRemote();
  const outcome = await performOutboundReload(
    { serverUrl: rawServerUrl },
    {
      classifyServerUrl,
      allowInsecureRemote,
      writeDaemonHostConfig: config => writeDaemonHostConfig(dir, config),
      hostOutboundReload: () => client.hostOutboundReload(),
      getAttachment: bindAttachmentAccessor(controller),
      remoteMode: backend.kind === 'remote',
      currentLocalHostId: () =>
        localHostClaim.status === 'claimed' ? localHostClaim.hostId : null,
      currentHostToken: () => readDaemonHostConfig(dir)?.host_token ?? null,
      // 5c-1: pull `profile_version` from the on-disk config so the
      // legacy settings:saveServerUrl path doesn't drop the field
      // when it rewrites the file. Legacy save is NOT a profile
      // commit; it should preserve whatever generation the existing
      // daemon-config (post-claim) was stamped with.
      currentProfileVersion: () => readDaemonHostConfig(dir)?.profile_version,
    },
  );

  // On a save that actually re-attached we cancel any in-flight
  // post-login attach watchdog — the reload-side watchdog inside
  // `performOutboundReload` already observed the fresh
  // attachment, so the old poll has no work to do. Mirrors the
  // rotate-token path (which also calls
  // `triggerLocalHostOutboundAttach` to spawn a fresh watchdog
  // and aborts the previous one inside that helper).
  if (outcome.ok && outcome.kind === 'reloaded') {
    activeAttachWatchdog?.abort();
    activeAttachWatchdog = null;
  }

  // Diagnostic logging — every outcome arm gets a single line so
  // operators can correlate Settings saves against subsequent
  // daemon / backend log entries.
  if (outcome.ok) {
    logger?.info(
      { kind: outcome.kind, elapsedMs: 'elapsedMs' in outcome ? outcome.elapsedMs : null },
      'D3.c settings:saveServerUrl ok',
    );
  } else {
    logger?.warn(
      {
        kind: outcome.kind,
        reason: 'reason' in outcome ? outcome.reason : null,
        message: 'message' in outcome ? outcome.message : null,
      },
      'D3.c settings:saveServerUrl failed',
    );
  }

  return outcome;
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
  // D4.a Commit 5d-fixup (Cindy P1-2): typed network-failure surface
  // for backend proxy. A remote backend that disappears mid-session
  // MUST NOT throw an untyped IPC rejection; the renderer's
  // `ApiError` special-cases `status: 0` and tags it
  // `kind: 'backend_unreachable'`.
  let res: Response;
  try {
    res = await fetch(backendUrl(input.path), {
      method: input.method ?? 'GET',
      headers,
      body: input.bodyText,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 0,
      statusText: 'Network Error',
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({ error: 'backend_unreachable', message }),
    };
  }
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
  // D4.a Commit 5d-fixup (Cindy P1-2): same typed network-failure
  // surface as `proxyBackendRequest` — symmetric handling so the
  // renderer can rely on `status: 0` regardless of which proxy ran.
  let res: Response;
  try {
    res = await fetch(backendUrl(input.path), {
      method: 'POST',
      headers: { Authorization: `Bearer ${userSessionToken}` },
      body: form,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 0,
      statusText: 'Network Error',
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({ error: 'backend_unreachable', message }),
    };
  }
  if (res.status === 401) {
    await clearUserSessionAfterUnauthorized('backend upload');
  }
  return marshalBackendResponse(res, 'text');
}

async function bootstrap(): Promise<void> {
  try {
    const pathResult = patchPathFromLoginShell();
    // D4.a Commit 5d fixup (Cindy P1-1): NOTE — `loadOrCreateServerConfig()`
    // is intentionally NOT called here. The legacy
    // `~/.silverhand/server-config.json` is an embedded-only boot
    // artifact (it remembered the embedded server's chosen port +
    // mode for cross-launch persistence). Calling it before the
    // boot-mode decision would touch — and on missing/corrupt
    // files **write** — embedded artifacts on a remote-profile
    // boot, breaking the §4.2 hard gate ("remote profile saved →
    // next launch must not crash, must not fall back to embedded").
    // The loader now lives behind `executeBackendStartup`'s
    // embedded arm only (see below); a unit-tested seam pins that
    // remote / refuse plans never reach it.
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
    // D4.a Commit 3 — boot-mode decision. We compute it AFTER the
    // logger is initialized so the decision can be logged actionably,
    // but BEFORE we spawn the daemon / start the embedded backend so
    // the trip wire (remote mode → throw) fires before any partial
    // state lands on disk. Inputs are taken from the existing
    // local 0600 profile reader and the strict env helpers
    // in `@silverhand/shared/config`. See `backend-boot-mode.ts` for
    // the full decision matrix and the trip-wire rationale.
    const savedBootProfileView = readServerConnectionProfileViewOrNull({
      silverhandRoot: silverhandDir(),
      logger: logger
        ? {
            warn: (payload, msg) => logger?.warn(payload, msg),
            info: (payload, msg) => logger?.info(payload, msg),
          }
        : undefined,
    });
    const allowInsecureRemote = desktopAllowsInsecureRemote();
    const forceEmbedded = readForceEmbeddedFlag(process.env);
    const effectiveBootProfile = resolveEffectiveBootProfile({
      savedProfileView: savedBootProfileView,
      packagedDefaultServerUrl: PACKAGED_DEFAULT_SERVER_URL,
      allowInsecureRemote,
      remoteOnly: DESKTOP_REMOTE_ONLY,
    });
    if (effectiveBootProfile.warning) {
      logger.warn(
        {
          reason: effectiveBootProfile.warning.reason,
          packagedDefaultServerUrl: PACKAGED_DEFAULT_SERVER_URL,
          remoteOnly: DESKTOP_REMOTE_ONLY,
          allowInsecureRemote: DESKTOP_ALLOW_INSECURE_REMOTE,
        },
        effectiveBootProfile.warning.message,
      );
    }
    if (effectiveBootProfile.source === 'packaged_default') {
      logger.info(
        {
          serverUrl: effectiveBootProfile.profileView.server_url,
          remoteOnly: DESKTOP_REMOTE_ONLY,
          allowInsecureRemote: DESKTOP_ALLOW_INSECURE_REMOTE,
        },
        'desktop packaged default server URL selected for boot',
      );
    }
    if (DESKTOP_REMOTE_ONLY && forceEmbedded) {
      logger.warn(
        {},
        'SILVERHAND_FORCE_EMBEDDED=1 ignored because this package is remote-only',
      );
    }
    const bootDecision = decideBackendBootMode({
      profileView: effectiveBootProfile.profileView,
      forceEmbedded: DESKTOP_REMOTE_ONLY ? false : forceEmbedded,
      allowInsecureRemote,
    });
    // D4.a Commit 5d — convert the boot decision into a startup plan
    // via the pure adapter (`backend-boot-mode.ts`). The adapter is
    // unit-tested for every decision arm so the bootstrap site below
    // only has to switch on `plan.mode` — it can't accidentally
    // forget an arm and silently fall through.
    const startupPlan = planBackendStartup(bootDecision);
    if (startupPlan.mode === 'refuse') {
      logger.error(
        {
          profileUrl: startupPlan.profileUrl,
          classifyMessage: startupPlan.classifyMessage,
        },
        'D4.a Commit 3 boot gate (5d adapter): profile present but classifier refused it; throwing (no silent embedded fallback)',
      );
      // Throw rather than silently boot embedded (Cindy D4.a Commit
      // 3 review P1-B). A present-but-unusable profile is data the
      // user committed deliberately — silently falling back would
      // muddle "configured backend is broken; please fix" with "no
      // profile yet; using embedded". Repair path is in the error
      // message: clear profile via Settings, or set the env flag
      // that made the URL acceptable, or set `SILVERHAND_FORCE_EMBEDDED=1`.
      //
      // Construct the `profile_invalid` decision shape from the
      // refuse-arm plan (the planner is `decision → plan` losslessly
      // for this arm) so the error class' constructor gets exactly
      // the variant it expects.
      throw new ProfileUnusableError({
        mode: 'profile_invalid',
        profileUrl: startupPlan.profileUrl,
        classifyMessage: startupPlan.classifyMessage,
      });
    }
    if (DESKTOP_REMOTE_ONLY && startupPlan.mode !== 'remote') {
      logger.error(
        {
          startupPlan,
          packagedDefaultServerUrl: PACKAGED_DEFAULT_SERVER_URL,
          effectiveProfileSource: effectiveBootProfile.source,
        },
        'remote-only desktop refused embedded backend startup',
      );
      throw new RemoteOnlyServerProfileRequiredError(
        startupPlan.mode === 'embedded'
          ? `Boot decision landed on embedded/${startupPlan.embeddedReason}.`
          : 'Boot decision did not land on remote mode.',
      );
    }
    if (startupPlan.mode === 'remote') {
      logger.info(
        {
          serverUrl: startupPlan.serverUrl,
          insecure: startupPlan.insecure,
        },
        'D4.a Commit 5d boot decision: remote',
      );
      if (startupPlan.insecure) {
        logger.warn(
          {
            serverUrl: startupPlan.serverUrl,
            packagedAllowInsecureRemote: DESKTOP_ALLOW_INSECURE_REMOTE,
            envAllowInsecureRemote: readAllowInsecureRemoteFlag(process.env),
          },
          'D4.a Commit 5d remote-mode boot admitted insecure http URL; see runbook §12 for production guidance',
        );
      }
    } else {
      logger.info(
        {
          reason: startupPlan.embeddedReason,
        },
        'D4.a Commit 5d boot decision: embedded',
      );
    }
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
      runtimePidRootDir: paths.runtimePidRootDir,
      agentHomeRootDir: paths.agentHomeRootDir,
      proxyConfigPath: paths.proxyConfigPath,
      controlPlaneServerUrlPath:
        startupPlan.mode === 'embedded'
          ? paths.controlPlaneServerUrlPath
          : null,
      // D5.a-3: the daemon binds its local outbound frame server here so
      // the embedded backend can dial it and speak the same outbound
      // envelope as the standalone WSS path (R4 unification). This is the
      // formal server↔daemon runtime/materialize transport; it is
      // distinct from the host-control IPC the desktop HostClient below
      // keeps using (revoke/disconnect/rotate/status).
      localOutboundSocketPath: paths.localOutboundSocketPath,
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
    // with its local host credential and attaches without main, at
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
    // D4.a Commit 5d fixup (Cindy P1-1) — dispatch via the
    // `executeBackendStartup` adapter. `loadOrCreateServerConfig`,
    // `startEmbeddedSilverhandServer`, and `writeServerConfig` are
    // all routed through `deps.startEmbeddedAndPersistConfig` ONLY
    // on the embedded arm. The remote arm calls
    // `buildRemoteBackendHandle` and never touches the legacy
    // server-config artifact.
    //
    // Production dispatch: this call only ever sees `embedded` or
    // `remote` plans. The `refuse` arm is intercepted by the
    // pre-daemon guard above (`if (startupPlan.mode === 'refuse')`)
    // which throws `ProfileUnusableError` BEFORE we get here — that
    // ordering exists so a profile classifier reject fails loud
    // before any daemon spawn / IPC subscribe / WS init runs. The
    // adapter's `refuse` arm is therefore defense-in-depth seam,
    // covered by unit tests in case a future refactor drops the
    // pre-daemon guard.
    //
    // Seam pin: `__tests__/execute-backend-startup.test.ts` — the
    // load-bearing fix for Cindy 5d-fixup P1-1.
    backend = await executeBackendStartup<
      RunningBackend,
      RemoteBackendHandle
    >(startupPlan, {
      loadOrCreateServerConfig: () => loadOrCreateServerConfig(),
      startEmbeddedAndPersistConfig: async config => {
        const running = await startEmbeddedSilverhandServer({
          dataDir: silverhandDir(),
          // The embedded arm trusts the loaded ServerConfig; runtime
          // shape is asserted by `loadOrCreateServerConfig` /
          // `ServerConfigSchema.parse` upstream.
          serverConfig: config as Awaited<
            ReturnType<typeof loadOrCreateServerConfig>
          >,
          silverhandCliLauncher: resolveSilverhandCliLauncher(),
          logger: logger ?? undefined,
          loggers: loggers ?? undefined,
          logDir: join(silverhandDir(), 'logs'),
          // D5.a-3 (A6): the embedded backend no longer receives the
          // desktop HostClient. It dials the daemon's local outbound
          // frame socket itself and speaks the same R4-unified outbound
          // envelope as standalone. The desktop HostClient is retained
          // purely for host-control IPC (revoke/disconnect/rotate-token/
          // status); it is NOT a runtime/materialize transport anymore.
          outboundSocketPath: paths.localOutboundSocketPath,
        });
        await writeServerConfig(running.context.serverConfig);
        writeFileSync(
          paths.controlPlaneServerUrlPath,
          `${running.context.serverConfig.url}\n`,
          { mode: 0o600 },
        );
        return running;
      },
      buildRemoteHandle: input => buildRemoteBackendHandle(input),
      refuse: refusePlan => {
        // Throws — typed as `(plan) => never` so the union narrows
        // for the caller. Logged on the way out so a pre-bootstrap
        // crash trace carries the same diagnosis as the embedded
        // boot's WARN line above.
        logger?.error(
          {
            profileUrl: refusePlan.profileUrl,
            classifyMessage: refusePlan.classifyMessage,
          },
          'D4.a Commit 5d-fixup executor: refuse arm reached; throwing ProfileUnusableError',
        );
        throw new ProfileUnusableError({
          mode: 'profile_invalid',
          profileUrl: refusePlan.profileUrl,
          classifyMessage: refusePlan.classifyMessage,
        });
      },
    });
    installBackendEventWsOriginOverride();
    if (!HEADLESS) {
      // D4.a Commit 5d: `hydrateDesktopSession` works on both arms —
      // it tries the persisted user session token against
      // `backendUrl(/api/me)`.
      //
      // D4.a Commit 6 fixup (Cindy P1 #task:658 follow-up):
      // validation now returns a typed three-arm union
      // (`valid` / `rejected` / `unreachable`). The wrapper still
      // returns a boolean (was-authenticated) here for the
      // bootstrap fallback below, but the `unreachable` arm keeps
      // the persisted token + daemon-host config on disk so that
      // a transient `backend_unreachable` at boot does NOT cost
      // the user a re-login. The renderer's
      // `BackendUnreachableGate` + `desktopAuthState()` recovery
      // path re-validates against the same persisted token when
      // the user clicks Retry / backend recovers.
      //
      // `bootstrapEmbeddedUserSession` is the only step gated to
      // the embedded arm: it short-circuits on remote backends
      // (no embedded-bootstrap token on disk), so calling it on
      // an unreachable remote arm is a no-op rather than a
      // re-login prompt.
      const hydrated = await hydrateDesktopSession();
      if (!hydrated) {
        await bootstrapEmbeddedUserSession();
      }
    }
    // D4.a Commit 5c-3 — boot-time partial-apply reconciliation.
    // Cindy review gate 4: trigger AFTER hostClient/backend are
    // ready (above) AND AFTER the auth-bootstrap claim attempt has
    // settled (above) — the claim path may have written a fresh
    // daemon-config so we want reconcile to see the post-claim
    // state. Fire-and-forget so the renderer doesn't block on
    // either the disk reads or a possible phase-2 IPC roundtrip.
    // bootstrap() must continue regardless: the embedded backend
    // and IPC handlers are already up; reconcile only updates the
    // banner that the renderer reads via `partialApply:get`.
    void runBootReconciliation();
  } catch (err) {
    console.error('[main] bootstrap failed:', err);
    logger?.error({ err }, 'bootstrap failed');
    throw err;
  }
}

/**
 * D4.a Commit 5c-3 — fire-and-forget reconcile at end of bootstrap.
 *
 * Pulls live profile + daemon-config snapshots, runs phase-2 if
 * there's drift, and replaces the in-memory `partialApplyState` with
 * the derived `PartialApplyState`. Logs the resulting kind so an
 * operator can correlate the launch's reconciliation outcome with
 * subsequent renderer-banner state (e.g. "user reports stuck Retry
 * button → check the boot log for `partial_apply_pending`").
 *
 * Catches all exceptions so a reconciliation bug NEVER bubbles into
 * the bootstrap promise (Cindy review gate 4: must not block
 * embedded normal startup).
 */
async function runBootReconciliation(): Promise<void> {
  try {
    const state = await reconcilePartialApplyAtBoot({
      readProfile: () =>
        readServerConnectionProfile({
          silverhandRoot: silverhandDir(),
          logger: logger ?? undefined,
        }),
      readDaemonHostConfig: () => readDaemonHostConfig(silverhandDir()),
      runPhase2: profile => runProfilePhase2(profile),
    });
    partialApplyState = state;
    if (state.kind === 'partial_apply_pending') {
      logger?.warn(
        {
          profileVersion: state.profileVersion,
          reason: state.reason,
          reloadRejectionReason: state.reloadRejectionReason,
        },
        'D4.a 5c-3 boot reconciliation: partial_apply_pending — Retry button surfaced',
      );
    } else if (state.kind === 'unusable_profile') {
      logger?.warn(
        { reason: state.reason, detail: state.detail },
        'D4.a 5c-3 boot reconciliation: unusable_profile — renderer should offer reset affordance',
      );
    } else {
      logger?.info(
        { kind: state.kind },
        'D4.a 5c-3 boot reconciliation: ok',
      );
    }
  } catch (err) {
    // Reconciliation failed unexpectedly. Leave `partialApplyState`
    // at its initial `fully_applied` so the renderer doesn't surface
    // a banner with stale info; log the error so the issue is
    // visible to operators. Re-throwing here would propagate into
    // bootstrap() because of the `void` site, but `void` swallows
    // it — keeping this try/catch makes the swallow explicit.
    logger?.error(
      { err },
      'D4.a 5c-3 boot reconciliation threw unexpectedly — leaving partialApplyState=fully_applied',
    );
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
          {
            // D4.a Commit 2 — explicit-user-action entry to the Setup
            // Wizard. Lives in the App submenu (where Settings is) so
            // it's discoverable in the same place users look for
            // configuration. No accelerator on purpose — Commit 3's
            // boot-gate will offer the same affordance from the
            // pre-auth screen, and we don't want a stray shortcut
            // popping the modal mid-conversation.
            label: 'Connect to backend…',
            click: () => openSetupWizard(),
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

/**
 * D4.a Commit 2 — analog of {@link openSettings} for the Setup Wizard.
 * Fires `navigate:setupWizard` so the renderer can mount the Wizard
 * (a modal at the App level — see `apps/desktop/src/renderer/features/setup/SetupWizard.tsx`).
 *
 * Triggered by the App menu's "Connect to backend…" item. This is the
 * **only** discovery path for the Wizard in Commit 2 — the explicit
 * boot-time decision (no profile → require Wizard) lands in Commit 3.
 *
 * The "explicit user action" trigger discipline (Cindy v2 slicing) is
 * preserved: a user has to deliberately pick the menu item; there is
 * no auto-popup, no after-first-launch nudge.
 */
function openSetupWizard(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  const win = mainWindow;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const send = (): void => {
    if (!win.isDestroyed()) win.webContents.send('navigate:setupWizard');
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

registerEventWsDiagnosticIpcHandler({ getLogger: () => logger });

ipcMain.handle('backend:info', () => {
  if (!backend) return null;
  // D4.a Commit 5d — `mode` is the union discriminator on
  // {@link BackendHandle}, not derived from the embedded-only
  // `serverConfig.mode`. Both happen to render the same string set
  // (`'embedded' | 'remote'`), so the renderer-facing `BackendInfo`
  // contract is unchanged.
  return {
    url: requireBackendUrl(),
    mode: backend.kind,
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

ipcMain.handle('hosts:proxyConfig:get', (_event, input: { hostId: string }) =>
  getHostProxyConfig(input?.hostId ?? ''),
);

ipcMain.handle(
  'hosts:proxyConfig:set',
  (_event, input: { hostId: string; config: unknown }) =>
    saveHostProxyConfig({
      hostId: input?.hostId ?? '',
      config: input?.config,
    }),
);

/**
 * D3.c Commit 3 — Settings "save server URL" entry point.
 *
 * Pipeline (full detail in `outbound-reload.ts` orchestrator):
 *   1. Validate raw input via `classifyServerUrl` (defense in
 *      depth — renderer's live validator is convenience).
 *   2. Atomically rewrite `daemon-config.json` (tmp + write +
 *      rename via `writeDaemonHostConfig`).
 *   3. Send `host_outbound_reload` IPC to the daemon.
 *   4. On `action: 'reloaded'`, start the same fresh-attach
 *      watchdog used at post-login attach time.
 *
 * Strict boundary: the renderer supplies ONLY `serverUrl`. The
 * `host_token` is read from `daemon-config.json` inside main via
 * `readDaemonHostConfig` — token bytes never cross the IPC.
 *
 * On any reload-watchdog success this also invalidates the
 * previous activeAttachWatchdog (analogous to the
 * rotate-token / re-login paths) so two polling timers don't
 * race after a save during an in-flight attach.
 */
ipcMain.handle(
  'settings:saveServerUrl',
  (_event, input: { serverUrl: string }) =>
    saveServerUrlFromSettings(input?.serverUrl ?? ''),
);

/**
 * D4.a Commit 2 — Server connection profile IPC surface.
 *
 * Pre-auth Setup Wizard / Settings UI uses these handlers to read,
 * test, and commit the on-disk server connection profile (per
 * `docs/remote-backend-architecture-notes.md §3`).
 *
 * Boundary discipline:
 *   - `profile:get` returns a redacted view (`server_url + updated_at`
 *     only). The raw profile file contents NEVER cross IPC. Schema metadata
 *     (`version`, `created_at`) stays in main.
 *   - `profile:saveWithTest` runs the validate → test-connect →
 *     commit pipeline atomically. Renderer never sees the
 *     intermediate "validated but not yet committed" state — if any
 *     step fails, nothing lands on disk and the renderer gets a
 *     typed failure with the failing phase.
 *   - `profile:clear` is the explicit reset affordance (recovery
 *     from `parse_failed` reads, and the
 *     "disconnect from remote backend" UX).
 *
 * Commit 2 scope:
 *   - No phase-2 daemon-config derivation here — that lands in
 *     Commit 5 alongside the `partial_apply_pending` state machine.
 *   - No automatic boot-time remote-mode activation — that lands in
 *     Commit 3 (boot gate).
 *   - After a successful save the renderer surfaces a manual
 *     "restart to connect" prompt; we deliberately do NOT auto-
 *     restart the app here so the user sees their action committed
 *     before the window goes away.
 */

/**
 * Result shape of `profile:saveWithTest`. Kept structurally separate
 * from the `ProbeServerInfoResult` because the renderer needs to
 * know which phase failed (test vs write).
 */
export type ProfileSaveWithTestResult =
  | {
      ok: true;
      test: ProbeServerInfoResult & { ok: true };
      profile: ServerConnectionProfileView;
      /**
       * D4.a Commit 5c-2 — phase-2 outcome from
       * `performProfilePhase2` after the profile commit succeeded
       * (`docs/remote-backend-architecture-notes.md §3`).
       *
       * Three high-level kinds; renderer copy keys off the
       * discriminator:
       *   - `fully_applied` — profile + daemon-config in sync at this
       *     generation. Sub-arms (`reloaded` / `unchanged` /
       *     `connectivity_unverified`) reflect the reload IPC's action
       *     plus post-IPC connectivity observation but all three mean
       *     "config saved + daemon swapped (or no swap needed)".
       *   - `no_op_no_host_claim` — phase-2 cannot run without a host
       *     claim (Setup Wizard pre-auth). Profile is committed; the
       *     next sign-in's `claimLocalHostForUserSession` (5c-1)
       *     stamps `profile_version` into daemon-config naturally. NOT
       *     a failure — there is nothing to reconcile.
       *   - `partial_apply_pending` — phase-2 failed at write / IPC
       *     ack. Profile is at the new version, daemon is on the old
       *     config. Renderer surfaces a banner + Retry button via the
       *     `partialApply:get` / `partialApply:retry` IPCs.
       */
      phase2: ProfilePhase2Outcome;
    }
  | {
      ok: false;
      phase: 'test';
      test: ProbeServerInfoResult & { ok: false };
    }
  | {
      // D4.a Commit 3 review fixup (Cindy P1-A) — probe succeeded
      // but the commit guard refused the URL.
      //
      // **5d note**: the guard now `{ allow: true }` for every
      // currently-supported probe success kind (loopback / system_ca /
      // insecure_dev_remote), because the bootstrap site has the
      // real remote-mode branch. The `commit_guard` failure arm is
      // therefore **structurally unreachable** in the current
      // matrix; it is kept on the type surface for forward use
      // (future TLS-policy / remote-prerequisite gates) and so
      // pre-5d binaries' renderer still understands the shape if
      // the main process is rolled back. See `evaluateProfileCommitGuard`
      // in `backend-boot-mode.ts` for the lifted policy.
      ok: false;
      phase: 'commit_guard';
      reason: 'remote_backend_not_yet_supported';
      message: string;
      /**
       * The probe result that the guard rejected. Echoed back so
       * the renderer can show "we successfully reached <host>
       * (system_ca_verified) but cannot save the URL in this build"
       * rather than implying the probe failed.
       */
      test: ProbeServerInfoResult & { ok: true };
    }
  | {
      ok: false;
      phase: 'write';
      reason: 'write_failed';
      detail?: string;
    };

/**
 * D4.a Commit 5c-2 — `partialApply:retry` outcome.
 *
 * Three branches:
 *   - `ok: true` — phase-2 ran. Echo the new state + the raw outcome
 *     so the renderer can show the right copy.
 *   - `ok: false; reason: 'no_profile'` — no profile is committed (e.g.
 *     user pressed Retry without ever saving). Caller should send
 *     them through the Wizard, not surface a generic error.
 *   - `ok: false; reason: 'profile_unreadable'` — profile file exists
 *     but read failed (`parse_failed`). 5c-2
 *     surfaces this as-is; 5c-3 reconciliation owns the typed repair
 *     state (`unusable_profile`) per Cindy's 5c-1 review note.
 */
export type PartialApplyRetryResult =
  | {
      ok: true;
      outcome: ProfilePhase2Outcome;
      state: PartialApplyState;
    }
  | {
      ok: false;
      reason: 'no_profile';
    }
  | {
      ok: false;
      reason: 'profile_unreadable';
      detail: string;
    };

/**
 * D4.a Commit 5c-2 — assemble phase-2 deps from current main process
 * state. Returns `null` when the backend or host client is not ready
 * (pre-bootstrap / mid-shutdown); callers map that to a typed failure
 * outcome so the renderer doesn't see an exception.
 *
 * Mirrors the dep-binding pattern of `saveServerUrlFromSettings` but
 * without the URL classifier (phase-2's input is a pre-validated
 * profile, not a raw URL — §7.5 contract).
 */
function buildProfilePhase2Deps(): PerformProfilePhase2Deps | null {
  const client = hostClient;
  if (!client || !backend) return null;
  const dir = silverhandDir();
  // D4.a Commit 5d — `null` on remote arm. The orchestrator's
  // `no_attachment_controller` arm surfaces a typed
  // `partial_apply_pending` so the renderer can render its banner
  // without claiming to have verified attachment from main.
  const controller = getEmbeddedHostWsController();
  return {
    allowInsecureRemote: desktopAllowsInsecureRemote(),
    writeDaemonHostConfig: config => writeDaemonHostConfig(dir, config),
    hostOutboundReload: () => client.hostOutboundReload(),
    getAttachment: bindAttachmentAccessor(controller),
    currentLocalHostId: () =>
      localHostClaim.status === 'claimed' ? localHostClaim.hostId : null,
    currentHostToken: () => readDaemonHostConfig(dir)?.host_token ?? null,
  };
}

/**
 * D4.a Commit 5c-2 — run phase-2 against the just-committed profile
 * (or the on-disk profile for the Retry path) and update the in-memory
 * `partialApplyState`. Pure orchestration — `performProfilePhase2` owns
 * the decision tree.
 */
async function runProfilePhase2(
  profile: ServerConnectionProfile,
): Promise<ProfilePhase2Outcome> {
  const deps = buildProfilePhase2Deps();
  if (!deps) {
    // Backend / host client not ready (pre-bootstrap or mid-shutdown).
    // Return `partial_apply_pending` rather than throwing so the IPC
    // handler can surface a typed result and the in-memory state
    // stays in a Retry-able shape. `no_attachment_controller` is the
    // structural-impossibility arm that matches this case (the legacy
    // outbound-reload path uses the same kind for the same reason).
    return {
      kind: 'partial_apply_pending',
      profileVersion: profile.version,
      reason: 'no_attachment_controller',
      reloadRejectionReason: null,
      detail: 'backend or host client not ready',
    };
  }
  return performProfilePhase2({ profile }, deps);
}

function applyProfileToActiveRemoteBackend(input: {
  profile: ServerConnectionProfile;
  testKind: (ProbeServerInfoResult & { ok: true })['kind'];
}): void {
  if (!backend || backend.kind !== 'remote') return;
  if (input.testKind === 'loopback_ok') return;
  const insecure = input.testKind === 'insecure_dev_remote';
  if (backend.url === input.profile.server_url && backend.insecure === insecure) {
    return;
  }

  const previousUrl = backend.url;
  backend = buildRemoteBackendHandle({
    serverUrl: input.profile.server_url,
    insecure,
  });
  installBackendEventWsOriginOverride();
  void syncEventWsSessionCookie(userSessionToken);
  logger?.info(
    {
      previousUrl,
      serverUrl: input.profile.server_url,
      insecure,
    },
    'D4.a profile:saveWithTest retargeted active remote backend handle',
  );
}

async function handleProfileSaveWithTest(
  input: { serverUrl: string } | undefined,
): Promise<ProfileSaveWithTestResult> {
  const serverUrl = (input?.serverUrl ?? '').trim();
  const allowInsecureRemote = desktopAllowsInsecureRemote();
  // Phase A — test the candidate URL against the live backend.
  const test = await probeServerInfo({ serverUrl, allowInsecureRemote });
  if (!test.ok) {
    logger?.warn(
      { kind: test.kind, serverUrl },
      'D4.a profile:saveWithTest test phase failed',
    );
    return { ok: false, phase: 'test', test };
  }
  // Phase A.5 — Commit 3 review fixup (Cindy P1-A) → 5d lift: the
  // commit guard now `allow: true` for every probe success kind
  // (the bootstrap site has the real remote-mode branch, see
  // `backend-boot-mode.ts` JSDoc). The call is kept here so future
  // TLS-policy / remote-prerequisite gates can refuse without
  // restructuring the save pipeline; today the guard is a
  // structural pass-through. The `commit_guard` failure arm of
  // `ProfileSaveWithTestResult` therefore never fires in the
  // current matrix — the renderer's `commit_guard` branch is
  // forward-compat plumbing only.
  const guard = evaluateProfileCommitGuard(test.kind);
  if (!guard.allow) {
    logger?.warn(
      { kind: test.kind, serverUrl, reason: guard.reason },
      'D4.a profile:saveWithTest commit-guard refused (forward-compat arm — should be unreachable in current 5d matrix)',
    );
    return {
      ok: false,
      phase: 'commit_guard',
      reason: guard.reason,
      message: guard.message,
      test,
    };
  }
  // Phase B — commit profile. The probe already classified `serverUrl`
  // and the §7.1 origin-only invariant guarantees the canonical
  // persistable form is `test.originUrl` (= `new URL(serverUrl).origin`).
  // We persist that, NOT the raw string (closes Cindy D4.a Commit 2
  // review nit — `server-url.ts` JSDoc previously said the writer
  // "tests and persists `${parsed.origin}`" but main passed the raw
  // string through; the two statements are now reconciled). Every
  // downstream desktop transport reads `server_url` from the persisted
  // profile, so canonicalizing once at write time means the rest of
  // the system never sees the un-canonicalized round-trip.
  const writeResult = writeServerConnectionProfile({
    silverhandRoot: silverhandDir(),
    serverUrl: test.originUrl,
    logger: logger ?? undefined,
  });
  if (!writeResult.ok) {
    logger?.warn(
      { reason: writeResult.reason, serverUrl },
      'D4.a profile:saveWithTest write phase failed',
    );
    return {
      ok: false,
      phase: 'write',
      reason: writeResult.reason,
      detail: 'detail' in writeResult ? writeResult.detail : undefined,
    };
  }
  logger?.info(
    {
      serverUrl,
      classification: test.kind,
      profileVersion: writeResult.profile.version,
    },
    'D4.a profile:saveWithTest committed',
  );
  // Phase 2 — derive daemon-config + reload (§7.5). Failures land on
  // disk only as `partial_apply_pending` in-memory state; the profile
  // commit above is already durable so we never roll it back.
  const phase2 = await runProfilePhase2(writeResult.profile);
  applyProfileToActiveRemoteBackend({
    profile: writeResult.profile,
    testKind: test.kind,
  });
  partialApplyState = derivePartialApplyState(phase2, Date.now());
  if (phase2.kind === 'partial_apply_pending') {
    logger?.warn(
      {
        profileVersion: phase2.profileVersion,
        reason: phase2.reason,
        reloadRejectionReason: phase2.reloadRejectionReason,
      },
      'D4.a profile:saveWithTest phase-2 partial_apply_pending',
    );
  } else if (phase2.kind === 'fully_applied') {
    logger?.info(
      {
        profileVersion: phase2.profileVersion,
        reloadKind: phase2.reloadKind,
        elapsedMs: phase2.elapsedMs,
      },
      'D4.a profile:saveWithTest phase-2 fully_applied',
    );
  } else {
    logger?.info(
      { profileVersion: phase2.profileVersion },
      'D4.a profile:saveWithTest phase-2 no_op_no_host_claim (pre-auth)',
    );
  }
  return {
    ok: true,
    test,
    profile: redactServerConnectionProfile(writeResult.profile),
    phase2,
  };
}

/**
 * D4.a Commit 5c-2 — Retry handler for `partial_apply_pending`.
 *
 * Re-reads the on-disk profile (it may have changed via another path
 * since the last attempt), runs phase-2, updates the in-memory state.
 *
 * Why re-read instead of caching the profile object: the renderer can
 * trigger Retry minutes after the failed save, and another window /
 * IPC could have committed a newer profile in the meantime. Reading
 * fresh keeps Retry idempotent against the latest committed state.
 *
 * Profile read failure now (5c-3) ALSO mutates `partialApplyState`
 * to `unusable_profile` so the renderer banner reflects the latest
 * known repair state, not the stale `partial_apply_pending` from
 * before. The typed `profile_unreadable` retry outcome carries the
 * detail to the caller; the state mutation is the side-effect.
 *
 * `not_found` (no profile committed) returns `no_profile` retry
 * outcome AND mutates state to `no_profile` — same idea, the user
 * may have just cleared the profile via `profile:clear` and the
 * Retry button shouldn't pretend there's something to retry.
 */
async function handlePartialApplyRetry(): Promise<PartialApplyRetryResult> {
  const read = readServerConnectionProfile({
    silverhandRoot: silverhandDir(),
    logger: logger ?? undefined,
  });
  if (!read.ok) {
    if (read.reason === 'not_found') {
      logger?.warn(
        {},
        'D4.a partialApply:retry — no committed profile (renderer triggered without a save)',
      );
      // 5c-3: mutate state to match the on-disk reality. If the
      // profile was cleared between the failed save and the retry,
      // the previous `partial_apply_pending` banner is no longer
      // accurate.
      partialApplyState = { kind: 'no_profile' };
      return { ok: false, reason: 'no_profile' };
    }
    // parse_failed — typed
    // repair state. 5c-3 reconciliation produces the same
    // `unusable_profile` from the same on-disk read. We mutate
    // `partialApplyState` here so the renderer banner shows the
    // reset affordance immediately after a failed Retry, not only
    // after the next launch.
    const detail = read.detail;
    logger?.warn(
      { reason: read.reason, detail },
      'D4.a partialApply:retry — profile read failed → unusable_profile state',
    );
    partialApplyState = {
      kind: 'unusable_profile',
      reason: read.reason,
      detail,
      lastReadAt: Date.now(),
    };
    return { ok: false, reason: 'profile_unreadable', detail };
  }
  const outcome = await runProfilePhase2(read.profile);
  partialApplyState = derivePartialApplyState(outcome, Date.now());
  if (outcome.kind === 'partial_apply_pending') {
    logger?.warn(
      {
        profileVersion: outcome.profileVersion,
        reason: outcome.reason,
        reloadRejectionReason: outcome.reloadRejectionReason,
      },
      'D4.a partialApply:retry — still partial_apply_pending',
    );
  } else {
    logger?.info(
      { kind: outcome.kind, profileVersion: outcome.profileVersion },
      'D4.a partialApply:retry — phase-2 succeeded',
    );
  }
  return { ok: true, outcome, state: partialApplyState };
}

ipcMain.handle(
  'profile:get',
  (): ServerConnectionProfileView | null =>
    readServerConnectionProfileViewOrNull({
      silverhandRoot: silverhandDir(),
      logger: logger ?? undefined,
    }),
);

ipcMain.handle(
  'profile:saveWithTest',
  (_event, input: { serverUrl: string }) => handleProfileSaveWithTest(input),
);

ipcMain.handle('profile:clear', () => {
  const result = clearServerConnectionProfile({
    silverhandRoot: silverhandDir(),
    logger: logger ?? undefined,
  });
  if (result.ok) {
    // D4.a Commit 5c-3 P2 (Cindy review) — `no_profile` is defined
    // as "profile:clear has been invoked / there is no on-disk
    // profile". Sync the in-memory state synchronously so the
    // renderer banner stops showing a stale `partial_apply_pending`
    // / `unusable_profile` after a successful clear. Both
    // `cleared: true` and `cleared: false` mean the file is now
    // absent — `no_profile` is correct in both. On failure
    // (`unlink_failed`), leave state alone: the file may still
    // exist and the previous diagnosis is still the truthful one.
    partialApplyState = { kind: 'no_profile' };
  }
  return result;
});

/**
 * D4.a Commit 5c-2 — partial_apply_pending IPC surface.
 *
 * `partialApply:get` returns the current in-memory state; the
 * renderer reads on settings-pane mount + after every relevant
 * mutation (profile save, login completion, etc.).
 *
 * `partialApply:retry` re-runs phase-2 against the on-disk profile.
 * No input — Retry always targets the current committed profile. See
 * `handlePartialApplyRetry` for the semantics around profile read
 * failures vs absence.
 */
ipcMain.handle(
  'partialApply:get',
  (): PartialApplyState => partialApplyState,
);

ipcMain.handle(
  'partialApply:retry',
  (): Promise<PartialApplyRetryResult> => handlePartialApplyRetry(),
);


registerSurfaceIpcHandlers({
  setActiveConversation(next) {
    activeConversation = next;
  },
  pushActiveConversationToEvents,
});
registerSelectionExportIpcHandlers();

app.whenReady().then(async () => {
  await bootstrap();
  if (HEADLESS) {
    // One-line machine-readable handshake on stdout. Test scripts pipe
    // and JSON.parse this. Human-readable extras go to stderr below.
    //
    // D4.a Commit 5d — HEADLESS is an embedded-only mode. The whole
    // point is "boot the backend without a window for smoke tests";
    // a remote backend has nothing to expose locally on this code
    // path. Typed-fail loudly if a regression boots HEADLESS with a
    // remote profile (e.g. CI accidentally inherits `server-profile.bin`).
    const embedded = requireEmbeddedBackend('HEADLESS handshake (SILVERHAND_HEADLESS=1)');
    process.stdout.write(
      JSON.stringify({
        url: embedded.url,
        port: embedded.port,
        bootstrap_token_path: embedded.context.embeddedBootstrap.enabled
          ? embedded.context.embeddedBootstrap.filePath
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
      // Take the controller ONCE; only inject the accessor if it's
      // actually available. A `null` controller (registry already
      // torn down, embedded backend never booted, or the desktop is
      // in remote mode where there is no in-process registry to
      // observe) must NOT be smuggled through as a zero-arg
      // accessor that returns null — the helper would then
      // interpret that as "registry cleared successfully" instead
      // of the truthful "we couldn't observe the registry at all"
      // (Cindy #task:630 P1-A).
      //
      // D4.a Commit 5d: on the remote arm `getEmbeddedHostWsController()`
      // returns `null`, so the detach helper runs RPC-only — exactly
      // the right thing (the WS attachment registry lives on the
      // remote backend and the daemon's outbound socket close is
      // observed there, not from main).
      const hostWsController = getEmbeddedHostWsController();
      const getAttachment = hostWsController
        ? (hostId: string) => hostWsController.getAttachment(hostId)
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
          registry_error: detachOutcome.registryError ?? null,
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
      // D4.a Commit 5d — `close()` exists on both arms. Embedded
      // owns a Hono server / runtime host / scheduler; remote's
      // `close()` is a no-op (nothing to tear down — the server is
      // remote, daemon + hostClient teardown happen below).
      await (backend.kind === 'embedded' ? backend.running.close() : backend.close());
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
