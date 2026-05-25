import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { RuntimeHostPlacementResolver } from '../../src/runtime/host-placement.js';
import { openTestDb } from '../utils/db.js';

function makeResolver() {
  const { db, viewerUserId } = openTestDb();
  const hosts = new HostRepo(db);
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db, {
    workspacesRoot: '/tmp/silverhand-test-workspaces',
  });
  const placement = new RuntimeHostPlacementResolver({
    hosts,
    agents,
    workspaces,
  });
  return { db, viewerUserId, hosts, agents, workspaces, placement };
}

describe('RuntimeHostPlacementResolver', () => {
  it('resolves an agent to its active host', () => {
    const t = makeResolver();
    const host = t.hosts.create('owned-local', 'local', {
      userId: t.viewerUserId,
      installationId: 'install-1',
    });
    const agent = t.agents.create(
      { name: 'alice', runtime: 'claude' },
      host.id,
      t.viewerUserId,
    );

    expect(t.placement.resolveForAgent(agent.id)).toEqual({ host });
  });

  it('fails closed for missing and revoked hosts', () => {
    const t = makeResolver();
    expect(() => t.placement.assertActiveHost('missing')).toThrowError(
      expect.objectContaining({ code: 'host_missing' }),
    );

    const host = t.hosts.create('owned-local', 'local', {
      userId: t.viewerUserId,
      installationId: 'install-1',
    });
    t.hosts.revoke(host.id, 1_700_000_000_000);
    expect(() => t.placement.assertActiveHost(host.id)).toThrowError(
      expect.objectContaining({ code: 'host_revoked' }),
    );
  });

  it('requires explicit placement hosts to be owned by the current user', () => {
    const t = makeResolver();
    const otherHost = t.hosts.create('other-local', 'local', {
      userId: 'other',
      installationId: 'other-install',
    });

    expect(() =>
      t.placement.assertOwnedActiveHost(otherHost.id, t.viewerUserId),
    ).toThrowError(expect.objectContaining({ code: 'host_not_owned' }));
  });

  it('resolves only active owned local hosts for default create placement', () => {
    const t = makeResolver();
    expect(() =>
      t.placement.resolveOwnedLocalForUser(t.viewerUserId),
    ).toThrowError(expect.objectContaining({ code: 'local_host_unbound' }));

    const owned = t.hosts.create('owned-local', 'local', {
      userId: t.viewerUserId,
      installationId: 'install-1',
    });
    expect(t.placement.resolveOwnedLocalForUser(t.viewerUserId).id).toBe(
      owned.id,
    );
  });

  it('enforces agent/workspace host equality for membership', () => {
    const t = makeResolver();
    const hostA = t.hosts.create('owned-a', 'local', {
      userId: t.viewerUserId,
      installationId: 'install-a',
    });
    const hostB = t.hosts.create('owned-b', 'local', {
      userId: t.viewerUserId,
      installationId: 'install-b',
    });
    const agent = t.agents.create(
      { name: 'alice', runtime: 'claude' },
      hostA.id,
      t.viewerUserId,
    );
    const workspace = t.workspaces.insert({
      name: 'engineering',
      description: null,
      workspacePath: '/tmp/silverhand-engineering',
      workspaceHostId: hostB.id,
    });

    expect(() =>
      t.workspaces.addMember(workspace.id, agent.id),
    ).toThrowError(expect.objectContaining({ code: 'host_mismatch' }));
    expect(() =>
      t.placement.assertHostEqualityForMembership(agent.id, workspace.id),
    ).toThrowError(expect.objectContaining({ code: 'host_mismatch' }));
  });

  it('does not introduce daemon outbound transport into the placement guard', () => {
    const source = readFileSync(
      new URL('../../src/runtime/host-placement.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/fetch\(|WebSocket|https?:|HostClient/);
  });
});
