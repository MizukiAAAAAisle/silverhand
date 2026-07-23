import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  ServerConfigSchema,
  type ServerConfig,
} from '@silverhand/shared';
import {
  defaultAppRoot,
  resolveDesktopAppPaths,
  type DesktopAppPaths,
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
 * #task:1598 — the desktop process's resolved app-data paths, produced by
 * the ONE path authority (`resolveDesktopAppPaths`) pinned to `legacy-v1`
 * (byte-identical to the historical flat layout; the v2 migration flips
 * the version in a later release). All main-process path consumers read
 * from here instead of joining off the root themselves.
 */
export function desktopAppPaths(): DesktopAppPaths {
  return resolveDesktopAppPaths(silverhandDir(), 'legacy-v1');
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
