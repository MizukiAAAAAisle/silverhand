import { describe, expect, it } from 'vitest';
import {
  ComputerHasDependentsError,
  ComputerHasPendingAgentsError,
  interpretDeleteComputerError,
} from './hooks';
import { ApiError } from '@/lib/api';

/**
 * #task:1354 — contract-boundary parse for the Delete-computer flow. The
 * risky part isn't the mutation plumbing, it's mapping the backend's
 * `409 has_dependents` envelope onto the typed error the UI renders as the
 * dependency-block state. These pin the shared-schema shape (nested
 * `dependents`, `error_code` discriminator) so a future wire drift fails
 * here instead of silently rendering a generic "couldn't delete".
 */
describe('interpretDeleteComputerError', () => {
  function api409(body: unknown): ApiError {
    return new ApiError(409, 'Conflict', JSON.stringify(body));
  }

  it('maps a 409 has_dependents envelope to a typed error with counts', () => {
    const out = interpretDeleteComputerError(
      api409({
        error: 'computer still has dependents',
        error_code: 'has_dependents',
        dependents: { agents: 3, workspaces: 2 },
      }),
    );
    expect(out).toBeInstanceOf(ComputerHasDependentsError);
    expect((out as ComputerHasDependentsError).dependents).toEqual({
      agents: 3,
      workspaces: 2,
    });
    // #task:1380 — absent `can_cascade_agents` defaults false (a mixed /
    // workspace-pinned computer is NOT agent-cascade-able), so the UI keeps the
    // hard block rather than offering a cascade confirm. An absent `agents`
    // list defaults to empty (the block state renders counts, not identities).
    expect((out as ComputerHasDependentsError).canCascadeAgents).toBe(false);
    expect((out as ComputerHasDependentsError).agents).toEqual([]);
  });

  it('carries can_cascade_agents=true + the agent delete-set for an agent-only dependency set', () => {
    // #task:1380 — the agent-cascade discriminator + the identities the cascade
    // confirm lists under "Agents will be removed". The list is the backend's
    // DB delete-set (shown == deleted, populated even offline); it rides the
    // same typed error alongside the boolean.
    const out = interpretDeleteComputerError(
      api409({
        error: 'computer still has dependents',
        error_code: 'has_dependents',
        dependents: { agents: 2, workspaces: 0 },
        can_cascade_agents: true,
        agents: [
          { id: 'a1', name: 'norman', display_name: 'Norman', runtime: 'claude' },
          { id: 'a2', name: 'cindy', display_name: 'Cindy', runtime: 'codex' },
        ],
      }),
    );
    expect(out).toBeInstanceOf(ComputerHasDependentsError);
    expect((out as ComputerHasDependentsError).dependents).toEqual({
      agents: 2,
      workspaces: 0,
    });
    expect((out as ComputerHasDependentsError).canCascadeAgents).toBe(true);
    expect((out as ComputerHasDependentsError).agents).toEqual([
      { id: 'a1', name: 'norman', display_name: 'Norman', runtime: 'claude' },
      { id: 'a2', name: 'cindy', display_name: 'Cindy', runtime: 'codex' },
    ]);
  });

  it('maps a 409 has_pending_agents envelope to the transient typed error', () => {
    // #task:1380 — the pending block is its OWN axis, never `has_dependents`.
    // If it collapsed into the dependency error it would render a cascade
    // confirm on a transient state → confirm/re-409 dead-end (Alice invariant).
    const out = interpretDeleteComputerError(
      api409({
        error: 'agent creation still in progress',
        error_code: 'has_pending_agents',
        pending_agents: 1,
      }),
    );
    expect(out).toBeInstanceOf(ComputerHasPendingAgentsError);
    expect(out).not.toBeInstanceOf(ComputerHasDependentsError);
    expect((out as ComputerHasPendingAgentsError).pendingAgents).toBe(1);
  });

  it('passes through an unrelated 409 (not the dependency block)', () => {
    const err = api409({ error: 'nope', error_code: 'host_already_active' });
    expect(interpretDeleteComputerError(err)).toBe(err);
    expect(interpretDeleteComputerError(err)).not.toBeInstanceOf(
      ComputerHasDependentsError,
    );
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
