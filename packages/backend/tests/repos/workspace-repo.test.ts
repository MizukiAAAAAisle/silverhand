import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrapWorkspaceAndAgents() {
  const { db, localHostId } = openTestDb();
  const workspacesRoot = join(tmpdir(), 'silverhand-workspace-test');
  const workspaces = new WorkspaceRepo(db, { workspacesRoot });
  const agents = new AgentRepo(db);

  const workspace = workspaces.insert({
    name: 'ops',
    description: null,
    workspacePath: workspaces.workspacePathFor('ops'),
    workspaceHostId: localHostId,
  });
  const a = agents.create({ name: 'a', runtime: 'claude' }, localHostId);
  const b = agents.create({ name: 'b', runtime: 'claude' }, localHostId);
  return { db, localHostId, workspace, a, b, workspaces };
}

describe('WorkspaceRepo', () => {
  it('addMember is idempotent and isMember reflects state', () => {
    const { workspace, a, workspaces } = bootstrapWorkspaceAndAgents();
    expect(workspaces.isMember(workspace.id, a.id)).toBe(false);

    workspaces.addMember(workspace.id, a.id);
    expect(workspaces.isMember(workspace.id, a.id)).toBe(true);

    workspaces.addMember(workspace.id, a.id);
    expect(workspaces.listMembers(workspace.id)).toHaveLength(1);
  });

  it('listMembers returns agents in joined_at order', () => {
    const { workspace, a, b, workspaces } = bootstrapWorkspaceAndAgents();
    workspaces.addMember(workspace.id, b.id);
    const now = Date.now();
    while (Date.now() === now) { /* spin */ }
    workspaces.addMember(workspace.id, a.id);

    const list = workspaces.listMembers(workspace.id);
    expect(list.map(x => x.id)).toEqual([b.id, a.id]);
  });

  it('removeMember deletes only the targeted membership', () => {
    const { workspace, a, b, workspaces } = bootstrapWorkspaceAndAgents();
    workspaces.addMember(workspace.id, a.id);
    workspaces.addMember(workspace.id, b.id);

    workspaces.removeMember(workspace.id, a.id);
    expect(workspaces.isMember(workspace.id, a.id)).toBe(false);
    expect(workspaces.isMember(workspace.id, b.id)).toBe(true);
  });

  it('models agent_home ownership separately from regular workspace membership', () => {
    const { db, localHostId, workspace, a, workspaces } =
      bootstrapWorkspaceAndAgents();
    workspaces.addMember(workspace.id, a.id);
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
    expect(() => workspaces.addMember(home.id, a.id)).toThrow(
      /regular workspaces only/,
    );

    const sameNameRegular = workspaces.insert({
      name: a.name,
      description: null,
      workspacePath: workspaces.workspacePathFor(a.name),
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
});
