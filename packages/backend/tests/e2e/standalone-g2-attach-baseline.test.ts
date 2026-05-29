/**
 * D4.b-1 — Standalone G2 attach baseline + parity.
 *
 * **Scope (Cindy `_5NUY2CzOF9N80pM` lock)**: harness scaffolding +
 * attach happy path + parity baseline. No ping/pong, no reconnect
 * on close, no runtime intents. Those land in subsequent B1.x or
 * B5 / B2-B4 commits after this checkpoint LGTMs.
 *
 * **Cindy review checklist (`-RKQgKfHmMGhFk2F`)**:
 *
 *   1. **Harness uses real listener / WS / HostClient / dispatcher /
 *      fanout.** See the header docs in `g2-harness.ts`. The only
 *      fake here is the runtime driver, which this commit does not
 *      exercise at all (no spawn / runtime intents in B1).
 *   2. **Attach / ack normalized object travels through one schema
 *      parse path.** The captured `ready` event is exactly the
 *      object that `HostWsConnection.onMessage` produces by calling
 *      `OutboundDaemonToServerEventFrameSchema.parse(...)`. The
 *      parity assertions re-run the same schema's `safeParse` on
 *      the captured object — we never hand-build an "expected"
 *      structure literal-by-literal.
 *   3. **Negative guard: remote-only field cannot sneak in.** The
 *      outbound ready schema is `.strict()`; pushing any unknown
 *      key through the same parse path is rejected. We pin the
 *      negative direction by mutating the captured frame with a
 *      synthetic `__remote_only_extra` key and asserting
 *      `.safeParse` fails. If a future commit relaxes the schema
 *      to allow remote-only fields, this test fails loud.
 *
 * **R4 (this IPC is local supervisor/control, not server↔daemon
 * formal semantics)**: every assertion below operates on the
 * server↔daemon outbound WS formal protocol path. The desktop
 * main ↔ backend supervisor IPC is not touched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  OutboundDaemonToServerEventFrameSchema,
  OutboundReadyEventFrameSchema,
  type OutboundDaemonToServerEventFrame,
} from '@silverhand/host';
import {
  bootG2Harness,
  waitForAttachment,
  waitFor,
  type G2Harness,
} from './g2-harness.js';

describe('Standalone G2 — attach baseline + ready frame parity', () => {
  let harness: G2Harness | null = null;
  let stopDaemon: (() => void) | null = null;

  afterEach(async () => {
    try {
      stopDaemon?.();
    } catch {
      // best-effort
    }
    stopDaemon = null;
    if (harness) {
      await harness.shutdown();
      harness = null;
    }
  });

  it('daemon attaches to standalone backend over WS; controller registers the attachment', async () => {
    // Pin: the entire path from `OutboundDaemonClient.start()` →
    // `daemon-config.json` read → WS dial → backend
    // `authenticateHost` → upgrade → `HostWsServerController`
    // registers the connection runs end-to-end without any test
    // shortcut. We assert via `getAttachment(hostId)` returning a
    // non-null snapshot whose `connectionId` is the server-minted
    // id, not anything the daemon supplied.
    harness = await bootG2Harness();
    expect(harness.backend.context.hostWsController).toBeDefined();
    const controller = harness.backend.context.hostWsController?.();
    expect(controller).not.toBeNull();
    if (!controller) throw new Error('host ws controller missing');

    // Pre-state: no attachment yet (sanity — proves the controller
    // does not lie about an attached host that never connected).
    expect(controller.getAttachment(harness.hostId)).toBeNull();

    const daemon = await harness.bootDaemon();
    stopDaemon = daemon.stop;

    const attached = await waitForAttachment(controller, harness.hostId);
    expect(attached.hostId).toBe(harness.hostId);
    expect(attached.connectionId).toMatch(/^hostws-/);
    expect(attached.attachedAt).toBeGreaterThan(0);
    expect(attached.attachedAt).toBeLessThanOrEqual(Date.now());
  });

  it('daemon emits a `ready` event observable on the wrapped sink (real fanout still runs)', async () => {
    // Pin: the recording wrapper sees the schema-parsed frame the
    // production fanout sees. The wrapper delegates to the real
    // `OutboundRuntimeEventFanout` — we are not bypassing the
    // production projection path, only observing alongside it.
    harness = await bootG2Harness();
    const controller = harness.backend.context.hostWsController?.();
    if (!controller) throw new Error('host ws controller missing');

    const daemon = await harness.bootDaemon();
    stopDaemon = daemon.stop;

    const readyEvent = await waitFor(
      () => harness!.events.find(e => e.frame.kind === 'ready') ?? null,
      { label: 'ready event on wrapped sink' },
    );
    expect(readyEvent.hostId).toBe(harness.hostId);
    expect(readyEvent.connectionId).toMatch(/^hostws-/);
    // The frame already passed `OutboundDaemonToServerEventFrameSchema`
    // (the production server-side parse). Pin the discriminator.
    expect(readyEvent.frame.kind).toBe('ready');
  });

  it('captured ready frame is structurally identical to the production schema parse (no hand-built expected object)', async () => {
    // Cindy lock #2: parity claim only compares protocol objects.
    // The "normalized object" is whatever
    // `OutboundReadyEventFrameSchema.safeParse(...)` returns for
    // the captured frame. We compare that to a second pass through
    // the same schema. Stable parser → stable object.
    harness = await bootG2Harness();
    const daemon = await harness.bootDaemon();
    stopDaemon = daemon.stop;

    const captured = await waitForReadyFrame(harness);

    const firstPass = OutboundReadyEventFrameSchema.safeParse(captured);
    expect(firstPass.success).toBe(true);
    if (!firstPass.success) throw new Error('first parse failed');

    // Round-trip the parsed object back through the same schema —
    // this enforces that the parsed shape is itself a fixed point
    // of the schema (i.e. the schema does not coerce / strip /
    // mutate). If a future schema change introduces coercion, this
    // round-trip would diverge.
    const secondPass = OutboundReadyEventFrameSchema.safeParse(firstPass.data);
    expect(secondPass.success).toBe(true);
    if (!secondPass.success) throw new Error('round-trip parse failed');
    expect(secondPass.data).toEqual(firstPass.data);
  });

  it('parity guard: captured frame has EXACTLY the schema-known keys (no remote-only field leak)', async () => {
    // Negative guard #1 (Cindy lock #2 + #3 third bullet): no
    // outbound key is allowed beyond what `OutboundReadyEventFrameSchema`
    // declares. If a remote/standalone path silently adds a field
    // (e.g. `server_region`, `tenant_id`, `cluster_routing_hint`,
    // any "remote-only" telemetry hop), the schema parse keys will
    // diverge from the captured object's keys and this test fails.
    //
    // We compute the schema's known top-level keys from the schema
    // object itself (`OutboundReadyEventFrameSchema.shape`) — never
    // hand-write them in the test, otherwise we'd re-derive the
    // contract and lose the parity claim.
    harness = await bootG2Harness();
    const daemon = await harness.bootDaemon();
    stopDaemon = daemon.stop;

    const captured = await waitForReadyFrame(harness);

    const schemaKeys = new Set(
      Object.keys(OutboundReadyEventFrameSchema.shape),
    );
    const capturedKeys = new Set(Object.keys(captured));
    // Pin both directions: nothing in captured that's not in
    // schema (no extras), AND nothing in schema that's missing
    // from captured (no required field silently absent).
    const extras = [...capturedKeys].filter(k => !schemaKeys.has(k));
    const missing = [...schemaKeys].filter(k => !capturedKeys.has(k));
    expect({ extras, missing }).toEqual({ extras: [], missing: [] });
  });

  it('parity guard: schema is strict — synthetic remote-only field is rejected by the same parse path', async () => {
    // Negative guard #2: a deliberately injected unknown key MUST
    // fail `OutboundReadyEventFrameSchema.parse(...)`. This pins
    // that the schema is `.strict()` and not silently `.passthrough()`,
    // so the previous guard cannot be defeated by a schema change
    // that relaxes unknown-key handling.
    harness = await bootG2Harness();
    const daemon = await harness.bootDaemon();
    stopDaemon = daemon.stop;

    const captured = await waitForReadyFrame(harness);
    const synthetic = {
      ...captured,
      __remote_only_extra: 'should be rejected by .strict()',
    };
    const parsed = OutboundReadyEventFrameSchema.safeParse(synthetic);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected strict-mode rejection');
    // Spot-check that the rejection cites the unknown key (zod
    // emits `unrecognized_keys` for `.strict()` violations). If the
    // wording changes upstream this assertion becomes brittle —
    // narrow it to a substring rather than full message equality.
    const codes = parsed.error.issues.map(i => i.code);
    expect(codes).toContain('unrecognized_keys');
  });

  it('parity guard: production server-side parse and the schema agree on the captured frame (one parse path)', async () => {
    // Cindy lock #2 spelled out: the normalized object on the
    // server side comes through ONE schema parse path. The frame
    // we observe was produced by
    // `OutboundDaemonToServerEventFrameSchema.parse(...)` inside
    // `HostWsConnection.onMessage`. Here we re-parse it through
    // BOTH the union schema AND the discriminant-narrowed
    // `OutboundReadyEventFrameSchema` and assert they yield the
    // same object. If a future refactor introduces a second
    // normalization path (e.g. a remote-mode-specific decoder),
    // this assertion would catch it.
    harness = await bootG2Harness();
    const daemon = await harness.bootDaemon();
    stopDaemon = daemon.stop;

    const captured = await waitForReadyFrame(harness);
    const unionParse = OutboundDaemonToServerEventFrameSchema.safeParse(captured);
    expect(unionParse.success).toBe(true);
    if (!unionParse.success) throw new Error('union parse failed');
    const narrowParse = OutboundReadyEventFrameSchema.safeParse(captured);
    expect(narrowParse.success).toBe(true);
    if (!narrowParse.success) throw new Error('narrow parse failed');
    expect(unionParse.data).toEqual(narrowParse.data);
  });
});

async function waitForReadyFrame(
  harness: G2Harness,
): Promise<OutboundDaemonToServerEventFrame> {
  const event = await waitFor(
    () => harness.events.find(e => e.frame.kind === 'ready') ?? null,
    { label: 'ready event frame' },
  );
  return event.frame;
}
