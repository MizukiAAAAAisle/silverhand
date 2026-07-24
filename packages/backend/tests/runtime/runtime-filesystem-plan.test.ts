import { describe, expect, it } from 'vitest';
import {
  planRuntimeStartFilesystemEnsure,
  type EnsurePlanWorkspace,
} from '../../src/runtime/runtime-filesystem-plan.js';

/**
 * Cross-computer slice 1 (#task:1596) — the pure ensure plan. Pins the
 * authority boundaries that the fanout wiring consumes:
 *   - ONLY the active workspace is planned (peers never enter the spawn
 *     critical path — Cindy review round 1);
 *   - same-host active workspace re-binds with the legacy home path
 *     (migration behavior unchanged);
 *   - a cross-host (guest) active workspace provisions with NO path — the
 *     home computer's path never crosses to a guest daemon;
 *   - the active workspace row id is also the (only) seed target;
 *   - agent_home never produces a row or a seed.
 */

const HOST = 'computer-a';
const OTHER_HOST = 'computer-b';

function ws(over: Partial<EnsurePlanWorkspace>): EnsurePlanWorkspace {
  return {
    id: 'ws1',
    workspace_kind: 'regular',
    workspace_host_id: HOST,
    workspace_path: '/home/ws1',
    ...over,
  };
}

describe('planRuntimeStartFilesystemEnsure', () => {
  it('same-host active workspace: blocking row keeps the legacy home path + seed target', () => {
    const plan = planRuntimeStartFilesystemEnsure(HOST, ws({}));
    expect(plan).toEqual({
      primaryRow: { id: 'ws1', workspace_path: '/home/ws1' },
    });
  });

  it('cross-host (guest) active workspace: NO requested path — home path never crosses computers', () => {
    const plan = planRuntimeStartFilesystemEnsure(
      HOST,
      ws({ workspace_host_id: OTHER_HOST, workspace_path: '/home/on/other' }),
    );
    expect(plan).toEqual({
      primaryRow: { id: 'ws1', workspace_path: null },
    });
    expect(JSON.stringify(plan)).not.toContain('/home/on/other');
  });

  it('agent_home active workspace: no provision row, no seed (daemon resolves homedir-side)', () => {
    const plan = planRuntimeStartFilesystemEnsure(
      HOST,
      ws({ workspace_kind: 'agent_home' }),
    );
    expect(plan).toEqual({ primaryRow: null });
  });

  it('missing primary workspace row: nothing to ensure', () => {
    expect(planRuntimeStartFilesystemEnsure(HOST, undefined)).toEqual({
      primaryRow: null,
    });
  });
});
