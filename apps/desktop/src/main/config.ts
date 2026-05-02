import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  SERVER_CONFIG_FILENAME,
  ServerConfigSchema,
  type ServerConfig,
} from '@silverhand/shared';

export function silverhandDir(): string {
  return process.env.SILVERHAND_DIR || join(homedir(), '.silverhand');
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
      auth_token: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      user_id: null,
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
  await fs.writeFile(filepath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function databasePath(): string {
  return join(silverhandDir(), 'silverhand.db');
}
