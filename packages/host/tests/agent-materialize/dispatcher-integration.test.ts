import { describe, expect, it } from 'vitest';
import { IntentDispatcher } from '../../src/daemon/dispatcher.js';
import {
  AgentMaterializeError,
} from '../../src/daemon/agent-materialize/index.js';
import { createDaemonLogControl, type DaemonLogger } from '../../src/daemon/logger.js';
import type {
  AgentMaterializeParams,
  AgentMaterializeResult,
} from '../../src/protocol.js';

/**
 * D4.d D2 dispatcher integration. Two pins:
 *
 *   1. `agent_materialize` slot is wired (route the intent to the
 *      injected handler, validate params via `intentSchemas`).
 *   2. Typed errors thrown by the handler (`AgentMaterializeError`)
 *      survive the dispatcher's catch arm with their code — they
 *      do NOT get squashed into `internal_error` (Cindy D2 pre-gate
 *      #3). All other thrown errors still squash to `internal_error`
 *      so we don't leak arbitrary error codes onto the wire.
 */

function silentLogger(): DaemonLogger {
  const calls: Array<[string, unknown]> = [];
  return {
    filePath: '/dev/null',
    logControl: createDaemonLogControl('debug'),
    debug: () => {},
    info: () => {},
    warn: (obj: unknown, msg?: string) => {
      calls.push(['warn', { obj, msg }]);
    },
    error: () => {},
    close: async () => {},
    // expose for test inspection
    _calls: calls,
  } as unknown as DaemonLogger;
}

function validParams(): AgentMaterializeParams {
  return {
    agent_id: 'aid_route_ok',
    agent_home_workspace_id: 'wsah_aid_route_ok',
    name: 'TestAgent',
    runtime: 'claude',
    template_choice: 'default',
  };
}

describe('IntentDispatcher.agent_materialize slot', () => {
  it('routes a valid agent_materialize intent to the handler and returns its result', async () => {
    const handlerResult: AgentMaterializeResult = {
      ok: true,
      agent_dir: '/tmp/wired/aid_route_ok',
      agent_home_workspace_path: '/tmp/wired/aid_route_ok',
      materialized_at: 1_700_000_000_000,
    };
    let observed: AgentMaterializeParams | null = null;

    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentMaterializeHandler: params => {
        observed = params;
        return handlerResult;
      },
    });

    const r = await d.dispatch('req-am-1', 'agent_materialize', validParams());
    expect(r).toEqual({ id: 'req-am-1', result: handlerResult });
    expect(observed).toEqual(validParams());
  });

  it('preserves the typed AgentMaterializeError.code on the response frame', async () => {
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentMaterializeHandler: () => {
        throw new AgentMaterializeError(
          'agent_dir_collision',
          'sentinel mismatch on runtime',
        );
      },
    });

    const r = await d.dispatch('req-am-collision', 'agent_materialize', validParams());
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    // Typed code surfaces verbatim — NOT 'internal_error'.
    // The cast through `unknown` is intentional; the IPC
    // ResponseError type narrows to the 5 generic codes, but the
    // dispatcher's `typedErrorFrame` helper widens for this case
    // so the outbound layer's per-command error schema can encode
    // the typed value.
    expect((r.error as { code: string }).code).toBe('agent_dir_collision');
    expect(r.error.message).toBe('sentinel mismatch on runtime');
  });

  it.each([
    'fs_quota_exceeded',
    'fs_unavailable',
    'unsupported_template',
    'unsupported_runtime',
    'internal_error',
  ] as const)('preserves typed error code: %s', async code => {
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentMaterializeHandler: () => {
        throw new AgentMaterializeError(code, `seeded ${code}`);
      },
    });
    const r = await d.dispatch('req-am', 'agent_materialize', validParams());
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect((r.error as { code: string }).code).toBe(code);
  });

  it('still squashes non-AgentMaterializeError throws to internal_error', async () => {
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentMaterializeHandler: () => {
        // A bare Error MUST squash to `internal_error`. Otherwise
        // an unrelated runtime exception could leak its message-
        // shaped `code` onto the wire — that was the original
        // motivation for the catch-arm narrowing.
        const err = new Error('disk plate exploded');
        (err as NodeJS.ErrnoException).code = 'ENOSPC';
        throw err;
      },
    });
    const r = await d.dispatch('req-am-bare', 'agent_materialize', validParams());
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('internal_error');
    // The fs error's `code` is informational only; it must NOT
    // become the wire code. Recoverable / unavailable / collision
    // routing comes through the typed `AgentMaterializeError`
    // path that `classifyFsError` builds.
    expect((r.error as { code: string }).code).not.toBe('ENOSPC');
  });

  it('rejects malformed params via intentSchemas before invoking the handler', async () => {
    let handlerCalled = false;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      agentMaterializeHandler: () => {
        handlerCalled = true;
        throw new Error('should not be reached');
      },
    });

    // Missing required `agent_home_workspace_id`.
    const r = await d.dispatch('req-am-bad', 'agent_materialize', {
      agent_id: 'aid_bad',
      name: 'X',
      runtime: 'claude',
    });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('invalid_params');
    expect(handlerCalled).toBe(false);
  });

  it('returns internal_error when no agentMaterializeHandler is wired', async () => {
    // Mirrors the host_outbound_* slot pattern: slot absence is a
    // wiring bug, surfaced as `internal_error` rather than a
    // crash. This is what tests of the PR-1 protocol-only surface
    // see if they accidentally dispatch the intent.
    const d = new IntentDispatcher({ logger: silentLogger() });
    const r = await d.dispatch('req-am-unwired', 'agent_materialize', validParams());
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error.code).toBe('internal_error');
    expect(r.error.message).toContain('agent_materialize');
  });
});
