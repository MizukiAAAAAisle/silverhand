// Stage D3.a Commit 2 — `/readyz` mode-aware fail-loud gate.
//
// The two invariants under test:
//
//   1. Standalone backends *must* report 503 until the
//      `OutboundRuntimeEventFanout` has been wired into the
//      `HostWsServer.eventSink`. A standalone server without that
//      wire silently drops every daemon-originated runtime event, so
//      readiness has to fail-loud rather than let orchestrators
//      promote a half-installed deployment to "ready".
//
//   2. Embedded backends *must not* be gated on the fanout flag.
//      Embedded mode never constructs `OutboundRuntimeEventFanout`
//      (runtime events flow over Unix-socket IPC). Including the
//      check there would deadlock embedded `/readyz` at 503 forever.
//      The `outbound_event_fanout_installed` field is therefore
//      *omitted* from the embedded checks payload — not included as
//      `true` — so the mode boundary is obvious from the JSON.
//
// The flag is a **backend-side wiring indicator** and intentionally
// independent of any daemon-side WebSocket attachment. Daemon
// connectivity is reported through
// `HostWsServerController.getAttachment(hostId)` (D3.a Commit 1) and
// has no impact on this readiness response.

import { describe, expect, it, afterEach } from 'vitest';
import { probePaths } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('/readyz mode-aware readiness gate', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('embedded mode: returns 200 with base checks and omits outbound_event_fanout_installed', async () => {
    t = buildTestApp({ deploymentMode: 'embedded' });
    const res = await http(t).get(probePaths.readyz);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      deployment_mode: string;
      checks: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.deployment_mode).toBe('embedded');
    expect(body.checks).toEqual({
      migrations_applied: true,
      listen_ready: true,
      db_writable: true,
    });
    // The fanout-installed key must NOT appear in embedded mode — its
    // presence would imply a wiring expectation embedded backends do
    // not have. Test by key, not by value, so a future contributor
    // can't paper over the contract with `... = true`.
    expect('outbound_event_fanout_installed' in body.checks).toBe(false);
  });

  it('embedded mode: readiness unaffected by outboundEventFanoutInstalled being false (fanout is never wired in embedded)', async () => {
    t = buildTestApp({ deploymentMode: 'embedded' });
    // Force the underlying field to false — embedded should still be
    // 200 because the check isn't part of the embedded gate at all.
    t.ctx.readiness.outboundEventFanoutInstalled = false;
    const res = await http(t).get(probePaths.readyz);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; checks: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect('outbound_event_fanout_installed' in body.checks).toBe(false);
  });

  it('standalone mode: includes outbound_event_fanout_installed=true and returns 200 when fanout is wired', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    // buildTestApp defaults the flag to true; spell that expectation
    // out so the contract is visible at the test site.
    expect(t.ctx.readiness.outboundEventFanoutInstalled).toBe(true);
    const res = await http(t).get(probePaths.readyz);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      deployment_mode: string;
      checks: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.deployment_mode).toBe('standalone');
    expect(body.checks).toEqual({
      migrations_applied: true,
      listen_ready: true,
      db_writable: true,
      outbound_event_fanout_installed: true,
    });
  });

  it('standalone mode: fail-loud 503 when outboundEventFanoutInstalled is false (config bug, not transient)', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    t.ctx.readiness.outboundEventFanoutInstalled = false;
    const res = await http(t).get(probePaths.readyz);
    expect(res.status).toBe(503);
    const body = await res.json() as {
      ok: boolean;
      deployment_mode: string;
      checks: Record<string, unknown>;
    };
    expect(body.ok).toBe(false);
    expect(body.deployment_mode).toBe('standalone');
    // Other base checks should still be green; only the standalone
    // gate flips the overall ok=false.
    expect(body.checks).toEqual({
      migrations_applied: true,
      listen_ready: true,
      db_writable: true,
      outbound_event_fanout_installed: false,
    });
  });

  it('contract: outbound_event_fanout_installed reflects backend-side sink wiring, NOT daemon-side WS attachment', async () => {
    // This test exists to lock the semantic boundary as a regression
    // contract: the readiness check must not be implemented by
    // reaching into `HostWsServerController.getAttachment(...)` or any
    // daemon-connection state. To prove it: force the readiness flag
    // to true with NO host attachment in the registry, and observe
    // `/readyz` returns 200. If a future refactor accidentally
    // couples the flag to daemon attachment, this test fails-loud
    // because the standalone fixture has no daemon connected.
    t = buildTestApp({ deploymentMode: 'standalone' });
    t.ctx.readiness.outboundEventFanoutInstalled = true;
    // The HostWsServerController in test fixtures has no connected
    // hosts; assert the contract holds anyway.
    const res = await http(t).get(probePaths.readyz);
    expect(res.status).toBe(200);
  });
});
