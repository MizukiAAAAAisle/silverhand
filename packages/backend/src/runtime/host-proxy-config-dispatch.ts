import type {
  HostProxyConfig,
  HostProxyConfigGetResult,
  HostProxyConfigSetParams,
} from '@silverhand/host';
import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';
import {
  mapDataPlaneError,
  resolveOutboundForHost,
  type DataPlaneFailure,
} from './workspace-data-plane.js';

const HOST_PROXY_CONFIG_TIMEOUT_MS = 10_000;

export type HostProxyConfigOutcome =
  | { kind: 'ok'; config: HostProxyConfig }
  | DataPlaneFailure;

export async function dispatchHostProxyConfigGet(
  adapter: OutboundFrameAdapter | null,
  hostId: string,
): Promise<HostProxyConfigOutcome> {
  const resolved = resolveOutboundForHost(adapter, hostId);
  if (resolved.kind === 'failed') return resolved;

  try {
    const result: HostProxyConfigGetResult = await resolved.adapter.sendCommand(
      hostId,
      'host_proxy_config_get',
      {},
      {
        timeoutMs: HOST_PROXY_CONFIG_TIMEOUT_MS,
        expectedConnectionId: resolved.connectionId,
      },
    );
    return { kind: 'ok', config: result.config };
  } catch (err) {
    return mapDataPlaneError(err);
  }
}

export async function dispatchHostProxyConfigSet(
  adapter: OutboundFrameAdapter | null,
  hostId: string,
  config: HostProxyConfigSetParams,
): Promise<HostProxyConfigOutcome> {
  const resolved = resolveOutboundForHost(adapter, hostId);
  if (resolved.kind === 'failed') return resolved;

  try {
    const result = await resolved.adapter.sendCommand(
      hostId,
      'host_proxy_config_set',
      config,
      {
        timeoutMs: HOST_PROXY_CONFIG_TIMEOUT_MS,
        expectedConnectionId: resolved.connectionId,
      },
    );
    return { kind: 'ok', config: result.config };
  } catch (err) {
    return mapDataPlaneError(err);
  }
}
