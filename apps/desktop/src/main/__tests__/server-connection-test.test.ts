/**
 * D4.a Commit 2 — unit tests for the desktop `probeServerInfo` helper.
 *
 * Coverage:
 *   - Each success arm: loopback_ok, system_ca_verified, insecure_dev_remote.
 *   - classify_rejected mirrors the classifier's failure surface
 *     (smoke-test one case; the classifier itself has its own
 *     deep test file).
 *   - tls_failed maps via classifyTlsError — pin one expired / one
 *     hostname mismatch / one chain invalid case so a future refactor
 *     of the mapper doesn't silently drop one of the three buckets.
 *   - http_failed conveys status, statusText, body.
 *   - network_failed for thrown non-TLS errors.
 *   - invalid_response for non-JSON body and for JSON that doesn't
 *     match ServerInfoSchema.
 */
import { describe, expect, it, vi } from 'vitest';
import { probeServerInfo, type FetcherFn } from '../server-connection-test.js';

function fakeFetch(handler: FetcherFn): FetcherFn {
  return handler;
}

function jsonFetcher(body: unknown, status = 200): FetcherFn {
  return fakeFetch(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    text: async () => JSON.stringify(body),
  }));
}

describe('probeServerInfo — success arms', () => {
  it('returns loopback_ok for a 127.0.0.1 URL with a valid ServerInfo body', async () => {
    const result = await probeServerInfo({
      serverUrl: 'http://127.0.0.1:7321',
      allowInsecureRemote: false,
      fetcher: jsonFetcher({ signup_enabled: true }),
    });
    expect(result).toEqual({
      ok: true,
      kind: 'loopback_ok',
      info: { signup_enabled: true },
    });
  });

  it('returns system_ca_verified for an https remote with a valid body', async () => {
    const result = await probeServerInfo({
      serverUrl: 'https://backend.example.test',
      allowInsecureRemote: false,
      fetcher: jsonFetcher({ signup_enabled: false }),
    });
    expect(result).toEqual({
      ok: true,
      kind: 'system_ca_verified',
      info: { signup_enabled: false },
    });
  });

  it('returns insecure_dev_remote for an http remote ONLY with the dev flag', async () => {
    const result = await probeServerInfo({
      serverUrl: 'http://10.0.0.5:8080',
      allowInsecureRemote: true,
      fetcher: jsonFetcher({ signup_enabled: true }),
    });
    expect(result).toEqual({
      ok: true,
      kind: 'insecure_dev_remote',
      info: { signup_enabled: true },
    });
  });

  it('targets `/api/server/info` against the input base URL', async () => {
    const calls: string[] = [];
    const fetcher: FetcherFn = async input => {
      calls.push(input);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ signup_enabled: false }),
      };
    };
    await probeServerInfo({
      serverUrl: 'https://backend.example.test',
      allowInsecureRemote: false,
      fetcher,
    });
    expect(calls).toEqual(['https://backend.example.test/api/server/info']);
  });
});

describe('probeServerInfo — classify_rejected mirrors the classifier', () => {
  it('returns classify_rejected for a non-loopback http URL without the dev flag', async () => {
    const result = await probeServerInfo({
      serverUrl: 'http://10.0.0.5',
      allowInsecureRemote: false,
      // fetcher should never run — if it does, the test will see
      // the wrong outcome kind anyway.
      fetcher: fakeFetch(async () => {
        throw new Error('fetcher should not be called when classifier rejects');
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('classify_rejected');
    if (result.kind !== 'classify_rejected') throw new Error('unreachable');
    expect(result.reason).toBe('insecure_remote_http_disallowed');
    expect(typeof result.message).toBe('string');
  });

  it('returns classify_rejected for an obfuscated loopback even with the dev flag', async () => {
    // Cindy D4.a Commit 1 invariant: obfuscated loopback is rejected
    // outright regardless of `allowInsecureRemote`.
    const result = await probeServerInfo({
      serverUrl: 'http://127.000.000.001',
      allowInsecureRemote: true,
      fetcher: fakeFetch(async () => {
        throw new Error('fetcher should not be called for obfuscated loopback');
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('classify_rejected');
    if (result.kind !== 'classify_rejected') throw new Error('unreachable');
    expect(result.reason).toBe('obfuscated_loopback_disallowed');
  });
});

describe('probeServerInfo — TLS-failed mapping', () => {
  function errFetcher(err: unknown): FetcherFn {
    return fakeFetch(async () => {
      throw err;
    });
  }

  it('maps CERT_HAS_EXPIRED → tls_failed/host_tls_expired', async () => {
    const result = await probeServerInfo({
      serverUrl: 'https://expired.example.test',
      allowInsecureRemote: false,
      fetcher: errFetcher({ code: 'CERT_HAS_EXPIRED' }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('tls_failed');
    if (result.kind !== 'tls_failed') throw new Error('unreachable');
    expect(result.code).toBe('host_tls_expired');
  });

  it('maps ERR_TLS_CERT_ALTNAME_INVALID → tls_failed/host_tls_hostname_mismatch', async () => {
    const result = await probeServerInfo({
      serverUrl: 'https://wrong-name.example.test',
      allowInsecureRemote: false,
      fetcher: errFetcher({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('tls_failed');
    if (result.kind !== 'tls_failed') throw new Error('unreachable');
    expect(result.code).toBe('host_tls_hostname_mismatch');
  });

  it('maps DEPTH_ZERO_SELF_SIGNED_CERT → tls_failed/host_tls_chain_invalid', async () => {
    const result = await probeServerInfo({
      serverUrl: 'https://selfsigned.example.test',
      allowInsecureRemote: false,
      fetcher: errFetcher({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('tls_failed');
    if (result.kind !== 'tls_failed') throw new Error('unreachable');
    expect(result.code).toBe('host_tls_chain_invalid');
  });

  it('descends through cause-chain — outer wrapper + inner expired → host_tls_expired', async () => {
    const result = await probeServerInfo({
      serverUrl: 'https://wrapped.example.test',
      allowInsecureRemote: false,
      fetcher: errFetcher({
        code: 'ERR_SSL_CERTIFICATE_VERIFY_FAILED',
        cause: { code: 'CERT_HAS_EXPIRED' },
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('tls_failed');
    if (result.kind !== 'tls_failed') throw new Error('unreachable');
    expect(result.code).toBe('host_tls_expired');
  });
});

describe('probeServerInfo — http_failed', () => {
  it('returns http_failed with status / statusText / body for a 404', async () => {
    const fetcher: FetcherFn = async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => 'route not registered',
    });
    const result = await probeServerInfo({
      serverUrl: 'https://backend.example.test',
      allowInsecureRemote: false,
      fetcher,
    });
    expect(result).toEqual({
      ok: false,
      kind: 'http_failed',
      status: 404,
      statusText: 'Not Found',
      bodyText: 'route not registered',
    });
  });
});

describe('probeServerInfo — network_failed', () => {
  it('maps a non-TLS thrown error to network_failed with the error message', async () => {
    const result = await probeServerInfo({
      serverUrl: 'https://unreachable.example.test',
      allowInsecureRemote: false,
      fetcher: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        });
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('network_failed');
    if (result.kind !== 'network_failed') throw new Error('unreachable');
    expect(result.message).toContain('ECONNREFUSED');
  });
});

describe('probeServerInfo — invalid_response', () => {
  it('returns invalid_response when body is not valid JSON', async () => {
    const fetcher: FetcherFn = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '<html>not silverhand</html>',
    });
    const result = await probeServerInfo({
      serverUrl: 'https://something-else.example.test',
      allowInsecureRemote: false,
      fetcher,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('invalid_response');
  });

  it('returns invalid_response when body is JSON but does not match ServerInfo schema', async () => {
    const fetcher = jsonFetcher({ unexpected: 'shape' });
    const result = await probeServerInfo({
      serverUrl: 'https://something-else.example.test',
      allowInsecureRemote: false,
      fetcher,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.kind).toBe('invalid_response');
    if (result.kind !== 'invalid_response') throw new Error('unreachable');
    expect(result.message).toContain('signup_enabled');
  });
});

describe('probeServerInfo — AbortSignal pass-through', () => {
  it('passes the signal to the fetcher', async () => {
    const ac = new AbortController();
    const seen: AbortSignal[] = [];
    const fetcher: FetcherFn = async (_input, init) => {
      if (init?.signal) seen.push(init.signal);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ signup_enabled: false }),
      };
    };
    await probeServerInfo({
      serverUrl: 'https://x.example.test',
      allowInsecureRemote: false,
      fetcher,
      signal: ac.signal,
    });
    expect(seen).toEqual([ac.signal]);
  });
});
