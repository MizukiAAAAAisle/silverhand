import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ComputerProfileBinding {
  host_id: string;
}

export function defaultSilverhandStateRoot(): string {
  return join(homedir(), '.silverhand');
}

export function computerProfileDir(
  binding: ComputerProfileBinding,
  silverhandStateRoot = defaultSilverhandStateRoot(),
): string {
  return join(silverhandStateRoot, 'computers', safePathId(binding.host_id));
}

export function computerProxyConfigPath(
  binding: ComputerProfileBinding,
  silverhandStateRoot = defaultSilverhandStateRoot(),
): string {
  return join(computerProfileDir(binding, silverhandStateRoot), 'proxy-config.json');
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
