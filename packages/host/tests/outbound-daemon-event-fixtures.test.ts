import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  OUTBOUND_DAEMON_EVENT_KINDS,
  OutboundDaemonToServerEventFrameSchema,
} from '../src/outbound-protocol.js';

type Fixture = {
  valid: Array<Record<string, unknown>>;
  invalid: Array<{ name: string; frame: Record<string, unknown> }>;
};

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/outbound-daemon-events.json', import.meta.url)),
    'utf8',
  ),
) as Fixture;

describe('outbound daemon event TS-first fixture', () => {
  it('gives every published arm one exact valid frame', () => {
    const validKinds = fixture.valid.map(frame => frame.kind).sort();

    expect(validKinds).toEqual([...OUTBOUND_DAEMON_EVENT_KINDS].sort());
    for (const frame of fixture.valid) {
      expect(
        OutboundDaemonToServerEventFrameSchema.safeParse(frame),
        String(frame.kind),
      ).toMatchObject({ success: true });
    }
  });

  it('pins exact keys, nested enums, nullability, and numeric boundaries', () => {
    for (const testCase of fixture.invalid) {
      expect(
        OutboundDaemonToServerEventFrameSchema.safeParse(testCase.frame).success,
        testCase.name,
      ).toBe(false);
    }
  });
});
