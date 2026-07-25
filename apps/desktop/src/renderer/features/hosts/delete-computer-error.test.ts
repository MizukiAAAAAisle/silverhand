import { describe, expect, it } from 'vitest';
import {
  ComputerHasPendingAgentsError,
  interpretDeleteComputerError,
} from './hooks';
import { ApiError } from '@/lib/api';

/**
 * #task:1354 / #task:1618 — contract-boundary parse for the Delete-computer
 * flow. After the two-step rework there is exactly ONE typed mapping left:
 * `409 has_pending_agents`, the only refusal the dialog cannot learn from its
 * `/resources` read (a query lists objects, it does not predict whether the
 * command will succeed). These pin that discriminator plus the pass-through
 * behaviour, so a wire drift fails here instead of silently rendering the
 * transient state as a permanent "couldn't delete".
 *
 * The removed cases are deliberate, not forgotten: `has_dependents`,
 * `dependents_changed` and `workspace_forbidden` no longer have typed branches —
 * see `interpretDeleteComputerError` for why they must fold into the generic
 * line.
 */
describe('interpretDeleteComputerError', () => {
  function api409(body: unknown): ApiError {
    return new ApiError(409, 'Conflict', JSON.stringify(body));
  }

  it('maps a 409 has_pending_agents envelope to the transient typed error', () => {
    const out = interpretDeleteComputerError(
      api409({
        error: 'agent creation still in progress',
        error_code: 'has_pending_agents',
        pending_agents: 1,
      }),
    );
    expect(out).toBeInstanceOf(ComputerHasPendingAgentsError);
    expect((out as ComputerHasPendingAgentsError).pendingAgents).toBe(1);
  });

  it('passes a 409 has_dependents through untyped', () => {
    // Unreachable from the dialog by construction: the preview already showed
    // what is on the computer, and the confirm always sends the flag. It stays a
    // backend guard for callers that skipped the preview, so the UI treats it as
    // a plain failure rather than rebuilding a discovery screen for it.
    const err = api409({
      error: 'computer still has dependents',
      error_code: 'has_dependents',
      dependents: { agents: 3, workspaces: 2 },
    });
    expect(interpretDeleteComputerError(err)).toBe(err);
    expect(interpretDeleteComputerError(err)).not.toBeInstanceOf(
      ComputerHasPendingAgentsError,
    );
  });

  it('passes a 403 workspace_forbidden through untyped', () => {
    // Ownership is named in the PREVIEW (`viewer_role`), which is where the user
    // can still act on it. A 403 after a confirm means drift — a rare,
    // recoverable state that gets the generic failure line, not its own screen.
    const err = new ApiError(
      403,
      'Forbidden',
      JSON.stringify({
        error: 'not the workspace owner',
        error_code: 'workspace_forbidden',
        workspaces: [
          {
            id: 'w9',
            name: 'not-mine',
            workspace_path: '/tmp/w9',
            viewer_role: 'member',
          },
        ],
      }),
    );
    expect(interpretDeleteComputerError(err)).toBe(err);
  });

  it('passes through an unrelated 409', () => {
    const err = api409({ error: 'nope', error_code: 'host_already_active' });
    expect(interpretDeleteComputerError(err)).toBe(err);
  });

  it('passes through a non-409 ApiError unchanged', () => {
    const err = new ApiError(404, 'Not Found', '{"error_code":"host_not_found"}');
    expect(interpretDeleteComputerError(err)).toBe(err);
  });

  it('does not misfire on a malformed / non-JSON 409 body', () => {
    const err = new ApiError(409, 'Conflict', '<html>gateway</html>');
    expect(interpretDeleteComputerError(err)).toBe(err);
  });

  it('wraps a non-Error thrown value', () => {
    const out = interpretDeleteComputerError('boom');
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe('boom');
  });
});
