import { describe, expect, it } from 'vitest';
import {
  planRuntimeStartFilesystemEnsure,
  type EnsurePlanWorkspace,
} from '../../src/runtime/runtime-filesystem-plan.js';

/**
 * Cross-computer slice 1 (#task:1596) / #task:1612 — the pure ensure plan.
 * Pins the authority boundaries the fanout wiring consumes:
 *   - ONLY the active workspace is planned (peers never enter the spawn
 *     critical path — Cindy review round 1);
 *   - the spawn path plans NO provision and carries NO path: only the L2
 *     seed target (the registry is the sole authority; a missing binding
 *     surfaces as the seed's typed workspace_not_provisioned);
 *   - agent_home never produces a seed target.
 */

function ws(over: Partial<EnsurePlanWorkspace>): EnsurePlanWorkspace {
  return {
    id: 'ws1',
    workspace_kind: 'regular',
    ...over,
  };
}

describe('planRuntimeStartFilesystemEnsure', () => {
  it('regular active workspace: seed target only — no provision row, no path anywhere in the plan', () => {
    const plan = planRuntimeStartFilesystemEnsure(ws({}));
    expect(plan).toEqual({ seedWorkspaceId: 'ws1' });
  });

  it('agent_home active workspace: no seed target (daemon resolves homedir-side)', () => {
    expect(planRuntimeStartFilesystemEnsure(ws({ workspace_kind: 'agent_home' }))).toEqual({
      seedWorkspaceId: null,
    });
  });

  it('missing primary workspace row: nothing to ensure', () => {
    expect(planRuntimeStartFilesystemEnsure(undefined)).toEqual({
      seedWorkspaceId: null,
    });
  });
});
