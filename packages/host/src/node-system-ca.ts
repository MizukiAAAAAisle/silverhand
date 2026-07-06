import * as tls from 'node:tls';

export interface NodeSystemCaActivation {
  enabled: boolean;
  reason?: 'api_unavailable' | 'system_store_empty' | 'set_failed';
  defaultCount?: number;
  systemCount?: number;
  mergedCount?: number;
  error?: string;
}

type TlsWithCaStores = typeof tls & {
  getCACertificates?: (type?: 'default' | 'bundled' | 'system' | 'extra') => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};

/**
 * Node 24 can read the OS trust store at runtime. Enable it explicitly for
 * Electron-hosted Node processes so enterprise roots installed in macOS Keychain
 * are trusted by main-process fetch and daemon outbound WebSocket/fetch calls.
 */
export function enableNodeSystemCa(): NodeSystemCaActivation {
  const tlsWithCaStores = tls as TlsWithCaStores;
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
