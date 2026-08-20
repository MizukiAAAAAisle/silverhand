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
 *     seed target, resolved daemon-side to the deterministic agent-centric
 *     bundle coordinate (relocation-v1 §7 task 4 — no registry authority; a
 *     hard fs failure surfaces as the seed's typed fs_unavailable);
 *   - agent_home never produces a seed target.
 */

function ws(over: Partial<EnsurePlanWorkspace>): EnsurePlanWorkspace {
  return {
    id: 'ws1',
    owner_agent_id: null,
    ...over,
  };
}

describe('planRuntimeStartFilesystemEnsure', () => {
  it('regular active workspace: seed target only — no provision row, no path anywhere in the plan', () => {
    const plan = planRuntimeStartFilesystemEnsure(ws({}));
    expect(plan).toEqual({ seedWorkspaceId: 'ws1' });
  });

  it('agent_home active workspace: no seed target (daemon resolves homedir-side)', () => {
    expect(planRuntimeStartFilesystemEnsure(ws({ owner_agent_id: 'agent1' }))).toEqual({
      seedWorkspaceId: null,
    });
  });

  it('another agent’s home is still a home: no seed target', () => {
    // The plan asks "does this container have a home agent AT ALL", NOT "is it
    // THIS agent's". A foreign agent's home has no L2 to seed either, so an
    // ownership-of-the-spawning-agent test here would newly hand back a seed
    // target for a container that has never had one — a behavior change hiding
    // inside a rename. The spawning agent's id is not even an input.
    expect(planRuntimeStartFilesystemEnsure(ws({ owner_agent_id: 'someoneElse' })))
      .toEqual({ seedWorkspaceId: null });
  });

  it('missing primary workspace row: nothing to ensure', () => {
    expect(planRuntimeStartFilesystemEnsure(undefined)).toEqual({
      seedWorkspaceId: null,
    });
  });
});
