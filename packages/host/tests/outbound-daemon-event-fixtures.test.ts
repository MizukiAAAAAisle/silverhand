import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  AgentRunStateSchema,
  DAEMON_ADMISSION,
  ParsedEventSchema,
} from '@silverhand/shared';

import {
  OUTBOUND_DAEMON_EVENT_KINDS,
  OUTBOUND_DAEMON_EVENT_SCHEMA_KINDS,
  OutboundDaemonToServerEventFrameSchema,
} from '../src/outbound-protocol.js';
import { RuntimeStateDtoSchema } from '../src/protocol.js';

type Fixture = {
  valid: Array<Record<string, unknown>>;
  parsedValid: Array<Record<string, unknown>>;
  invalid: Array<{ name: string; frame: Record<string, unknown> }>;
  runState: {
    valid: Array<{
      name: string;
      state: Record<string, unknown>;
      canonical: Record<string, unknown>;
    }>;
    invalid: Array<{ name: string; state: Record<string, unknown> }>;
  };
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
    expect([...OUTBOUND_DAEMON_EVENT_SCHEMA_KINDS].sort()).toEqual(
      [...OUTBOUND_DAEMON_EVENT_KINDS].sort(),
    );
    for (const frame of fixture.valid) {
      expect(
        OutboundDaemonToServerEventFrameSchema.safeParse(frame),
        String(frame.kind),
      ).toMatchObject({ success: true });
    }
  });

  it('uses one run-state contract for event ingress, hydrate, and live egress', () => {
    const envelope = fixture.valid.find(frame => frame.kind === 'runtime_state');
    expect(envelope).toBeDefined();
    for (const testCase of fixture.runState.valid) {
      const agentId = String(testCase.state.agentId);
      const conversationId = String(testCase.state.conversationId);
      const live = AgentRunStateSchema.safeParse(testCase.state);
      expect(live, `${testCase.name}: live`).toMatchObject({ success: true });
      if (!live.success) continue;
      expect(live.data).toEqual(testCase.canonical);
      expect(
        OutboundDaemonToServerEventFrameSchema.safeParse({
          ...envelope,
          runtime_scope: {
            kind: 'conversation',
            conversation_id: conversationId,
            agent_id: agentId,
          },
          conversation_id: conversationId,
          agent_id: agentId,
          state: testCase.state,
        }),
        `${testCase.name}: ingress`,
      ).toMatchObject({ success: true });
      expect(
        RuntimeStateDtoSchema.safeParse({
          runtime_scope: {
            kind: 'conversation',
            conversation_id: conversationId,
            agent_id: agentId,
          },
          conversation_id: conversationId,
          agent_id: agentId,
          runtime_generation: 1,
          pid: 1,
          phase: 'ready',
          run_state: testCase.state,
          started_at: 1,
        }),
        `${testCase.name}: hydrate`,
      ).toMatchObject({ success: true });
    }
    for (const testCase of fixture.runState.invalid) {
      const agentId = String(testCase.state.agentId);
      const conversationId = String(testCase.state.conversationId);
      expect(
        AgentRunStateSchema.safeParse(testCase.state).success,
        `${testCase.name}: live`,
      ).toBe(false);
      expect(
        OutboundDaemonToServerEventFrameSchema.safeParse({
          ...envelope,
          runtime_scope: {
            kind: 'conversation',
            conversation_id: conversationId,
            agent_id: agentId,
          },
          conversation_id: conversationId,
          agent_id: agentId,
          state: testCase.state,
        }).success,
        `${testCase.name}: ingress`,
      ).toBe(false);
      expect(
        RuntimeStateDtoSchema.safeParse({
          runtime_scope: {
            kind: 'conversation',
            conversation_id: conversationId,
            agent_id: agentId,
          },
          conversation_id: conversationId,
          agent_id: agentId,
          runtime_generation: 1,
          pid: 1,
          phase: 'ready',
          run_state: testCase.state,
          started_at: 1,
        }).success,
        `${testCase.name}: hydrate`,
      ).toBe(false);
    }
  });

  it('pins exact keys, nested enums, nullability, and numeric boundaries', () => {
    expect(new Set(fixture.parsedValid.map(event => event.kind))).toEqual(
      new Set(DAEMON_ADMISSION.parsedEventKinds),
    );
    expect(
      new Set(ParsedEventSchema.options.map(option => option.shape.kind.value)),
    ).toEqual(new Set(DAEMON_ADMISSION.parsedEventKinds));
    const envelope = fixture.valid.find(frame => frame.kind === 'runtime_parsed_event');
    expect(envelope).toBeDefined();
    for (const parsed of fixture.parsedValid) {
      expect(
        OutboundDaemonToServerEventFrameSchema.safeParse({ ...envelope, parsed }),
        String(parsed.kind),
      ).toMatchObject({ success: true });
    }
    for (const testCase of fixture.invalid) {
      expect(
        OutboundDaemonToServerEventFrameSchema.safeParse(testCase.frame).success,
        testCase.name,
      ).toBe(false);
    }
  });
});
