/**
 * Unit tests for `applyProxyEnv` / `parseProxyRuntimes` — the proxy
 * helper extracted out of the (now-deleted) `ConversationManager
 * .applyProxySetting` in commit 4 of the daemon cutover (RuntimeBridge
 * prep). The helper is the only call site post-Commit B; these tests
 * pin the semantics so the codex / claude allowlist behavior stays
 * byte-identical to the lifted source.
 *
 * Cindy `KzTBo4xxUmcx77yR` + `QDF5xr23ehj1RhzY` + shiki
 * `piIb3YZgFjA5qaaE`: preserve the original CM `applyProxySetting()`
 * semantics verbatim — same SettingsRepo keys, same comma-split
 * allowlist, same `expandProxyEnv()`. These tests assert that contract.
 */
import { describe, expect, it } from 'vitest';
import {
  applyProxyEnv,
  parseProxyRuntimes,
} from '../../src/runtime/proxy-env.js';

describe('applyProxyEnv', () => {
  const allowlist = new Set(['codex']);
  const proxyUrl = 'http://127.0.0.1:7897';

  it('injects expanded proxy env when runtime is in the allowlist', () => {
    const out = applyProxyEnv(
      { PATH: '/usr/bin', EXISTING: 'keep' },
      'codex',
      { proxyUrl, allowlist },
    );
    expect(out.PATH).toBe('/usr/bin');
    expect(out.EXISTING).toBe('keep');
    // Both case pairs land — matches what `expandProxyEnv` returns and
    // is what CM has always emitted; codex / Rust toolchains prefer
    // uppercase, shell tooling lowercase.
    expect(out.HTTP_PROXY).toBe('http://127.0.0.1:7897');
    expect(out.http_proxy).toBe('http://127.0.0.1:7897');
    expect(out.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
    expect(out.https_proxy).toBe('http://127.0.0.1:7897');
    expect(out.ALL_PROXY).toBe('socks5://127.0.0.1:7897');
    expect(out.all_proxy).toBe('socks5://127.0.0.1:7897');
  });

  it('no-ops when runtime is NOT in the allowlist (claude when allowlist=codex)', () => {
    const base = { PATH: '/usr/bin' };
    const out = applyProxyEnv(base, 'claude', { proxyUrl, allowlist });
    // Same object semantics — proxy keys must NOT leak into runtimes
    // the user did not opt in.
    expect(out).toEqual(base);
    expect(out.HTTP_PROXY).toBeUndefined();
    expect(out.all_proxy).toBeUndefined();
  });

  it('no-ops when proxyUrl is null/empty (Settings unset)', () => {
    const base = { PATH: '/usr/bin' };
    expect(applyProxyEnv(base, 'codex', { proxyUrl: null, allowlist })).toEqual(
      base,
    );
    expect(applyProxyEnv(base, 'codex', { proxyUrl: '', allowlist })).toEqual(
      base,
    );
  });

  it('no-ops with an empty allowlist (Settings unset / cleared)', () => {
    const base = { PATH: '/usr/bin' };
    const out = applyProxyEnv(base, 'codex', {
      proxyUrl,
      allowlist: new Set(),
    });
    expect(out).toEqual(base);
  });

  it('returns baseEnv unchanged when expandProxyEnv yields null (whitespace input)', () => {
    const base = { PATH: '/usr/bin' };
    // `expandProxyEnv` trims and bails on empty; ensure we don't
    // splice an empty object on top either.
    const out = applyProxyEnv(base, 'codex', {
      proxyUrl: '   ',
      allowlist,
    });
    expect(out).toEqual(base);
  });
});

describe('parseProxyRuntimes', () => {
  it('parses comma-separated allowlist with whitespace trimming', () => {
    const s = parseProxyRuntimes(' codex , claude ,, cursor');
    expect([...s].sort()).toEqual(['claude', 'codex', 'cursor']);
  });

  it('returns an empty Set for null / empty input', () => {
    expect(parseProxyRuntimes(null).size).toBe(0);
    expect(parseProxyRuntimes('').size).toBe(0);
    expect(parseProxyRuntimes('   ').size).toBe(0);
  });

  it('drops empty fragments without crashing (",,codex,")', () => {
    const s = parseProxyRuntimes(',,codex,');
    expect([...s]).toEqual(['codex']);
  });
});
