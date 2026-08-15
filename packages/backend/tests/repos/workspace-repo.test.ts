import { fixedWorkspaceName } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrapWorkspaceAndAgents() {
  const { db, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db);
  const agents = new AgentRepo(db);

  const workspace = workspaces.insert({
    name: fixedWorkspaceName('ops'),
    description: null,
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
      name: fixedWorkspaceName(a.name),
      description: null,
    });
    expect(sameNameRegular.workspace_kind).toBe('regular');
    expect(workspaces.getByName(a.name)?.id).toBe(sameNameRegular.id);
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

  // #task:2027 — one canonical parser produces the terminal display/key pair.
  // A row written in a decomposed spelling would render one value while its
  // semantic address canonicalizes another. Fixtures are explicit escapes:
  // `caf\u00E9` (precomposed) vs
  // `cafe\u0301` (e + COMBINING ACUTE ACCENT) render identically.
  it('stores an NFD name in NFC so either spelling selects the row', () => {
    const { db } = openTestDb();
    const workspaces = new WorkspaceRepo(db);

    const created = workspaces.insert({
      name: fixedWorkspaceName('cafe\u0301-team'),
      description: null,
    });
    expect(created.name).toBe('caf\u00E9-team');
    expect(workspaces.getByName('cafe\u0301-team')?.id).toBe(created.id);
    expect(workspaces.getByName('caf\u00E9-team')?.id).toBe(created.id);

    const renamed = workspaces.updateMutableMetadata(created.id, {
      name: fixedWorkspaceName('de\u0301sign'),
    });
    expect(renamed?.name).toBe('d\u00E9sign');
    expect(workspaces.getByName('de\u0301sign')?.id).toBe(created.id);
    expect(workspaces.getByName('d\u00E9sign')?.id).toBe(created.id);
  });

  it('uses one folded regular namespace and releases a key on rename', () => {
    const { db } = openTestDb();
    const workspaces = new WorkspaceRepo(db);
    const first = workspaces.insert({
      name: fixedWorkspaceName('General'),
      description: null,
    });
    expect(workspaces.getByName('general')?.id).toBe(first.id);
    expect(() => workspaces.insert({
      name: fixedWorkspaceName('GENERAL'),
      description: null,
    })).toThrow(/UNIQUE/);

    workspaces.updateMutableMetadata(first.id, {
      name: fixedWorkspaceName('Renamed'),
    });
    const second = workspaces.insert({
      name: fixedWorkspaceName('general'),
      description: null,
    });
    expect(workspaces.getByName('General')?.id).toBe(second.id);
    expect(workspaces.getByName('renamed')?.id).toBe(first.id);
  });

});
