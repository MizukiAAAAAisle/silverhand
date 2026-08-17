import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * #task:2050 §4-B — the workspace-rename liveness producer.
 *
 * A rename already announces itself INSIDE each channel (a system message on
 * the stream). That reaches members looking at a channel; it does NOT reach the
 * human read models that render a workspace label from OUTSIDE any one channel —
 * Saved's `place.workspace_name`, Search, the workspace list. Those subscribe
 * per-viewer, so the rename must fan a `viewer_workspaces_changed` hint with
 * `change: 'metadata_changed'` to every human member of the workspace, each of
 * whom then refetches `['workspaces']` as the authority.
 *
 * These are producer-side assertions: the emit rides the rename branch (not
 * every metadata write), reaches exactly the workspace's human members, and
 * carries no `role` (the viewer's role did not move).
 */
async function createRegularWorkspace(t: TestApp, name: string): Promise<string> {
  const created = await (
    await http(t).post('/api/workspaces', { name, member_agent_ids: [] })
  ).json() as any;
  return created.workspace.id;
}

describe('#task:2050 §4-B — workspace rename fans metadata_changed to human viewers', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('emits viewer_workspaces_changed{metadata_changed} to every human member on rename', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    // createWorkspace stamps the creator ('local') an owner workspace_user;
    // with fixture auto-membership off, the member set is exactly what we add,
    // so add a second human to prove the fan-out reaches every member.
    const workspaceId = await createRegularWorkspace(t, 'rename-me');
    new WorkspaceRepo(t.ctx.db).addUserMember(workspaceId, 'teammate');

    const localEvents: Array<{ kind: string; payload: unknown }> = [];
    const teammateEvents: Array<{ kind: string; payload: unknown }> = [];
    const strangerEvents: Array<{ kind: string; payload: unknown }> = [];
    const offLocal = t.ctx.events.subscribeScope('viewer:local', e =>
      localEvents.push({ kind: e.kind, payload: e.payload }),
    );
    const offTeammate = t.ctx.events.subscribeScope('viewer:teammate', e =>
      teammateEvents.push({ kind: e.kind, payload: e.payload }),
    );
    // A human who is NOT a member of this workspace must never hear the hint.
    const offStranger = t.ctx.events.subscribeScope('viewer:stranger', e =>
      strangerEvents.push({ kind: e.kind, payload: e.payload }),
    );

    const res = await http(t).patch(apiPaths.workspace(workspaceId), {
      name: 'renamed-ws',
    });
    offLocal();
    offTeammate();
    offStranger();
    expect(res.status).toBe(200);

    const expected = {
      kind: 'viewer_workspaces_changed',
      payload: { change: 'metadata_changed', workspace_id: workspaceId },
    };
    expect(localEvents).toContainEqual(expected);
    expect(teammateEvents).toContainEqual(expected);
    // No `role` field on a metadata_changed hint (the viewer's role is unchanged).
    const localHint = localEvents.find(e => e.kind === 'viewer_workspaces_changed');
    expect(localHint?.payload).not.toHaveProperty('role');
    expect(
      strangerEvents.some(e => e.kind === 'viewer_workspaces_changed'),
    ).toBe(false);
  });

  it('does NOT emit when the PATCH leaves the name unchanged', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const workspaceId = await createRegularWorkspace(t, 'stable-name');

    const localEvents: Array<{ kind: string; payload: unknown }> = [];
    const offLocal = t.ctx.events.subscribeScope('viewer:local', e =>
      localEvents.push({ kind: e.kind, payload: e.payload }),
    );
    const res = await http(t).patch(apiPaths.workspace(workspaceId), {
      name: 'stable-name',
    });
    offLocal();
    expect(res.status).toBe(200);
    expect(
      localEvents.some(e => e.kind === 'viewer_workspaces_changed'),
    ).toBe(false);
  });
});
