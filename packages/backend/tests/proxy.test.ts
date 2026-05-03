import { describe, expect, it } from 'vitest';
import { expandProxyEnv } from '../src/proxy.js';

describe('expandProxyEnv', () => {
  it('returns null for empty / whitespace input', () => {
    expect(expandProxyEnv('')).toBeNull();
    expect(expandProxyEnv('   ')).toBeNull();
  });

  it('bare host:port → http_proxy + all_proxy (Clash mixed-port assumption)', () => {
    expect(expandProxyEnv('127.0.0.1:7897')).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7897',
      http_proxy: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      https_proxy: 'http://127.0.0.1:7897',
      ALL_PROXY: 'socks5://127.0.0.1:7897',
      all_proxy: 'socks5://127.0.0.1:7897',
    });
  });

  it('http:// scheme → keeps http for http/https env, derives socks5 for all_proxy', () => {
    expect(expandProxyEnv('http://10.0.0.1:8888')).toEqual({
      HTTP_PROXY: 'http://10.0.0.1:8888',
      http_proxy: 'http://10.0.0.1:8888',
      HTTPS_PROXY: 'http://10.0.0.1:8888',
      https_proxy: 'http://10.0.0.1:8888',
      ALL_PROXY: 'socks5://10.0.0.1:8888',
      all_proxy: 'socks5://10.0.0.1:8888',
    });
  });

  it('https:// scheme silently rewrites to http:// (almost always a typo for local proxies)', () => {
    const out = expandProxyEnv('https://127.0.0.1:7897')!;
    expect(out.HTTP_PROXY).toBe('http://127.0.0.1:7897');
    expect(out.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
    expect(out.ALL_PROXY).toBe('socks5://127.0.0.1:7897');
  });

  it('socks5:// scheme → ONLY all_proxy (no HTTP listener inferable)', () => {
    expect(expandProxyEnv('socks5://127.0.0.1:1080')).toEqual({
      ALL_PROXY: 'socks5://127.0.0.1:1080',
      all_proxy: 'socks5://127.0.0.1:1080',
    });
  });

  it('socks5h:// scheme passes through verbatim into all_proxy', () => {
    const out = expandProxyEnv('socks5h://10.0.0.1:1080')!;
    expect(out.ALL_PROXY).toBe('socks5h://10.0.0.1:1080');
    expect(out.HTTP_PROXY).toBeUndefined();
  });

  it('handles auth-bearing URLs', () => {
    const out = expandProxyEnv('http://user:pass@proxy.corp:3128')!;
    expect(out.HTTP_PROXY).toBe('http://user:pass@proxy.corp:3128');
    expect(out.ALL_PROXY).toBe('socks5://user:pass@proxy.corp:3128');
  });

  it('unknown scheme: pass through to all_proxy only', () => {
    const out = expandProxyEnv('quic://example.com:443')!;
    expect(out.ALL_PROXY).toBe('quic://example.com:443');
    expect(out.HTTP_PROXY).toBeUndefined();
  });

  it('trims input', () => {
    const out = expandProxyEnv('  127.0.0.1:7897  ')!;
    expect(out.HTTP_PROXY).toBe('http://127.0.0.1:7897');
  });
});
