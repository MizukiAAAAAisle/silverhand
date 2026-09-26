import * as tls from 'node:tls';

export interface NodeSystemCaActivation {
  enabled: boolean;
  reason?: 'api_unavailable' | 'system_store_empty' | 'set_failed';
  defaultCount?: number;
  systemCount?: number;
  mergedCount?: number;
  error?: string;
}

/**
 * Node 24 can read the OS trust store at runtime. Enable it explicitly for
 * Electron-hosted Node processes so enterprise roots installed in macOS Keychain
 * are trusted by main-process fetch and daemon outbound WebSocket/fetch calls.
 *
 * `setDefaultCACertificates` is process-local — it does NOT propagate to child
 * processes. Every Node process that makes TLS calls (Electron main, daemon,
 * and the spawned `silverhand` CLI) must call this itself.
 */
export function enableNodeSystemCa(): NodeSystemCaActivation {
  if (
    typeof tls.getCACertificates !== 'function' ||
    typeof tls.setDefaultCACertificates !== 'function'
  ) {
    return { enabled: false, reason: 'api_unavailable' };
  }

  try {
    const defaultCerts = tls.getCACertificates('default');
    const systemCerts = tls.getCACertificates('system');
    if (systemCerts.length === 0) {
      return {
        enabled: false,
        reason: 'system_store_empty',
        defaultCount: defaultCerts.length,
        systemCount: 0,
      };
    }

    const mergedCerts = [...new Set([...defaultCerts, ...systemCerts])];
    tls.setDefaultCACertificates(mergedCerts);
    return {
      enabled: true,
      defaultCount: defaultCerts.length,
      systemCount: systemCerts.length,
      mergedCount: mergedCerts.length,
    };
  } catch (error) {
    return {
      enabled: false,
      reason: 'set_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
