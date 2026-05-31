import { describe, expect, it } from 'vitest';
import { IntentDispatcher } from '../../src/daemon/dispatcher.js';
import {
  WorkspaceProvisionError,
  AgentWorkspaceIndexError,
  AgentL2SeedError,
} from '../../src/daemon/workspace-registry/index.js';
import { createDaemonLogControl, type DaemonLogger } from '../../src/daemon/logger.js';
import type {
  WorkspaceProvisionParams,
  WorkspaceProvisionResult,
  AgentWorkspaceIndexParams,
  AgentWorkspaceIndexResult,
  AgentL2SeedParams,
  AgentL2SeedResult,
} from '../../src/protocol.js';

/**
 * D4.e-1 slice ② dispatcher integration for the two new intents. Mirrors
 * the agent_materialize integration pins:
 *   1. each slot is wired (route → injected handler, params validated via
 *      `intentSchemas`);
 *   2. typed handler errors (`WorkspaceProvisionError` /
 *      `AgentWorkspaceIndexError`, both `DaemonTypedError`) survive the
 *      catch arm with their code (NOT squashed to `internal_error`), and
 *      ONLY codes in that intent's error schema pass — foreign codes are
 *      re-squashed by `intentErrorSchema(intent)`;
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

const provisionParams: WorkspaceProvisionParams = {
  workspace_id: 'ws_1',
  kind: 'regular',
};
const indexParams: AgentWorkspaceIndexParams = {
  agent_id: 'aid_x',
  workspace_ids: ['ws_1'],
};
const l2SeedParams: AgentL2SeedParams = {
  agent_id: 'aid_member',
  workspace_id: 'ws_1',
  template_choice: 'default',
};

describe('IntentDispatcher.workspace_provision slot', () => {
  it('routes a valid intent to the handler and returns its result', async () => {
    const handlerResult: WorkspaceProvisionResult = {
      ok: true,
      provisioned: true,
      bound_workspace_path: '/tmp/managed/ws_1',
    };
    let observed: WorkspaceProvisionParams | null = null;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      workspaceProvisionHandler: params => {
        observed = params;
        return handlerResult;
      },
    });
    const r = await d.dispatch('req-wp-1', 'workspace_provision', provisionParams);
    expect(r).toEqual({ id: 'req-wp-1', result: handlerResult });
    expect(observed).toEqual(provisionParams);
  });

  it('forwards an optional requested_path through to the handler', async () => {
    let observed: WorkspaceProvisionParams | null = null;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      workspaceProvisionHandler: params => {
        observed = params;
        return {
          ok: true,
          provisioned: true,
          bound_workspace_path: '/Users/alice/work/ws',
        };
      },
    });
    const withPath: WorkspaceProvisionParams = {
      workspace_id: 'ws_1',
      kind: 'regular',
      requested_path: '/Users/alice/work/ws',
    };
    await d.dispatch('req-wp-path', 'workspace_provision', withPath);
    expect(observed).toEqual(withPath);
  });

  it('rejects a non-string requested_path via intentSchemas before the handler', async () => {
    let called = false;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      workspaceProvisionHandler: () => {
        called = true;
        throw new Error('unreachable');
      },
    });
    const r = await d.dispatch('req-wp-badpath', 'workspace_provision', {
      workspace_id: 'ws_1',
      kind: 'regular',
      requested_path: 123,
    });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('invalid_params');
    expect(called).toBe(false);
  });

  it.each([
    'unsupported_kind',
    'invalid_path',
    'path_conflict',
    'fs_quota_exceeded',
    'fs_unavailable',
    'registry_unavailable',
    'internal_error',
  ] as const)('preserves typed WorkspaceProvisionError code: %s', async code => {
    const d = new IntentDispatcher({
      logger: silentLogger(),
      workspaceProvisionHandler: () => {
        throw new WorkspaceProvisionError(code, `seeded ${code}`);
      },
    });
    const r = await d.dispatch('req-wp', 'workspace_provision', provisionParams);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect((r.error as { code: string }).code).toBe(code);
  });

  it('re-squashes a foreign typed code not in workspace_provision schema', async () => {
    const d = new IntentDispatcher({
      logger: silentLogger(),
      workspaceProvisionHandler: () => {
        // `agent_dir_collision` is an agent_materialize code, NOT a
        // workspace_provision code. `intentErrorSchema(intent)` must
        // reject it → squashed to internal_error. Typed surface is
        // decided by the per-intent schema, not the class.
        throw new WorkspaceProvisionError(
          'agent_dir_collision' as never,
          'leaked foreign code',
        );
      },
    });
    const r = await d.dispatch('req-wp-foreign', 'workspace_provision', provisionParams);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('internal_error');
  });

  it('squashes a bare Error throw to internal_error', async () => {
    const d = new IntentDispatcher({
      logger: silentLogger(),
      workspaceProvisionHandler: () => {
        throw new Error('boom');
      },
    });
    const r = await d.dispatch('req-wp-bare', 'workspace_provision', provisionParams);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('internal_error');
  });

  it('rejects malformed params via intentSchemas before invoking the handler', async () => {
    let called = false;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      workspaceProvisionHandler: () => {
        called = true;
        throw new Error('unreachable');
      },
    });
    // Missing required `kind`.
    const r = await d.dispatch('req-wp-bad', 'workspace_provision', {
      workspace_id: 'ws_1',
    });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('invalid_params');
    expect(called).toBe(false);
  });

  it('surfaces internal_error when no handler is wired', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    const r = await d.dispatch('req-wp-unwired', 'workspace_provision', provisionParams);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('internal_error');
    expect(r.error.message).toContain('workspace_provision');
  });
});

describe('IntentDispatcher.agent_workspace_index slot', () => {
  it('routes a valid intent to the handler and returns its result', async () => {
    const handlerResult: AgentWorkspaceIndexResult = {
      ok: true,
      entries: [{ workspace_id: 'ws_1', agent_dir: '/tmp/ws_1/.silverhand/agents/aid_x' }],
      unresolved: [],
    };
    let observed: AgentWorkspaceIndexParams | null = null;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentWorkspaceIndexHandler: params => {
        observed = params;
        return handlerResult;
      },
    });
    const r = await d.dispatch('req-awi-1', 'agent_workspace_index', indexParams);
    expect(r).toEqual({ id: 'req-awi-1', result: handlerResult });
    expect(observed).toEqual(indexParams);
  });

  it.each(['registry_unavailable', 'internal_error'] as const)(
    'preserves typed AgentWorkspaceIndexError code: %s',
    async code => {
      const d = new IntentDispatcher({
        logger: silentLogger(),
        agentWorkspaceIndexHandler: () => {
          throw new AgentWorkspaceIndexError(code, `seeded ${code}`);
        },
      });
      const r = await d.dispatch('req-awi', 'agent_workspace_index', indexParams);
      expect('error' in r).toBe(true);
      if (!('error' in r)) return;
      expect((r.error as { code: string }).code).toBe(code);
    },
  );

  it('re-squashes a foreign typed code not in agent_workspace_index schema', async () => {
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentWorkspaceIndexHandler: () => {
        // `unsupported_kind` belongs to workspace_provision, not here.
        throw new AgentWorkspaceIndexError('unsupported_kind' as never, 'leaked');
      },
    });
    const r = await d.dispatch('req-awi-foreign', 'agent_workspace_index', indexParams);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('internal_error');
  });

  it('rejects malformed params via intentSchemas before invoking the handler', async () => {
    let called = false;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentWorkspaceIndexHandler: () => {
        called = true;
        throw new Error('unreachable');
      },
    });
    // `workspace_ids` must be an array.
    const r = await d.dispatch('req-awi-bad', 'agent_workspace_index', {
      agent_id: 'aid_x',
      workspace_ids: 'ws_1',
    });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('invalid_params');
    expect(called).toBe(false);
  });

  it('surfaces internal_error when no handler is wired', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    const r = await d.dispatch('req-awi-unwired', 'agent_workspace_index', indexParams);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('internal_error');
    expect(r.error.message).toContain('agent_workspace_index');
  });
});

describe('IntentDispatcher.agent_l2_seed slot', () => {
  it('routes a valid intent to the handler and returns its result', async () => {
    const handlerResult: AgentL2SeedResult = {
      ok: true,
      seeded: true,
      l2_present: true,
    };
    let observed: AgentL2SeedParams | null = null;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentL2SeedHandler: params => {
        observed = params;
        return handlerResult;
      },
    });
    const r = await d.dispatch('req-l2s-1', 'agent_l2_seed', l2SeedParams);
    expect(r).toEqual({ id: 'req-l2s-1', result: handlerResult });
    expect(observed).toEqual(l2SeedParams);
  });

  it('applies the template_choice default when omitted', async () => {
    let observed: AgentL2SeedParams | null = null;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentL2SeedHandler: params => {
        observed = params;
        return { ok: true, seeded: true, l2_present: true };
      },
    });
    await d.dispatch('req-l2s-default', 'agent_l2_seed', {
      agent_id: 'aid_member',
      workspace_id: 'ws_1',
    });
    expect((observed as AgentL2SeedParams | null)?.template_choice).toBe('default');
  });

  it.each([
    'workspace_not_provisioned',
    'registry_unavailable',
    'unsupported_template',
    'fs_unavailable',
    'internal_error',
  ] as const)('preserves typed AgentL2SeedError code: %s', async code => {
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentL2SeedHandler: () => {
        throw new AgentL2SeedError(code, `seeded ${code}`);
      },
    });
    const r = await d.dispatch('req-l2s', 'agent_l2_seed', l2SeedParams);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect((r.error as { code: string }).code).toBe(code);
  });

  it('re-squashes a foreign typed code not in agent_l2_seed schema', async () => {
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentL2SeedHandler: () => {
        // `unsupported_kind` belongs to workspace_provision, not here.
        throw new AgentL2SeedError('unsupported_kind' as never, 'leaked');
      },
    });
    const r = await d.dispatch('req-l2s-foreign', 'agent_l2_seed', l2SeedParams);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('internal_error');
  });

  it('squashes a bare Error throw to internal_error', async () => {
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentL2SeedHandler: () => {
        throw new Error('boom');
      },
    });
    const r = await d.dispatch('req-l2s-bare', 'agent_l2_seed', l2SeedParams);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('internal_error');
  });

  it('rejects an out-of-enum template_choice via intentSchemas before the handler', async () => {
    let called = false;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentL2SeedHandler: () => {
        called = true;
        throw new Error('unreachable');
      },
    });
    const r = await d.dispatch('req-l2s-badtpl', 'agent_l2_seed', {
      agent_id: 'aid_member',
      workspace_id: 'ws_1',
      template_choice: 'bogus',
    });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('invalid_params');
    expect(called).toBe(false);
  });

  it('rejects malformed params via intentSchemas before invoking the handler', async () => {
    let called = false;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentL2SeedHandler: () => {
        called = true;
        throw new Error('unreachable');
      },
    });
    // Missing required `workspace_id`.
    const r = await d.dispatch('req-l2s-bad', 'agent_l2_seed', {
      agent_id: 'aid_member',
    });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('invalid_params');
    expect(called).toBe(false);
  });

  it('surfaces internal_error when no handler is wired', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    const r = await d.dispatch('req-l2s-unwired', 'agent_l2_seed', l2SeedParams);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('internal_error');
    expect(r.error.message).toContain('agent_l2_seed');
  });
});
