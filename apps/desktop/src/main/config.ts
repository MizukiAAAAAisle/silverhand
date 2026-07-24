import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  ServerConfigSchema,
  type ServerConfig,
} from '@silverhand/shared';
import {
  appRootEnvOverride,
  defaultAppRoot,
  resolveDesktopAppPaths,
  type DesktopAppPaths,
  type DesktopLayoutVersion,
} from '@silverhand/shared/app-data-layout';

// `event_ws_allowed_origins` is NEVER persisted. For embedded it is a
// GENERATED value — the current boot's finalized loopback origin, re-seeded
// fresh by `startBackend` every launch (#task:1428). Persisting it would let a
// stale origin from an earlier port survive into the next boot's allowlist
// (trusting a loopback the app no longer listens on), turning "trust the
// current origin" into "accumulate every historical origin". Omit it so the
// on-disk config carries only durable settings; the allowlist is always
// derived, never inherited. (`auth_token` is omitted as a secret.)
const PersistedServerConfigSchema = ServerConfigSchema.omit({
  auth_token: true,
  event_ws_allowed_origins: true,
});

export function silverhandDir(): string {
  return defaultAppRoot(process.env, homedir);
}

/**
 * #task:1603 (Cindy P1) — the Electron userData redirect gate must use
 * the SAME presence judgment as the root value: a whitespace-only
 * SILVERHAND_DIR is unset, so it must not redirect userData while the
 * app root itself falls back to home.
 */
export function shouldRedirectElectronUserData(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return appRootEnvOverride(env) !== null;
}

/**
 * #task:1598/#task:1603 — the desktop process's resolved app-data paths,
 * produced by the ONE path authority (`resolveDesktopAppPaths`). The
 * layout version starts at `legacy-v1` and is flipped to `v2` exactly
 * once per process by `initializeDesktopLayoutVersion` after the startup
 * migration reads/writes the data-layout marker. All main-process path
 * consumers read from here instead of joining off the root themselves.
 */
let activeLayoutVersion: DesktopLayoutVersion = 'legacy-v1';

export function initializeDesktopLayoutVersion(
  version: DesktopLayoutVersion,
): void {
  activeLayoutVersion = version;
}

export function desktopAppPaths(): DesktopAppPaths {
  return resolveDesktopAppPaths(silverhandDir(), activeLayoutVersion);
}

export function electronUserDataPath(silverhandRoot = silverhandDir()): string {
  return resolveDesktopAppPaths(silverhandRoot, 'legacy-v1').desktop
    .electronUserData;
}

export async function loadOrCreateServerConfig(): Promise<ServerConfig> {
  const filepath = desktopAppPaths().embeddedServer.serverConfig;

  try {
    const raw = await fs.readFile(filepath, 'utf8');
    const parsed = ServerConfigSchema.parse(JSON.parse(raw));
    return parsed;
  } catch {
    const fresh: ServerConfig = {
      mode: 'embedded',
      url: 'http://127.0.0.1:0',
      refresh_token: null,
      child_sessions: {
        max_concurrent_per_parent: null,
        spawn_cooldown_seconds: null,
        max_depth: 1,
      },
    };
    await writeServerConfig(fresh);
    return fresh;
  }
}

export async function writeServerConfig(config: ServerConfig): Promise<void> {
  const paths = desktopAppPaths();
  await fs.mkdir(dirname(paths.embeddedServer.serverConfig), { recursive: true });
  const persisted = PersistedServerConfigSchema.parse(config);
  await fs.writeFile(paths.embeddedServer.serverConfig, JSON.stringify(persisted, null, 2), { mode: 0o600 });
}

export function databasePath(): string {
  return desktopAppPaths().embeddedServer.database;
}
