import { describe, expect, it } from 'vitest';
import { IntentDispatcher } from '../../src/daemon/dispatcher.js';
import {
  WorkspaceProvisionError,
  AgentWorkspaceIndexError,
  AgentL2SeedError,
  AgentFilesPurgeError,
} from '../../src/daemon/workspace-registry/index.js';
import { createDaemonLogControl, type DaemonLogger } from '../../src/daemon/logger.js';
import type {
  WorkspaceProvisionParams,
  WorkspaceProvisionResult,
  AgentWorkspaceIndexParams,
  AgentWorkspaceIndexResult,
  AgentL2SeedParams,
  AgentL2SeedResult,
  AgentFilesPurgeParams,
  AgentFilesPurgeResult,
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
const purgeParams: AgentFilesPurgeParams = {
  agent_id: 'aid_member',
  scope: 'all',
  workspace_ids: ['ws_1'],
};

type DispatcherOptions = ConstructorParameters<typeof IntentDispatcher>[0];
type RegistryHandlerKey =
  | 'workspaceProvisionHandler'
  | 'agentWorkspaceIndexHandler'
  | 'agentL2SeedHandler'
  | 'agentFilesPurgeHandler';

interface RegistryIntentCase {
  label: string;
  intent:
    | 'workspace_provision'
    | 'agent_workspace_index'
    | 'agent_l2_seed'
    | 'agent_files_purge';
  requestPrefix: string;
  handlerKey: RegistryHandlerKey;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  errorName: string;
  typedCodes: readonly string[];
  makeTypedError: (code: string, message: string) => Error;
  foreignError: () => Error;
  malformedParams: Record<string, unknown>;
  malformedComment: string;
  bareError?: boolean;
}

function dispatcherWithHandler(
  handlerKey: RegistryHandlerKey,
  handler: (params: never) => unknown,
): IntentDispatcher {
  return new IntentDispatcher({
    logger: silentLogger(),
    [handlerKey]: handler,
  } as unknown as DispatcherOptions);
}

async function expectErrorCode(
  promise: Promise<Awaited<ReturnType<IntentDispatcher['dispatch']>>>,
  code: string,
): Promise<Extract<Awaited<ReturnType<IntentDispatcher['dispatch']>>, { error: unknown }>> {
  const r = await promise;
  expect('error' in r).toBe(true);
  if (!('error' in r)) throw new Error('expected error response');
  expect(r.error.code).toBe(code);
  return r;
}

const registryIntentCases: RegistryIntentCase[] = [
  {
    label: 'workspace_provision',
    intent: 'workspace_provision',
    requestPrefix: 'req-wp',
    handlerKey: 'workspaceProvisionHandler',
    params: provisionParams,
    result: {
      ok: true,
      provisioned: true,
      bound_workspace_path: '/tmp/managed/ws_1',
    } satisfies WorkspaceProvisionResult,
    errorName: 'WorkspaceProvisionError',
    typedCodes: [
      'unsupported_kind',
      'invalid_path',
      'path_conflict',
      'fs_quota_exceeded',
      'fs_unavailable',
      'registry_unavailable',
      'internal_error',
    ],
    makeTypedError: (code, message) =>
      new WorkspaceProvisionError(code as never, message),
    foreignError: () =>
      // `agent_dir_collision` is an agent_materialize code, NOT a
      // workspace_provision code. `intentErrorSchema(intent)` must
      // reject it -> squashed to internal_error.
      new WorkspaceProvisionError('agent_dir_collision' as never, 'leaked'),
    malformedParams: { workspace_id: 'ws_1' },
    malformedComment: 'Missing required `kind`.',
    bareError: true,
  },
  {
    label: 'agent_workspace_index',
    intent: 'agent_workspace_index',
    requestPrefix: 'req-awi',
    handlerKey: 'agentWorkspaceIndexHandler',
    params: indexParams,
    result: {
      ok: true,
      entries: [
        {
          workspace_id: 'ws_1',
          agent_dir: '/tmp/ws_1/.silverhand/agents/aid_x',
        },
      ],
      unresolved: [],
    } satisfies AgentWorkspaceIndexResult,
    errorName: 'AgentWorkspaceIndexError',
    typedCodes: ['registry_unavailable', 'internal_error'],
    makeTypedError: (code, message) =>
      new AgentWorkspaceIndexError(code as never, message),
    foreignError: () =>
      // `unsupported_kind` belongs to workspace_provision, not here.
      new AgentWorkspaceIndexError('unsupported_kind' as never, 'leaked'),
    malformedParams: { agent_id: 'aid_x', workspace_ids: 'ws_1' },
    malformedComment: '`workspace_ids` must be an array.',
  },
  {
    label: 'agent_l2_seed',
    intent: 'agent_l2_seed',
    requestPrefix: 'req-l2s',
    handlerKey: 'agentL2SeedHandler',
    params: l2SeedParams,
    result: {
      ok: true,
      seeded: true,
      l2_present: true,
    } satisfies AgentL2SeedResult,
    errorName: 'AgentL2SeedError',
    typedCodes: [
      'workspace_not_provisioned',
      'registry_unavailable',
      'unsupported_template',
      'fs_unavailable',
      'internal_error',
    ],
    makeTypedError: (code, message) =>
      new AgentL2SeedError(code as never, message),
    foreignError: () =>
      // `unsupported_kind` belongs to workspace_provision, not here.
      new AgentL2SeedError('unsupported_kind' as never, 'leaked'),
    malformedParams: { agent_id: 'aid_member' },
    malformedComment: 'Missing required `workspace_id`.',
    bareError: true,
  },
  {
    label: 'agent_files_purge',
    intent: 'agent_files_purge',
    requestPrefix: 'req-afp',
    handlerKey: 'agentFilesPurgeHandler',
    params: purgeParams,
    result: {
      ok: true,
      purged_count: 2,
      skipped_unprovisioned: 0,
    } satisfies AgentFilesPurgeResult,
    errorName: 'AgentFilesPurgeError',
    typedCodes: ['partial_purge', 'registry_unavailable', 'internal_error'],
    makeTypedError: (code, message) =>
      new AgentFilesPurgeError(code as never, message),
    foreignError: () =>
      // `workspace_not_provisioned` belongs to agent_l2_seed, not here.
      new AgentFilesPurgeError('workspace_not_provisioned' as never, 'leaked'),
    malformedParams: { agent_id: 'aid_member' },
    malformedComment: 'Missing required `scope`.',
    bareError: true,
  },
];

describe.each(registryIntentCases)(
  'IntentDispatcher.$label slot',
  testCase => {
    it('routes a valid intent to the handler and returns its result', async () => {
      let observed: unknown = null;
      const d = dispatcherWithHandler(testCase.handlerKey, params => {
        observed = params;
        return testCase.result;
      });

      const id = `${testCase.requestPrefix}-1`;
      const r = await d.dispatch(
        id,
        testCase.intent,
        testCase.params as never,
      );

      expect(r).toEqual({ id, result: testCase.result });
      expect(observed).toEqual(testCase.params);
    });

    it.each(testCase.typedCodes)(
      `preserves typed ${testCase.errorName} code: %s`,
      async code => {
        const d = dispatcherWithHandler(testCase.handlerKey, () => {
          throw testCase.makeTypedError(code, `seeded ${code}`);
        });

        await expectErrorCode(
          d.dispatch(
            `${testCase.requestPrefix}-typed`,
            testCase.intent,
            testCase.params as never,
          ),
          code,
        );
      },
    );

    it(`re-squashes a foreign typed code not in ${testCase.label} schema`, async () => {
      const d = dispatcherWithHandler(testCase.handlerKey, () => {
        // Typed surface is decided by per-intent schema, not by class.
        throw testCase.foreignError();
      });

      await expectErrorCode(
        d.dispatch(
          `${testCase.requestPrefix}-foreign`,
          testCase.intent,
          testCase.params as never,
        ),
        'internal_error',
      );
    });

    if (testCase.bareError) {
      it('squashes a bare Error throw to internal_error', async () => {
        const d = dispatcherWithHandler(testCase.handlerKey, () => {
          throw new Error('boom');
        });

        await expectErrorCode(
          d.dispatch(
            `${testCase.requestPrefix}-bare`,
            testCase.intent,
            testCase.params as never,
          ),
          'internal_error',
        );
      });
    }

    it(
      `rejects malformed params via intentSchemas before invoking the handler (${testCase.malformedComment})`,
      async () => {
        let called = false;
        const d = dispatcherWithHandler(testCase.handlerKey, () => {
          called = true;
          throw new Error('unreachable');
        });

        await expectErrorCode(
          d.dispatch(
            `${testCase.requestPrefix}-bad`,
            testCase.intent,
            testCase.malformedParams as never,
          ),
          'invalid_params',
        );
        expect(called).toBe(false);
      },
    );

    it('surfaces internal_error when no handler is wired', async () => {
      const d = new IntentDispatcher({ logger: silentLogger() });

      const r = await expectErrorCode(
        d.dispatch(
          `${testCase.requestPrefix}-unwired`,
          testCase.intent,
          testCase.params as never,
        ),
        'internal_error',
      );
      expect(r.error.message).toContain(testCase.intent);
    });
  },
);

describe('IntentDispatcher.workspace_provision extras', () => {
  it('forwards an optional requested_path through to the handler', async () => {
    let observed: WorkspaceProvisionParams | null = null;
    const d = dispatcherWithHandler('workspaceProvisionHandler', params => {
      observed = params;
      return {
        ok: true,
        provisioned: true,
        bound_workspace_path: '/Users/alice/work/ws',
      } satisfies WorkspaceProvisionResult;
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
    const d = dispatcherWithHandler('workspaceProvisionHandler', () => {
      called = true;
      throw new Error('unreachable');
    });

    await expectErrorCode(
      d.dispatch('req-wp-badpath', 'workspace_provision', {
        workspace_id: 'ws_1',
        kind: 'regular',
        requested_path: 123,
      }),
      'invalid_params',
    );
    expect(called).toBe(false);
  });
});

describe('IntentDispatcher.agent_l2_seed extras', () => {
  it('applies the template_choice default when omitted', async () => {
    let observed: AgentL2SeedParams | null = null;
    const d = dispatcherWithHandler('agentL2SeedHandler', params => {
      observed = params;
      return { ok: true, seeded: true, l2_present: true } satisfies AgentL2SeedResult;
    });

    await d.dispatch('req-l2s-default', 'agent_l2_seed', {
      agent_id: 'aid_member',
      workspace_id: 'ws_1',
    });

    expect((observed as AgentL2SeedParams | null)?.template_choice).toBe('default');
  });

  it('rejects an out-of-enum template_choice via intentSchemas before the handler', async () => {
    let called = false;
    const d = dispatcherWithHandler('agentL2SeedHandler', () => {
      called = true;
      throw new Error('unreachable');
    });

    await expectErrorCode(
      d.dispatch('req-l2s-badtpl', 'agent_l2_seed', {
        agent_id: 'aid_member',
        workspace_id: 'ws_1',
        template_choice: 'bogus',
      }),
      'invalid_params',
    );
    expect(called).toBe(false);
  });
});

describe('IntentDispatcher.agent_files_purge extras', () => {
  it('applies the workspace_ids default ([]) when omitted', async () => {
    let observed: AgentFilesPurgeParams | null = null;
    const d = dispatcherWithHandler('agentFilesPurgeHandler', params => {
      observed = params;
      return {
        ok: true,
        purged_count: 0,
        skipped_unprovisioned: 0,
      } satisfies AgentFilesPurgeResult;
    });

    await d.dispatch('req-afp-default', 'agent_files_purge', {
      agent_id: 'aid_member',
      scope: 'all',
    });

    expect((observed as AgentFilesPurgeParams | null)?.workspace_ids).toEqual([]);
  });

  it('rejects an out-of-enum scope via intentSchemas before the handler', async () => {
    let called = false;
    const d = dispatcherWithHandler('agentFilesPurgeHandler', () => {
      called = true;
      throw new Error('unreachable');
    });

    await expectErrorCode(
      d.dispatch('req-afp-badscope', 'agent_files_purge', {
        agent_id: 'aid_member',
        scope: 'bogus',
        workspace_ids: ['ws_1'],
      }),
      'invalid_params',
    );
    expect(called).toBe(false);
  });
});
