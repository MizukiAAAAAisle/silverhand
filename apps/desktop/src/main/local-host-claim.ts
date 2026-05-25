import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DAEMON_HOST_CONFIG_FILENAME,
  DaemonHostConfigSchema,
  HostClaimOrCreateInputSchema,
  INSTALLATION_ID_FILENAME,
  apiPaths,
  type DaemonHostConfig,
  type HostClaimOrCreateInput,
} from '@silverhand/shared';
import { z } from 'zod';

const InstallationIdSchema = z.string().uuid();

export type LocalHostClaimStatus =
  | { status: 'unclaimed'; hostId: null }
  | { status: 'claimed'; hostId: string }
  | { status: 'revoked'; hostId: string | null }
  | { status: 'error'; hostId: string | null };

export function installationIdPath(silverhandDir: string): string {
  return join(silverhandDir, INSTALLATION_ID_FILENAME);
}

export function daemonHostConfigPath(silverhandDir: string): string {
  return join(silverhandDir, DAEMON_HOST_CONFIG_FILENAME);
}

export function loadOrCreateInstallationId(silverhandDir: string): string {
  const path = installationIdPath(silverhandDir);
  if (existsSync(path)) {
    const parsed = InstallationIdSchema.safeParse(readFileSync(path, 'utf8').trim());
    if (parsed.success) return parsed.data;
  }

  const installationId = randomUUID();
  writeSecretFile(path, `${installationId}\n`);
  return installationId;
}

export function readDaemonHostConfig(
  silverhandDir: string,
): DaemonHostConfig | null {
  const path = daemonHostConfigPath(silverhandDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = DaemonHostConfigSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')) as unknown,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeDaemonHostConfig(
  silverhandDir: string,
  config: DaemonHostConfig,
): void {
  const parsed = DaemonHostConfigSchema.parse(config);
  writeSecretFile(
    daemonHostConfigPath(silverhandDir),
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
}

export function removeDaemonHostConfig(silverhandDir: string): void {
  try {
    unlinkSync(daemonHostConfigPath(silverhandDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function buildHostClaimInput(input: {
  installationId: string;
  existingConfig: DaemonHostConfig | null;
  label?: string;
}): HostClaimOrCreateInput {
  return HostClaimOrCreateInputSchema.parse({
    installation_id: input.installationId,
    label: input.label ?? hostname(),
    ...(input.existingConfig
      ? { current_host_id: input.existingConfig.host_id }
      : {}),
  });
}

export function isTokenBearingHostClaimPath(path: string): boolean {
  return path === apiPaths.hostClaimOrCreate;
}

function writeSecretFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup only.
    }
    throw err;
  }
}
