import * as tls from 'node:tls';

export interface NodeSystemCaActivation {
  enabled: boolean;
  reason?: 'api_unavailable' | 'system_store_empty' | 'set_failed';
  defaultCount?: number;
  systemCount?: number;
  mergedCount?: number;
  error?: string;
}

export type TlsCaStore = {
  getCACertificates?: (type?: 'default' | 'bundled' | 'system' | 'extra') => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};

type TlsWithCaStores = typeof tls & TlsCaStore;

/**
 * Node 24 can read the OS trust store at runtime. Enable it explicitly for
 * Electron-hosted Node processes so enterprise roots installed in macOS Keychain
 * are trusted by main-process fetch and daemon outbound WebSocket/fetch calls.
 *
 * `setDefaultCACertificates` is process-local — it does NOT propagate to child
 * processes. Every Node process that makes TLS calls (Electron main, daemon,
 * and the spawned `silverhand` CLI) must call this itself. The `tlsFacade`
 * seam exists only so tests can exercise the merge/dedup logic without touching
 * the platform trust store.
 */
export function enableNodeSystemCa(
  tlsFacade: TlsCaStore = tls as TlsWithCaStores,
): NodeSystemCaActivation {
  const tlsWithCaStores = tlsFacade;
  if (
    typeof tlsWithCaStores.getCACertificates !== 'function' ||
    typeof tlsWithCaStores.setDefaultCACertificates !== 'function'
  ) {
    return { enabled: false, reason: 'api_unavailable' };
  }

  try {
    const defaultCerts = tlsWithCaStores.getCACertificates('default');
    const systemCerts = tlsWithCaStores.getCACertificates('system');
    if (systemCerts.length === 0) {
      return {
        enabled: false,
        reason: 'system_store_empty',
        defaultCount: defaultCerts.length,
        systemCount: 0,
      };
    }

    const mergedCerts = [...new Set([...defaultCerts, ...systemCerts])];
    tlsWithCaStores.setDefaultCACertificates(mergedCerts);
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
