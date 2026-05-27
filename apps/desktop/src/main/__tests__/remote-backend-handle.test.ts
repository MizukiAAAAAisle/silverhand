/**
 * D4.a Commit 5d — unit tests for the {@link RemoteBackendHandle}
 * factory.
 *
 * The factory is intentionally trivial; the value of these tests is
 * pinning the SHAPE that `index.ts` consumes (specifically: a
 * remote-mode backend handle is discriminated by `kind: 'remote'`,
 * its `url` is the canonical origin, its `insecure` flag flows
 * through unchanged, and its `close()` is a no-op promise that does
 * not depend on any external state).
 *
 * Cindy 5d review boundary 5: this provides the unit seam for the
 * remote-mode bootstrap branch — the factory's output is what the
 * `BackendHandle` union assigns to its `kind: 'remote'` arm in
 * bootstrap.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRemoteBackendHandle,
  type RemoteBackendHandle,
} from '../remote-backend-handle.js';

describe('buildRemoteBackendHandle', () => {
  it('discriminates as kind: "remote"', () => {
    const handle = buildRemoteBackendHandle({
      serverUrl: 'https://backend.example.test',
      insecure: false,
    });
    expect(handle.kind).toBe('remote');
  });

  it('passes serverUrl through unchanged (caller is responsible for canonicalization upstream)', () => {
    // The factory does NOT re-canonicalize the URL — it trusts the
    // caller (`decideBackendBootMode` already returns
    // `classification.url.origin`). This test pins that contract:
    // if a caller hands in an unusual but valid URL, it lands on
    // the handle verbatim.
    const handle = buildRemoteBackendHandle({
      serverUrl: 'https://backend.example.test',
      insecure: false,
    });
    expect(handle.url).toBe('https://backend.example.test');
  });

  it('insecure=false flows through (system_ca_verified arm)', () => {
    const handle = buildRemoteBackendHandle({
      serverUrl: 'https://backend.example.test',
      insecure: false,
    });
    expect(handle.insecure).toBe(false);
  });

  it('insecure=true flows through (insecure_dev_remote arm)', () => {
    const handle = buildRemoteBackendHandle({
      serverUrl: 'http://10.0.0.5:8080',
      insecure: true,
    });
    expect(handle.insecure).toBe(true);
  });

  it('close() resolves without side effects', async () => {
    const handle = buildRemoteBackendHandle({
      serverUrl: 'https://backend.example.test',
      insecure: false,
    });
    // Call close() multiple times to ensure idempotency — there is
    // no in-process backend to tear down on this arm, so close()
    // never errors and never produces an observable side effect.
    await expect(handle.close()).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('produces a typed RemoteBackendHandle (no widening, no extra fields)', () => {
    // Pin the shape: only the four documented fields. A regression
    // that accidentally adds an embedded-only field (e.g. `port`
    // sneaking through) will break this test loud.
    const handle: RemoteBackendHandle = buildRemoteBackendHandle({
      serverUrl: 'https://backend.example.test',
      insecure: false,
    });
    const keys = Object.keys(handle).sort();
    expect(keys).toEqual(['close', 'insecure', 'kind', 'url']);
  });

  it('two handles built from the same input produce equal field surfaces (no hidden state)', () => {
    // Pure factory — two calls with identical input produce
    // structurally identical handles. This is the contract that
    // lets `index.ts` rebuild the handle on profile-update without
    // cleaning up internal state.
    const a = buildRemoteBackendHandle({
      serverUrl: 'https://backend.example.test',
      insecure: false,
    });
    const b = buildRemoteBackendHandle({
      serverUrl: 'https://backend.example.test',
      insecure: false,
    });
    expect(a.kind).toBe(b.kind);
    expect(a.url).toBe(b.url);
    expect(a.insecure).toBe(b.insecure);
  });
});
