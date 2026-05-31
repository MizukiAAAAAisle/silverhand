import { describe, expect, it } from 'vitest';
import { IntentDispatcher } from '../../src/daemon/dispatcher.js';
import { AgentWorkspaceReadError } from '../../src/daemon/agent-workspace-read/index.js';
import {
  createDaemonLogControl,
  type DaemonLogger,
} from '../../src/daemon/logger.js';
import type {
  AgentWorkspaceReadParams,
  AgentWorkspaceReadResult,
} from '../../src/protocol.js';

/**
 * D4.e-2 dispatcher integration for `agent_workspace_read`. Mirrors the
 * D4.e-1 data-plane pins:
 *   1. the slot is wired (route → injected handler, params validated via
 *      `intentSchemas`);
 *   2. typed handler errors (`AgentWorkspaceReadError`, a `DaemonTypedError`)
 *      survive the catch arm with their code, and ONLY codes in this
 *      intent's error schema pass — a foreign code is re-squashed by
 *      `intentErrorSchema(intent)`;
 *   3. bare throws squash to `internal_error`;
 *   4. malformed params reject with `invalid_params` before the handler;
 *   5. an unwired slot surfaces `internal_error`.
 */

function silentLogger(): DaemonLogger {
  return {
    filePath: '/dev/null',
    logControl: createDaemonLogControl('debug'),
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    close: async () => {},
  } as unknown as DaemonLogger;
}

const readParams: AgentWorkspaceReadParams = { agent_id: 'aid_x' };

const handlerResult: AgentWorkspaceReadResult = {
  ok: true,
  workspace: {
    l1_path: '/home/u/.silverhand/agents/aid_x',
    system_prompt: null,
    memory: null,
    notes: [],
  },
};

describe('IntentDispatcher.agent_workspace_read slot', () => {
  it('routes a valid intent to the handler and returns its result', async () => {
    let observed: AgentWorkspaceReadParams | null = null;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentWorkspaceReadHandler: params => {
        observed = params;
        return handlerResult;
      },
    });
    const r = await d.dispatch('req-awr-1', 'agent_workspace_read', readParams);
    expect(r).toEqual({ id: 'req-awr-1', result: handlerResult });
    expect(observed).toEqual(readParams);
  });

  it.each(['fs_unavailable', 'internal_error'] as const)(
    'preserves typed AgentWorkspaceReadError code: %s',
    async code => {
      const d = new IntentDispatcher({
        logger: silentLogger(),
        agentWorkspaceReadHandler: () => {
          throw new AgentWorkspaceReadError(code, `seeded ${code}`);
        },
      });
      const r = await d.dispatch('req-awr', 'agent_workspace_read', readParams);
      expect('error' in r).toBe(true);
      if (!('error' in r)) return;
      expect((r.error as { code: string }).code).toBe(code);
    },
  );

  it('re-squashes a foreign typed code not in agent_workspace_read schema', async () => {
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentWorkspaceReadHandler: () => {
        // `path_conflict` belongs to workspace_provision, not here. The
        // per-intent error schema must reject it → internal_error. The typed
        // surface is decided by the schema, not the error class.
        throw new AgentWorkspaceReadError('path_conflict' as never, 'leaked');
      },
    });
    const r = await d.dispatch(
      'req-awr-foreign',
      'agent_workspace_read',
      readParams,
    );
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('internal_error');
  });

  it('squashes a bare Error throw to internal_error', async () => {
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentWorkspaceReadHandler: () => {
        throw new Error('boom');
      },
    });
    const r = await d.dispatch('req-awr-bare', 'agent_workspace_read', readParams);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('internal_error');
  });

  it('rejects malformed params via intentSchemas before invoking the handler', async () => {
    let called = false;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentWorkspaceReadHandler: () => {
        called = true;
        throw new Error('unreachable');
      },
    });
    // Missing required `agent_id`.
    const r = await d.dispatch('req-awr-bad', 'agent_workspace_read', {});
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('invalid_params');
    expect(called).toBe(false);
  });

  it('rejects an unknown extra param (strict params schema)', async () => {
    let called = false;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentWorkspaceReadHandler: () => {
        called = true;
        throw new Error('unreachable');
      },
    });
    // A `workspace_id` selector is NOT part of the narrow D4.e-2 shape;
    // `.strict()` must reject it (the future L2-read slice adds it).
    const r = await d.dispatch('req-awr-extra', 'agent_workspace_read', {
      agent_id: 'aid_x',
      workspace_id: 'ws_1',
    });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('invalid_params');
    expect(called).toBe(false);
  });

  it('surfaces internal_error when no handler is wired', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    const r = await d.dispatch(
      'req-awr-unwired',
      'agent_workspace_read',
      readParams,
    );
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('internal_error');
    expect(r.error.message).toContain('agent_workspace_read');
  });
});
