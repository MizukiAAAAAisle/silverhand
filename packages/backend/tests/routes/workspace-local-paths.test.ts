import { afterEach, describe, expect, it } from 'vitest';
import {
  apiPaths,
  WorkspaceLocalPathsResponseSchema,
} from '@silverhand/shared';
import { HostRepo } from '../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('GET /api/workspaces/local-paths', () => {
  let t: TestApp | null = null;

  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns only daemon-stamped roots for viewer-visible workspaces', async () => {
    t = buildTestApp();
    await http(t).post(apiPaths.agents, {
      name: 'path-owner',
      runtime: 'claude',
    });
    await http(t).post(apiPaths.workspaces, {
      name: 'path-regular',
      member_agent_ids: [],
    });
    const listed = (await (
      await http(t).get(apiPaths.workspaces)
    ).json()) as { workspaces: Array<{ id: string }> };
    const visibleIds = listed.workspaces.map(workspace => workspace.id).sort();

    t.fakeHostWs!.workspacePathIndexAckOverride = params => ({
      ok: true,
      entries: [
        ...params.workspaces.map(workspace => ({
          workspace_id: workspace.workspace_id,
          path: `/daemon-authority/${workspace.workspace_id}`,
        })),
        // Authenticated daemon responses are still perimeter-filtered to the
        // ids the backend authorized for this host/request.
        { workspace_id: 'not-requested', path: '/must-not-leak' },
      ],
      unresolved: [],
    });

    const response = await http(t).get(apiPaths.workspaceLocalPaths);
    expect(response.status).toBe(200);
    const body = WorkspaceLocalPathsResponseSchema.parse(await response.json());
    expect(body.entries.map(entry => entry.workspace_id).sort()).toEqual(
      visibleIds,
    );
    expect(body.entries).not.toContainEqual({
      workspace_id: 'not-requested',
      path: '/must-not-leak',
    });
    expect(body.unavailable_workspace_ids).toEqual([]);

    const calls = t.fakeHostWs!.calls.filter(
      call => call.kind === 'workspace_path_index',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).not.toHaveProperty('workspace_path');
    expect(
      (calls[0]!.params.workspaces as Array<Record<string, unknown>>).every(
        workspace => !('path' in workspace),
      ),
    ).toBe(true);
  });

  it('degrades every visible workspace to unavailable when its daemon is offline', async () => {
    t = buildTestApp();
    await http(t).post(apiPaths.workspaces, {
      name: 'offline-path',
      member_agent_ids: [],
    });
    const listed = (await (
      await http(t).get(apiPaths.workspaces)
    ).json()) as { workspaces: Array<{ id: string }> };
    t.fakeHostWs!.connectionIdForHostOverride = () => null;

    const response = await http(t).get(apiPaths.workspaceLocalPaths);
    expect(response.status).toBe(200);
    const body = WorkspaceLocalPathsResponseSchema.parse(await response.json());
    expect(body.entries).toEqual([]);
    expect(body.unavailable_workspace_ids.sort()).toEqual(
      listed.workspaces.map(workspace => workspace.id).sort(),
    );
  });

  it('groups authorized workspaces by computer and never queries hidden workspaces', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const hosts = new HostRepo(t.ctx.db);
    const localHost = hosts.getOwnedLocalForUser(t.viewerUserId)!;
    const remoteHost = hosts.create('remote-path-host', 'local', {
      userId: t.viewerUserId,
      installationId: 'remote-path-installation',
      lastSeenAt: Date.now(),
    });
    const workspaces = new WorkspaceRepo(t.ctx.db);
    const localWorkspace = workspaces.insert({
      name: 'visible-local-path',
      description: null,
      workspacePath: '/stale/local',
      workspaceHostId: localHost.id,
    });
    workspaces.addUserMember(localWorkspace.id, t.viewerUserId, 'owner');
    const remoteWorkspace = workspaces.insert({
      name: 'visible-remote-path',
      description: null,
      workspacePath: '/stale/remote',
      workspaceHostId: remoteHost.id,
    });
    workspaces.addUserMember(remoteWorkspace.id, t.viewerUserId, 'owner');
    const hiddenWorkspace = workspaces.insert({
      name: 'hidden-path',
      description: null,
      workspacePath: '/must-not-query',
      workspaceHostId: remoteHost.id,
    });

    t.fakeHostWs!.workspacePathIndexAckOverride = params => ({
      ok: true,
      entries: params.workspaces.map(workspace => ({
        workspace_id: workspace.workspace_id,
        path: `/daemon-authority/${workspace.workspace_id}`,
      })),
      unresolved: [],
    });

    const response = await http(t).get(apiPaths.workspaceLocalPaths);
    expect(response.status).toBe(200);
    const body = WorkspaceLocalPathsResponseSchema.parse(await response.json());
    expect(body.entries).toEqual(
      expect.arrayContaining([
        {
          workspace_id: localWorkspace.id,
          path: `/daemon-authority/${localWorkspace.id}`,
        },
        {
          workspace_id: remoteWorkspace.id,
          path: `/daemon-authority/${remoteWorkspace.id}`,
        },
      ]),
    );
    expect(body.entries.map(entry => entry.workspace_id)).not.toContain(
      hiddenWorkspace.id,
    );

    const calls = t.fakeHostWs!.calls.filter(
      call => call.kind === 'workspace_path_index',
    );
    expect(calls.map(call => call.hostId)).toEqual(
      expect.arrayContaining([localHost.id, remoteHost.id]),
    );
    expect(
      calls.flatMap(call =>
        (
          call.params.workspaces as Array<{ workspace_id: string }>
        ).map(workspace => workspace.workspace_id),
      ),
    ).not.toContain(hiddenWorkspace.id);
  });
});
