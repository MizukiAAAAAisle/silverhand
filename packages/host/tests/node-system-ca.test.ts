import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises the production TLS import through a module mock so the test
 * never depends on the platform trust store (the real system cert set is a
 * host-state detail that would make assertions flaky across machines / CI).
 */

async function fakeTls(
  stores: { default?: string[]; system?: string[] },
  opts: { setThrows?: boolean } = {},
) {
  const writes: string[][] = [];
  const facade = {
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
  vi.doMock('node:tls', () => facade);
  const { enableNodeSystemCa } = await import('../src/node-system-ca.js');
  return { enableNodeSystemCa, writes };
}

afterEach(() => {
  vi.doUnmock('node:tls');
  vi.resetModules();
});

describe('enableNodeSystemCa', () => {
  it('merges default + system certs, deduped, and writes them back', async () => {
    const { enableNodeSystemCa, writes } = await fakeTls({
      default: ['A', 'B'],
      system: ['B', 'C'],
    });

    const result = enableNodeSystemCa();

    expect(result.enabled).toBe(true);
    expect(result.defaultCount).toBe(2);
    expect(result.systemCount).toBe(2);
    expect(result.mergedCount).toBe(3);
    expect(writes).toHaveLength(1);
    // default order preserved, system-only cert appended, duplicate dropped.
    expect(writes[0]).toEqual(['A', 'B', 'C']);
  });

  it('does not write when the system store is empty', async () => {
    const { enableNodeSystemCa, writes } = await fakeTls({ default: ['A'], system: [] });

    const result = enableNodeSystemCa();

    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('system_store_empty');
    expect(result.defaultCount).toBe(1);
    expect(result.systemCount).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it.each(['getCACertificates', 'setDefaultCACertificates'] as const)(
    'reports api_unavailable when the runtime lacks %s',
    async (missing) => {
      const getCACertificates = vi.fn(() => ['A']);
      const setDefaultCACertificates = vi.fn();
      vi.doMock('node:tls', () => ({
        getCACertificates,
        setDefaultCACertificates,
        [missing]: undefined,
      }));
      const { enableNodeSystemCa } = await import('../src/node-system-ca.js');

      expect(enableNodeSystemCa()).toEqual({ enabled: false, reason: 'api_unavailable' });
      expect(getCACertificates).not.toHaveBeenCalled();
      expect(setDefaultCACertificates).not.toHaveBeenCalled();
    },
  );

  it('reports set_failed when writing back throws', async () => {
    const { enableNodeSystemCa } = await fakeTls(
      { default: ['A'], system: ['B'] },
      { setThrows: true },
    );

    const result = enableNodeSystemCa();

    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('set_failed');
    expect(result.error).toContain('boom');
  });
});
