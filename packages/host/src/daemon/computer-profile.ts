import { createHash } from 'node:crypto';
import {
  computersRootDir,
  homeAppRoot,
  resolveComputerDataPaths,
} from '@silverhand/shared/app-data-layout';
import { join } from 'node:path';

export interface ComputerProfileBinding {
  host_id: string;
}

export function defaultSilverhandStateRoot(): string {
  // #task:1598 — env-INDEPENDENT by historical contract: connect profile
  // roots never consulted SILVERHAND_DIR (see homeAppRoot).
  return homeAppRoot();
}

export function computerProfileDir(
  binding: ComputerProfileBinding,
  silverhandStateRoot = defaultSilverhandStateRoot(),
): string {
  return join(computersRootDir(silverhandStateRoot), safePathId(binding.host_id));
}

export function computerProxyConfigPath(
  binding: ComputerProfileBinding,
  silverhandStateRoot = defaultSilverhandStateRoot(),
): string {
  return resolveComputerDataPaths(
    computerProfileDir(binding, silverhandStateRoot),
  ).proxyConfig;
}

export function defaultConnectDataRoot(
  hostId: string,
  silverhandStateRoot = defaultSilverhandStateRoot(),
): string {
  return computerProfileDir({ host_id: hostId }, silverhandStateRoot);
}

function safePathId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || shortHash(value);
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
