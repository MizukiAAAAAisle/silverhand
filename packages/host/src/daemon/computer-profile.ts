import { defaultAppRoot, resolveComputerSlotPaths } from '@silverhand/shared/app-data-layout';

export interface ComputerProfileBinding {
  host_id: string;
}

export function defaultSilverhandStateRoot(): string {
  // #task:1603 — env-AWARE since the v2 cutover: connect profile roots
  // follow SILVERHAND_DIR like every other default (contract §8). An
  // explicit --data-root always wins over this default.
  return defaultAppRoot();
}

// #task:1608 — thin bindings over the shared slot resolver; the path SHAPE
// (computers/<safeComputerDirId(host_id)>) has exactly one authority.

export function computerProfileDir(
  binding: ComputerProfileBinding,
  silverhandStateRoot = defaultSilverhandStateRoot(),
): string {
  return resolveComputerSlotPaths(silverhandStateRoot, binding.host_id).root;
}

export function computerProxyConfigPath(
  binding: ComputerProfileBinding,
  silverhandStateRoot = defaultSilverhandStateRoot(),
): string {
  return resolveComputerSlotPaths(silverhandStateRoot, binding.host_id).proxyConfig;
}

export function defaultConnectDataRoot(
  hostId: string,
  silverhandStateRoot = defaultSilverhandStateRoot(),
): string {
  return computerProfileDir({ host_id: hostId }, silverhandStateRoot);
}
