import type { RuntimeCatalogResponse } from '@silverhand/shared';
import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';
import {
  mapDataPlaneError,
  resolveOutboundForHost,
  type DataPlaneFailure,
} from './workspace-data-plane.js';

const HOST_RUNTIME_CATALOG_TIMEOUT_MS = 45_000;

export type HostRuntimeCatalogOutcome =
  | { kind: 'ok'; catalog: RuntimeCatalogResponse }
  | DataPlaneFailure;

export async function dispatchHostRuntimeCatalog(
  adapter: OutboundFrameAdapter | null,
  hostId: string,
  params: { force?: boolean } = {},
): Promise<HostRuntimeCatalogOutcome> {
  const resolved = resolveOutboundForHost(adapter, hostId);
  if (resolved.kind === 'failed') return resolved;

  try {
    const result = await resolved.adapter.sendCommand(
      hostId,
      'host_runtime_catalog',
      { force: params.force === true },
      {
        timeoutMs: HOST_RUNTIME_CATALOG_TIMEOUT_MS,
        expectedConnectionId: resolved.connectionId,
      },
    );
    return { kind: 'ok', catalog: result };
  } catch (err) {
    return mapDataPlaneError(err);
  }
}
