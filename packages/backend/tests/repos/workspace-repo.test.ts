import { describe, expect, it, vi } from 'vitest';
import { testWorkspacePath } from '../utils/db.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrapWorkspaceAndAgents() {
  const { db, localHostId } = openTestDb();
  const workspacesRoot = join(tmpdir(), 'silverhand-workspace-test');
  const workspaces = new WorkspaceRepo(db);
  const agents = new AgentRepo(db);

  const workspace = workspaces.insert({
    name: 'ops',
    description: null,
    workspacePath: testWorkspacePath('ops'),
    workspaceHostId: localHostId,
  });
  const a = agents.create({ name: 'a', runtime: 'claude' }, localHostId, 'local');
  const b = agents.create({ name: 'b', runtime: 'claude' }, localHostId, 'local');
  return { db, localHostId, workspace, a, b, workspaces };
}

describe('WorkspaceRepo', () => {
  it('insertMembership is idempotent and isMember reflects state', () => {
    const { workspace, a, workspaces } = bootstrapWorkspaceAndAgents();
    expect(workspaces.isMember(workspace.id, a.id)).toBe(false);

    workspaces.insertMembership(workspace.id, a.id);
    expect(workspaces.isMember(workspace.id, a.id)).toBe(true);

    workspaces.insertMembership(workspace.id, a.id);
    expect(workspaces.listMembers(workspace.id)).toHaveLength(1);
  });

  it('listMembers returns agents in joined_at order', () => {
    const { workspace, a, b, workspaces } = bootstrapWorkspaceAndAgents();
    workspaces.insertMembership(workspace.id, b.id);
    const now = Date.now();
    while (Date.now() === now) { /* spin */ }
    workspaces.insertMembership(workspace.id, a.id);

    const list = workspaces.listMembers(workspace.id);
    expect(list.map(x => x.id)).toEqual([b.id, a.id]);
  });

  it('removeMember deletes only the targeted membership', () => {
    const { workspace, a, b, workspaces } = bootstrapWorkspaceAndAgents();
    workspaces.insertMembership(workspace.id, a.id);
    workspaces.insertMembership(workspace.id, b.id);

    workspaces.removeMember(workspace.id, a.id);
    expect(workspaces.isMember(workspace.id, a.id)).toBe(false);
    expect(workspaces.isMember(workspace.id, b.id)).toBe(true);
  });

  it('models agent_home ownership separately from regular workspace membership', () => {
    const { db, localHostId, workspace, a, workspaces } =
      bootstrapWorkspaceAndAgents();
    workspaces.insertMembership(workspace.id, a.id);
    const home = workspaces.insertAgentHome({
      agent: a,
      workspacePath: join(tmpdir(), 'agents', a.id),
    });

    expect(home).toMatchObject({
      name: a.name,
      workspace_kind: 'agent_home',
      owner_agent_id: a.id,
    });
    expect(workspaces.listForAgent(a.id).map(w => w.id)).toEqual([
      workspace.id,
      home.id,
    ]);
    expect(() => workspaces.insertMembership(home.id, a.id)).toThrow(
      /regular workspaces only/,
    );

    const sameNameRegular = workspaces.insert({
      name: a.name,
      description: null,
      workspacePath: testWorkspacePath(a.name),
      workspaceHostId: localHostId,
    });
    expect(sameNameRegular.workspace_kind).toBe('regular');
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS c
             FROM workspaces
            WHERE name = ?`,
        )
        .get(a.name),
    ).toEqual({ c: 2 });
  });

  it('listRegularForHost returns only regular workspaces bound to that host', () => {
    // #task:1529 — the migration audit's candidate query is the only full-host
    // enumeration of what must be provisioned, so it must strictly exclude
    // other hosts and non-regular kinds (agent_home). A leak either way
    // corrupts the audit's counts.
    const { db, localHostId, workspace, a, workspaces } =
      bootstrapWorkspaceAndAgents();

    // agent_home on the SAME host — excluded (wrong kind).
    workspaces.insertAgentHome({
      agent: a,
      workspacePath: join(tmpdir(), 'agents', a.id),
    });

    // A regular workspace on a DIFFERENT host — excluded (wrong host).
    const otherHost = new HostRepo(db).create('other', 'remote');
    const otherWs = workspaces.insert({
      name: 'other-ops',
      description: null,
      workspacePath: testWorkspacePath('other-ops'),
      workspaceHostId: otherHost.id,
    });

    const candidates = workspaces.listRegularForHost(localHostId);
    expect(candidates.map(c => c.id)).toEqual([workspace.id]);
    expect(candidates[0]).toMatchObject({
      workspace_path: workspace.workspace_path,
    });
    expect(workspaces.listRegularForHost(otherHost.id).map(c => c.id)).toEqual([
      otherWs.id,
    ]);
  });
});
