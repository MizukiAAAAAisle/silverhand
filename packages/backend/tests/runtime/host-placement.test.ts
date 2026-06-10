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

  // D4.c C1 — 0/1/N branch pin for the default-placement helper.
  // The N case is the new behavior shift: pre-D4.c
  // `resolveOwnedLocalForUser` silently returned the "best"
  // (most-recently-seen) row when the user had multiple active
  // local hosts. M1 makes that explicit: the caller must pick.
  it('rejects with local_host_ambiguous when user has multiple active local hosts (D4.c C1)', () => {
    const t = makeResolver();

    // 0 hosts — covered above, repeated here for visual clarity
    // of the 0/1/N enumeration this test pins.
    expect(() =>
      t.placement.resolveOwnedLocalForUser(t.viewerUserId),
    ).toThrowError(expect.objectContaining({ code: 'local_host_unbound' }));

    // 1 host — single resolution still works.
    const first = t.hosts.create('owned-local-1', 'local', {
      userId: t.viewerUserId,
      installationId: 'install-1',
    });
    expect(t.placement.resolveOwnedLocalForUser(t.viewerUserId).id).toBe(
      first.id,
    );

    // ≥2 hosts — ambiguous, must throw the typed code so the
    // caller can prompt the user to pick. Add a second active
    // local host with a *different* installation id (the active
    // unique index is `(user_id, installation_id)`).
    t.hosts.create('owned-local-2', 'local', {
      userId: t.viewerUserId,
      installationId: 'install-2',
    });
    expect(() =>
      t.placement.resolveOwnedLocalForUser(t.viewerUserId),
    ).toThrowError(
      expect.objectContaining({ code: 'local_host_ambiguous' }),
    );

    // Revoked rows do not count toward ambiguity: revoke the
    // second one and the resolver is once again unambiguous.
    const all = t.hosts.listForUser(t.viewerUserId);
    const second = all.find(h => h.id !== first.id)!;
    t.hosts.revoke(second.id, Date.now());
    expect(t.placement.resolveOwnedLocalForUser(t.viewerUserId).id).toBe(
      first.id,
    );

    // D4.c C1 Cindy round-1 P1: another user's local host must not
    // affect this user's resolve decision. Insert one for `alice`
    // and prove the viewer still resolves to `first` (not ambiguous,
    // not pointing at alice).
    t.hosts.create('alice-local', 'local', {
      userId: 'alice',
      installationId: 'install-alice-resolve',
    });
    expect(t.placement.resolveOwnedLocalForUser(t.viewerUserId).id).toBe(
      first.id,
    );
    // And alice resolves to her own single host, not to the viewer's.
    expect(t.placement.resolveOwnedLocalForUser('alice').id).not.toBe(
      first.id,
    );
  });

  it('exposes listOwnedActiveLocalForUser with 0 / 1 / N visibility (D4.c C1)', () => {
    const t = makeResolver();

    // 0
    expect(t.placement.listOwnedActiveLocalForUser(t.viewerUserId)).toEqual([]);

    // 1
    const a = t.hosts.create('owned-local-a', 'local', {
      userId: t.viewerUserId,
      installationId: 'install-a',
    });
    expect(
      t.placement
        .listOwnedActiveLocalForUser(t.viewerUserId)
        .map(h => h.id),
    ).toEqual([a.id]);

    // N — visibility matches `getOwnedLocalForUser`'s active-only +
    // recency-sorted invariant, but as an array instead of a single
    // pick. Revoked rows are excluded.
    const b = t.hosts.create('owned-local-b', 'local', {
      userId: t.viewerUserId,
      installationId: 'install-b',
    });
    const ids = t.placement
      .listOwnedActiveLocalForUser(t.viewerUserId)
      .map(h => h.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set([a.id, b.id]));

    // D4.c C1 Cindy round-1 P1: cross-user negative pin must be a
    // first-class assertion on the resolver — this helper is the
    // basis of G3 cross-tenant placement, and a future regression
    // (e.g. SQL dropping `user_id = ?`) would otherwise pass every
    // same-user 0 / 1 / N case. Insert another fixture user's local
    // host and prove the viewer's list does not surface it.
    t.hosts.create('alice-local', 'local', {
      userId: 'alice',
      installationId: 'install-alice',
    });
    const stillViewerOnly = t.placement
      .listOwnedActiveLocalForUser(t.viewerUserId)
      .map(h => h.id);
    expect(stillViewerOnly).toHaveLength(2);
    expect(new Set(stillViewerOnly)).toEqual(new Set([a.id, b.id]));
    // And from the alice side, only alice's host shows up.
    const aliceOnly = t.placement
      .listOwnedActiveLocalForUser('alice')
      .map(h => h.id);
    expect(aliceOnly).toHaveLength(1);

    // Revoke one and the list shrinks accordingly (no resurrection
    // of the silent-pick behavior).
    t.hosts.revoke(b.id, Date.now());
    expect(
      t.placement
        .listOwnedActiveLocalForUser(t.viewerUserId)
        .map(h => h.id),
    ).toEqual([a.id]);
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

    // Host equality is a placement-control / use-case precondition, NOT a
    // repo concern (use-case-layer spec §4, Cindy constraint ②): the repo's
    // insertMembership is pure persistence and no longer host-checks, while
    // the placement guard is what rejects a cross-host membership.
    expect(() =>
      t.workspaces.insertMembership(workspace.id, agent.id),
    ).not.toThrow();
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
