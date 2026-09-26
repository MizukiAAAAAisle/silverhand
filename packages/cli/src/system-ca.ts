import { enableNodeSystemCa, type NodeSystemCaActivation } from '@silverhand/host/node-system-ca';

/**
 * Trust the OS / corporate CA store from the CLI process.
 *
 * The desktop main process and the daemon each call `enableNodeSystemCa()` at
 * startup, but `tls.setDefaultCACertificates()` is process-local: the daemon
 * spawns `silverhand` as a separate Electron-as-Node process (execPath +
 * ELECTRON_RUN_AS_NODE=1), so that activation never reaches this process's
 * `fetch()`. Without re-running it here the CLI falls back to Node's bundled CA
 * bundle and enterprise roots installed in the macOS Keychain are not trusted —
 * direct-HTTPS commands like `task claim` fail with
 * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (`message send` survives only because it
 * routes over the daemon Unix socket, which has no TLS). See #task:1464 /
 * #task:1463.
 *
 * Best-effort: activation must never block a CLI command. A failure to read or
 * set the trust store is swallowed so we degrade to the bundled bundle rather
 * than aborting; callers that need to observe the outcome read the return value.
 */
export function ensureSystemCaTrusted(): NodeSystemCaActivation | undefined {
  try {
    return enableNodeSystemCa();
  } catch {
    return undefined;
  }
}
