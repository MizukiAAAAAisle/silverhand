import { readFileSync } from 'node:fs';

import {
  X_SILVERHAND_LEGACY_USER_ID_HEADER as LEGACY_USER_ID_HEADER,
} from '@silverhand/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { RuntimeHostPlacementError } from '../../src/host-placement-errors.js';
import {
  ClearSessionExitTimeoutError,
  ClearSessionInProgressError,
} from '../../src/runtime/agent-runtime-host.js';
import { HostWsCommandResponseError } from '../../src/ws/host-ws-server.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

interface RuntimeControlWireCase {
  name: string;
  route: 'start' | 'hard_stop' | 'clear_session';
  setup:
    | 'normal'
    | 'missing_conversation'
    | 'missing_agent'
    | 'unseated_agent'
    | 'non_creator';
  provider: string;
  body: unknown | null;
  expected_status: number;
  expected_body: unknown;
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../../rust/crates/backend-server/src/conversation_messaging/messaging/collaboration/runtime_control/fixtures/runtime_control_wire.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as RuntimeControlWireCase[];

async function createChannelWithAgent(
  target: TestApp,
): Promise<{ channelId: string; agentId: string }> {
  const agent = await (
    await http(target).post('/api/agents', { name: 'alice', runtime: 'claude' })
  ).json() as { agent: { id: string } };
  const workspace = await (
    await http(target).post('/api/workspaces', {
      name: `runtime-control-${crypto.randomUUID().slice(0, 8)}`,
      member_agent_ids: [agent.agent.id],
    })
  ).json() as { onboarding_channel_id: string };
  target.fake.starts = [];
  target.fake.stops = [];
  target.fake.clearedSessions = [];
  return { channelId: workspace.onboarding_channel_id, agentId: agent.agent.id };
}

function expandFixture(value: unknown, conversationId: string, agentId: string): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll('{conversation_id}', conversationId)
      .replaceAll('{agent_id}', agentId),
  );
}

function publicError(entry: RuntimeControlWireCase): string {
  const body = entry.expected_body as { error?: unknown };
  if (typeof body.error !== 'string') {
    throw new Error(`${entry.name}: provider refusal needs an expected public error`);
  }
  return body.error;
}

describe('conversation runtime-control Rust parity oracle', () => {
  let target: TestApp | null = null;

  afterEach(() => {
    target?.cleanup();
    target = null;
  });

  for (const entry of fixture) {
    it(`${entry.name} signs the shared status and whole JSON body`, async () => {
      target = buildTestApp();
      const ids = await createChannelWithAgent(target);
      if (entry.setup === 'unseated_agent') {
        const removal = await http(target).del(
          `/api/conversations/${ids.channelId}/members/agents/${ids.agentId}`,
        );
        expect(removal.status).toBe(200);
        target.fake.stops = [];
      }
      if (entry.setup === 'non_creator') {
        const seat = await http(target).post(
          `/api/conversations/${ids.channelId}/members`,
          { kind: 'human', user_id: 'teammate' },
        );
        expect(seat.status).toBe(200);
      }

      let providerCalls = 0;
      const start = target.fake.start.bind(target.fake);
      target.fake.start = async (...args) => {
        providerCalls++;
        return start(...args);
      };
      const stop = target.fake.stop.bind(target.fake);
      target.fake.stop = async (...args) => {
        providerCalls++;
        return stop(...args);
      };
      const clearSession = target.fake.clearSession.bind(target.fake);
      target.fake.clearSession = async (...args) => {
        providerCalls++;
        return clearSession(...args);
      };

      const expected = expandFixture(entry.expected_body, ids.channelId, ids.agentId);
      if (entry.provider.startsWith('placement_')) {
        const code = entry.provider.slice('placement_'.length);
        const failure = new RuntimeHostPlacementError(
          code as ConstructorParameters<typeof RuntimeHostPlacementError>[0],
          publicError({ ...entry, expected_body: expected }),
        );
        if (entry.route === 'start') target.fake.startError = failure;
        if (entry.route === 'hard_stop') target.fake.stopError = failure;
        if (entry.route === 'clear_session') target.fake.clearError = failure;
      } else if (entry.provider.startsWith('start_')) {
        target.fake.startError = new HostWsCommandResponseError(
          entry.provider.slice('start_'.length) as never,
          publicError(entry),
          { hostId: 'host-1', commandKind: 'runtime_start', requestId: 'request-1' },
        );
      } else if (entry.provider === 'clear_timeout') {
        target.fake.clearError = new ClearSessionExitTimeoutError({
          kind: 'conversation',
          conversationId: ids.channelId,
          agentId: ids.agentId,
        });
      } else if (entry.provider === 'clear_in_progress') {
        target.fake.clearError = new ClearSessionInProgressError({
          kind: 'conversation',
          conversationId: ids.channelId,
          agentId: ids.agentId,
        });
      } else if (entry.provider === 'success') {
        target.fake.clearSessionResult = {
          prevCliSessionId: 'cli-previous',
          wasRunning: true,
          focusConversationId: null,
        };
      } else {
        throw new Error(`${entry.name}: unknown provider mode ${entry.provider}`);
      }

      const conversationId = entry.setup === 'missing_conversation'
        ? 'missing'
        : ids.channelId;
      const agentId = entry.setup === 'missing_agent'
        ? 'missing'
        : ids.agentId;
      const suffix = entry.route === 'hard_stop'
        ? 'stop'
        : entry.route === 'clear_session'
          ? 'clear-session'
          : 'start';
      const path = `/api/channels/${conversationId}/agents/${agentId}/${suffix}`;
      const headers = entry.setup === 'non_creator'
        ? { [LEGACY_USER_ID_HEADER]: 'teammate' }
        : undefined;
      const client = http(target, headers);
      const response = entry.body === null
        ? await client.post(path)
        : await client.post(path, entry.body);

      expect(response.status).toBe(entry.expected_status);
      expect(await response.json()).toEqual(expected);

      const shouldReachProvider = entry.setup === 'normal' &&
        entry.name !== 'legacy_soft_stop';
      expect(providerCalls).toBe(shouldReachProvider ? 1 : 0);
    });
  }
});
