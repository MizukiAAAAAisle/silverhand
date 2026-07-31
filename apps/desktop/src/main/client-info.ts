import { app } from 'electron';
import {
  serializeClientInfoHeader,
  DESKTOP_SERVER_API_EPOCH,
  MINIMUM_SERVER_API_EPOCH,
  type ClientInfo,
  type ClientDeployment,
} from '@silverhand/shared';
import { DESKTOP_REMOTE_ONLY } from '../build-flags.js';
import { loadOrCreateInstallationId } from './local-host-claim.js';
import { BUILD_COMMIT, BUILD_DIRTY } from './build-metadata.js';

/**
 * #task:1530 — assemble the desktop release-telemetry header value the main
 * process injects onto the authenticated event-WS upgrade.
 *
 * Build metadata is static per launch, so the serialized value is memoized. This
 * is fail-open on the CLIENT side too: if anything (installation-id IO, a version
 * string the bounded schema rejects) throws, we return `null` and the caller
 * simply omits the header — telemetry must NEVER break the WS connection.
 */
let cachedHeaderValue: string | null | undefined;

export interface ClientInfoLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

export function desktopClientInfoHeaderValue(
  installationIdPath: string,
  logger?: ClientInfoLogger | null,
): string | null {
  if (cachedHeaderValue !== undefined) return cachedHeaderValue;
  try {
    const deployment: ClientDeployment = DESKTOP_REMOTE_ONLY ? 'remote-only' : 'embedded';
    const info: ClientInfo = {
      client_surface: 'desktop',
      deployment,
      app_version: app.getVersion(),
      build_commit: BUILD_COMMIT,
      build_dirty: BUILD_DIRTY,
      platform: process.platform,
      arch: process.arch,
      installation_id: loadOrCreateInstallationId(installationIdPath),
      // #task:1761 — desktop↔server API epoch range compiled into this build.
      // Carried on BOTH the REST proxy requests and the event-WS upgrade so
      // server-side admission has one uniform source.
      desktop_api_epoch: DESKTOP_SERVER_API_EPOCH,
      minimum_server_api_epoch: MINIMUM_SERVER_API_EPOCH,
    };
    cachedHeaderValue = serializeClientInfoHeader(info);
  } catch (err) {
    logger?.warn({ err }, 'failed to assemble desktop client-info telemetry header');
    cachedHeaderValue = null;
  }
  return cachedHeaderValue;
}

/** Test-only: reset the per-process memo. */
export function resetDesktopClientInfoHeaderCacheForTest(): void {
  cachedHeaderValue = undefined;
}
