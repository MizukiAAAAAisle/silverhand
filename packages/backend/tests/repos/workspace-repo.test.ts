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
  return { workspace, a, b, workspaces };
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
});

