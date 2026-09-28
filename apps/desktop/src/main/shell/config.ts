import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { ServerConfigSchema, type ServerConfig } from "@silverhand/shared";
import {
  appRootEnvOverride,
  defaultAppRoot,
  resolveDesktopAppPaths,
  type DesktopAppPaths,
} from "@silverhand/shared/app-data-layout";

const PersistedServerConfigSchema = ServerConfigSchema.omit({
  auth_token: true,
  event_ws_allowed_origins: true,
});

export function silverhandDir(): string {
  return defaultAppRoot(process.env, homedir);
}

export function shouldRedirectElectronUserData(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return appRootEnvOverride(env) !== null;
}

export function desktopAppPaths(): DesktopAppPaths {
  return resolveDesktopAppPaths(silverhandDir());
}

export function electronUserDataPath(silverhandRoot = silverhandDir()): string {
  return resolveDesktopAppPaths(silverhandRoot).desktop.electronUserData;
}

export async function loadOrCreateServerConfig(): Promise<ServerConfig> {
  const filepath = desktopAppPaths().embeddedServer.serverConfig;

  try {
    const raw = await fs.readFile(filepath, "utf8");
    const parsed = ServerConfigSchema.parse(JSON.parse(raw));
    return parsed;
  } catch {
    const fresh: ServerConfig = {
      mode: "embedded",
      url: "http://127.0.0.1:0",
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
  const destination = paths.embeddedServer.serverConfig;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Clear transient endpoint availability while retaining durable user configuration. */
export async function invalidateEmbeddedServerUrl(snapshot?: ServerConfig): Promise<void> {
  const config = snapshot ?? (await loadOrCreateServerConfig());
  await writeServerConfig({ ...config, url: "http://127.0.0.1:0" });
}

export function databasePath(): string {
  return desktopAppPaths().embeddedServer.database;
}
