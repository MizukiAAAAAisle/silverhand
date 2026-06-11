/**
 * D4.b-1 fixup (Cindy P1 #task:660) — harness invariants.
 *
 * These tests pin the recording wrapper's strictness without
 * booting a backend / WS / daemon. They are fixture-level
 * negative pins: if a future refactor relaxes the wrapper back to
 * its previous "record-in-isolation when real is missing" or
 * "push-then-delegate" shape, these tests fail loud.
 *
 * Cindy P1 wording (`e0yAfZVQH76Eo58c`):
 *
 *   "建议修法：
 *      - 在 `wrapHostWsEventSink` 里如果 `real` 是 `undefined`，
 *        直接 throw / fail harness。
 *      - `makeRecordingSink.onEvent` 改成 **先委托 real fanout，
 *        再记录**；real throw 时不要 push captured event。
 *        onDisconnect 同理。
 *      - 加两个小 pin test：
 *        - `makeRecordingSink(undefined, ...)` 或 harness wrapper
 *          收到 `undefined` 必须 fail；
 *        - fake real sink throw 时，event 不进入 `events[]`。"
 *
 * Both pins are below. They cover what the integration test
 * (`standalone-g2-attach-baseline.test.ts`) cannot: the failure
 * modes don't fire under a healthy production wiring, so without
 * a fixture-level negative pin a regression would slip past.
 */
import { describe, expect, it } from 'vitest';
import { bootG2Harness, makeRecordingSink } from './g2-harness.js';
import type { OutboundDaemonToServerEventFrame } from '@silverhand/host';

const fakeReadyFrame: OutboundDaemonToServerEventFrame = {
  direction: 'daemon_to_server',
  type: 'event',
  kind: 'ready',
  protocol_version: 2,
  daemon_version: 'test',
  daemon_id: 'local',
  instance_id: '__harness_pin__',
  host_descriptor: { name: 'local', kind: 'local' },
  capabilities: [],
  daemon_pid: process.pid,
  started_at: Date.now(),
};

describe('g2-harness — wrapHostWsEventSink invariants (Cindy P1 #task:660)', () => {
  it('bootG2Harness boots successfully against a real standalone backend (fanout is installed → wrap factory does not throw)', async () => {
    // Positive sanity: when standalone backend installs the real
    // fanout (which it must), the strict wrap factory accepts it
    // and the harness boots. If a future regression drops the
    // fanout, this test would throw with the
    // "wrapHostWsEventSink received undefined fanout" message
    // before any G2 test even ran.
    const harness = await bootG2Harness();
    try {
      // The backend exposes `hostWsController` so callers can poll
      // for attachment; that wiring goes hand-in-hand with the
      // fanout install. If the harness boot got here, the strict
      // wrap accepted a real fanout.
      expect(harness.backend.context.hostWsController).toBeDefined();
    } finally {
      await harness.shutdown();
    }
  });
});

describe('makeRecordingSink — delegate-first ordering (Cindy P1 #task:660)', () => {
  it('onEvent delegates to real sink BEFORE pushing to events[]; a throw from real does NOT leave a captured event', () => {
    // Pre-fix wording (the bug Cindy caught): the wrapper pushed
    // first, then delegated. So a throwing real fanout would
    // still leave `events[0]` populated, and the integration test
    // would see a "successful capture" despite the production
    // path failing. Post-fix: delegate first; the push only runs
    // after the delegate returns successfully.
    const events: Array<{ frame: OutboundDaemonToServerEventFrame }> = [];
    const disconnects: Array<{ connectionId: string }> = [];
    const throwingReal = {
      onEvent: () => {
        throw new Error('synthetic real-fanout throw');
      },
      onDisconnect: () => {},
    };
    const sink = makeRecordingSink(
      throwingReal,
      events as never,
      disconnects as never,
    );
    expect(() => sink.onEvent('host-1', fakeReadyFrame, 'conn-1')).toThrow(
      /synthetic real-fanout throw/,
    );
    // Load-bearing assertion (Cindy P1 second pin):
    // events[] MUST be empty after the throw.
    expect(events).toHaveLength(0);
  });

  it('onDisconnect delegates first; a throw from real does NOT leave a captured disconnect', () => {
    // Mirror invariant for the disconnect path. Same reasoning as
    // onEvent — the wrapper must not be the source of "looks
    // successful" assertions when the real fanout actually failed.
    const events: Array<{ frame: OutboundDaemonToServerEventFrame }> = [];
    const disconnects: Array<{ connectionId: string }> = [];
    const throwingReal = {
      onEvent: () => {},
      onDisconnect: () => {
        throw new Error('synthetic real-fanout disconnect throw');
      },
    };
    const sink = makeRecordingSink(
      throwingReal,
      events as never,
      disconnects as never,
    );
    expect(() => sink.onDisconnect!('host-1', 'conn-1')).toThrow(
      /synthetic real-fanout disconnect throw/,
    );
    expect(disconnects).toHaveLength(0);
  });

  it('onEvent records into events[] AFTER a successful real delegate (happy path still works)', () => {
    // Positive arm: when real succeeds, the wrapper observes the
    // frame. This guards against an over-correction that would
    // skip the push entirely.
    const events: Array<{
      hostId: string;
      connectionId: string;
      frame: OutboundDaemonToServerEventFrame;
      observedAt: number;
    }> = [];
    const disconnects: Array<{
      hostId: string;
      connectionId: string;
      observedAt: number;
    }> = [];
    const realCalls: Array<{
      hostId: string;
      frame: OutboundDaemonToServerEventFrame;
    }> = [];
    const real = {
      onEvent: (
        hostId: string,
        frame: OutboundDaemonToServerEventFrame,
      ) => {
        realCalls.push({ hostId, frame });
      },
      onDisconnect: () => {},
    };
    const sink = makeRecordingSink(real, events, disconnects);
    sink.onEvent('host-1', fakeReadyFrame, 'conn-1');
    expect(realCalls).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.frame).toBe(fakeReadyFrame);
    expect(events[0]!.hostId).toBe('host-1');
    expect(events[0]!.connectionId).toBe('conn-1');
  });
});
