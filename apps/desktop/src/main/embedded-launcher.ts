import type { ChildProcess } from 'node:child_process';
import { spawn as spawnChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm as fsRm } from 'node:fs/promises';

import {
  composeRustBackendChildEnv,
  startEmbeddedRustBackend,
  type EmbeddedRustBackendConfig,
  type EmbeddedRustBackendDeps,
  type EmbeddedRustBackendHandle,
} from './embedded-rust-backend.js';
import { fetchServerInfoWithRetry } from './fetch-server-info.js';
import { prepareEmbeddedStartup } from './embedded-startup-preparation.js';
import {
  productionSidecarDeps,
  resolveBackendSidecarManifestPath,
  verifySidecar,
  type VerifiedSidecar,
} from './rust-backend-sidecar.js';

/** A minimal logger shape (the desktop `FileLogger` satisfies it). */
interface SeamLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

export function startDesktopEmbeddedBackend(
  location: { isPackaged: boolean; resourcesPath: string; appPath: string },
  config: EmbeddedRustBackendConfig,
  logger: SeamLogger | undefined,
): Promise<EmbeddedRustBackendHandle> {
  const deps = productionEmbeddedRustBackendDeps(logger);
  return prepareEmbeddedStartup({
    cleanupTokens: () => deps.removeBootstrapToken(config.bootstrapTokenPath),
    verify: () => resolveAndVerifyEmbeddedSidecar(location),
    launch: sidecar => startEmbeddedRustBackend(sidecar, {
      ...config,
      migrationPermission: process.env.SILVERHAND_MIGRATE,
    }, deps),
  });
}

/** Resolve + verify the packaged sidecar (manifest target/arch + containment + SHA-256)
 * before spawn. Throws a typed `SidecarVerificationError` on any discrepancy. */
export async function resolveAndVerifyEmbeddedSidecar(location: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): Promise<VerifiedSidecar> {
  return verifySidecar(
    resolveBackendSidecarManifestPath(location),
    productionSidecarDeps(),
  );
}

/**
 * The production dependency set for the launcher: the real child spawn (stdout PIPED for
 * the startup frame; stderr inherited), an HTTP `/readyz` probe + `/api/server/info` epoch
 * probe (both AbortSignal-cancelable), a random per-spawn generation, best-effort token
 * removal, a real clock, and the desktop logger.
 */
function productionEmbeddedRustBackendDeps(
  logger: SeamLogger | undefined,
): EmbeddedRustBackendDeps {
  return {
    spawn: (executablePath, env): ChildProcess => {
      // #task:2343 — SINGLE path authority + closed env allowlist: `composeRustBackendChildEnv`
      // forwards only an OS allowlist plus the launcher-owned boundary (no bare
      // `SILVERHAND_DIR`, no unknown `SILVERHAND_*`, no creds/injection vectors).
      const childEnv = composeRustBackendChildEnv(env, process.env);
      return spawnChildProcess(executablePath, [], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    },
    probeReadyz: async (url, signal) => {
      try {
        const res = await fetch(new URL('/readyz', url).toString(), { signal });
        return res.status === 200;
      } catch {
        return false;
      }
    },
    probeServerInfoEpoch: async (url, signal) => {
      try {
        const info = await fetchServerInfoWithRetry({
          url: new URL('/api/server/info', url).toString(),
          signal,
        });
        if (!info.desktop_api) return null;
        return {
          currentEpoch: info.desktop_api.current_epoch,
          minimumClientEpoch: info.desktop_api.minimum_client_epoch,
        };
      } catch {
        return null;
      }
    },
    mintGeneration: () => randomUUID(),
    removeBootstrapToken: async path => {
      await fsRm(path, { force: true });
      await fsRm(`${path}.tmp`, { force: true });
    },
    clock: {
      now: () => Date.now(),
      sleep: ms =>
        new Promise(resolve => {
          setTimeout(resolve, ms);
        }),
    },
    logger,
  };
}
