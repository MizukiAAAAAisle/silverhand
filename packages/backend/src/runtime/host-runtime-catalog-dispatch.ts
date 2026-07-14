import type { RuntimeCatalogResponse } from '@silverhand/shared';
import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';
import {
  mapDataPlaneError,
  resolveOutboundForHost,
  type DataPlaneFailure,
} from './workspace-data-plane.js';

const HOST_RUNTIME_CATALOG_TIMEOUT_MS = 45_000;

export type HostRuntimeCatalogOutcome =
  | { kind: 'ok'; catalog: RuntimeCatalogResponse; connectionId: string }
  | DataPlaneFailure;

export async function dispatchHostRuntimeCatalog(
  adapter: OutboundFrameAdapter | null,
  hostId: string,
  params: { force?: boolean; expectedConnectionId?: string } = {},
): Promise<HostRuntimeCatalogOutcome> {
  const resolved = resolveOutboundForHost(adapter, hostId);
  if (resolved.kind === 'failed') return resolved;

  // Pin to a caller-supplied generation when given (create-agent's
  // evidence-generation custody, #task:1486 P1-4): the catalog proof must come
  // from the SAME connection the caller will reserve/materialize on. A
  // replacement mid-request surfaces as a transport failure via the
  // `expectedConnectionId` guard rather than a cross-generation proof.
  const connectionId = params.expectedConnectionId ?? resolved.connectionId;

  try {
    const result = await resolved.adapter.sendCommand(
      hostId,
      'host_runtime_catalog',
      { force: params.force === true },
      {
        timeoutMs: HOST_RUNTIME_CATALOG_TIMEOUT_MS,
        expectedConnectionId: connectionId,
      },
    );
    return { kind: 'ok', catalog: result, connectionId };
  } catch (err) {
    return mapDataPlaneError(err);
  }
}
