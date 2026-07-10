import { describe, expect, it } from 'vitest';
import { enableNodeSystemCa, type TlsCaStore } from '../src/node-system-ca.js';

/**
 * Exercises the merge/dedup logic through an injected TLS facade so the test
 * never depends on the platform trust store (the real system cert set is a
 * host-state detail that would make assertions flaky across machines / CI).
 */

function fakeTls(
  stores: { default?: string[]; system?: string[] },
  opts: { setThrows?: boolean } = {},
): { facade: TlsCaStore; writes: string[][] } {
  const writes: string[][] = [];
  const facade: TlsCaStore = {
    getCACertificates: (type?: string) => {
      if (type === 'default') return stores.default ?? [];
      if (type === 'system') return stores.system ?? [];
      return [];
    },
    setDefaultCACertificates: (certs: string[]) => {
      if (opts.setThrows) throw new Error('boom');
      writes.push(certs);
    },
  };
  return { facade, writes };
}

describe('enableNodeSystemCa', () => {
  it('merges default + system certs, deduped, and writes them back', () => {
    const { facade, writes } = fakeTls({
      default: ['A', 'B'],
      system: ['B', 'C'],
    });

    const result = enableNodeSystemCa(facade);

    expect(result.enabled).toBe(true);
    expect(result.defaultCount).toBe(2);
    expect(result.systemCount).toBe(2);
    expect(result.mergedCount).toBe(3);
    expect(writes).toHaveLength(1);
    // default order preserved, system-only cert appended, duplicate dropped.
    expect(writes[0]).toEqual(['A', 'B', 'C']);
  });

  it('does not write when the system store is empty', () => {
    const { facade, writes } = fakeTls({ default: ['A'], system: [] });

    const result = enableNodeSystemCa(facade);

    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('system_store_empty');
    expect(result.defaultCount).toBe(1);
    expect(result.systemCount).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('reports api_unavailable when the runtime lacks the CA-store API', () => {
    const result = enableNodeSystemCa({});

    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('api_unavailable');
  });

  it('reports set_failed when writing back throws', () => {
    const { facade } = fakeTls({ default: ['A'], system: ['B'] }, { setThrows: true });

    const result = enableNodeSystemCa(facade);

    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('set_failed');
    expect(result.error).toContain('boom');
  });
});
