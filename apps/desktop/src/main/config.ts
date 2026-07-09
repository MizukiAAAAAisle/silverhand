import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  SERVER_CONFIG_FILENAME,
  ServerConfigSchema,
  type ServerConfig,
} from '@silverhand/shared';

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
  return process.env.SILVERHAND_DIR || join(homedir(), '.silverhand');
}

export function electronUserDataPath(silverhandRoot = silverhandDir()): string {
  return join(silverhandRoot, 'desktop', 'electron-user-data');
}

export async function loadOrCreateServerConfig(): Promise<ServerConfig> {
  const dir = silverhandDir();
  const filepath = join(dir, SERVER_CONFIG_FILENAME);

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
  const dir = silverhandDir();
  await fs.mkdir(dir, { recursive: true });
  const filepath = join(dir, SERVER_CONFIG_FILENAME);
  const persisted = PersistedServerConfigSchema.parse(config);
  await fs.writeFile(filepath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
}

export function databasePath(): string {
  return join(silverhandDir(), 'silverhand.db');
}
