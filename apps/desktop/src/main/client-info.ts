import { app } from "electron";
import {
  serializeClientInfoHeader,
  DESKTOP_SERVER_API_EPOCH,
  MINIMUM_SERVER_API_EPOCH,
  type ClientInfo,
  type ClientDeployment,
} from "@silverhand/shared";
import { DESKTOP_REMOTE_ONLY } from "../build-flags.js";
import { loadOrCreateInstallationId } from "./local-host-claim.js";
import { BUILD_COMMIT, BUILD_DIRTY } from "./build-metadata.js";

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
    const deployment: ClientDeployment = DESKTOP_REMOTE_ONLY ? "remote-only" : "embedded";
    const info: ClientInfo = {
      client_surface: "desktop",
      deployment,
      app_version: app.getVersion(),
      build_commit: BUILD_COMMIT,
      build_dirty: BUILD_DIRTY,
      platform: process.platform,
      arch: process.arch,
      installation_id: loadOrCreateInstallationId(installationIdPath),
      desktop_api_epoch: DESKTOP_SERVER_API_EPOCH,
      minimum_server_api_epoch: MINIMUM_SERVER_API_EPOCH,
    };
    cachedHeaderValue = serializeClientInfoHeader(info);
  } catch (err) {
    logger?.warn({ err }, "failed to assemble desktop client-info telemetry header");
    cachedHeaderValue = null;
  }
  return cachedHeaderValue;
}

/** Test-only: reset the per-process memo. */
export function resetDesktopClientInfoHeaderCacheForTest(): void {
  cachedHeaderValue = undefined;
}
