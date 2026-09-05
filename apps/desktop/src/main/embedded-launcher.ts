// #task:2343 P0-10 — the embedded-backend SEAM. This is the SINGLE module the Desktop
// main statically imports for ALL embedded-only runtime surface:
//   - explicit configuration for the Rust-owned database startup,
//   - the out-of-process Rust launcher (`startEmbeddedRustBackend` + env composer),
//   - the sidecar verifier (`verifySidecar` + manifest resolution),
//   - the production dependency factory that binds the real child spawn + HTTP probes.
//
// Routing every embedded value through this one module lets the REMOTE-ONLY build ALIAS it
// to a throwing stub (`embedded-launcher.remote-only.ts`), so a remote-only package's main
// module graph contains NO import of `@silverhand/backend` (→ no `better-sqlite3`), NO
// embedded launcher, and NO sidecar verifier. `index.ts` stays shared across both arms and
// reaches embedded surface ONLY through this seam; a remote-only desktop refuses embedded
// startup (see the `DESKTOP_REMOTE_ONLY` guards) long before any of these run.

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
