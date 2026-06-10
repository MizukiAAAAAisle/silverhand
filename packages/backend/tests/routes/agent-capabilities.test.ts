import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CAPABILITIES } from '@silverhand/shared';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { canAgentUseCapability } from '../../src/permissions.js';
import type { AgentPrincipal } from '../../src/auth/principal.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.agent.id;
}

async function createRegularWorkspace(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<string> {
  const created = (await (
    await http(t).post('/api/workspaces', { name, member_agent_ids: memberAgentIds })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.workspace.id;
}

function capsPath(workspaceId: string, agentId: string): string {
  return `/api/workspaces/${workspaceId}/agents/${agentId}/capabilities`;
}

function setRole(t: TestApp, workspaceId: string, role: string): void {
  t.ctx.db
    .prepare(`UPDATE workspace_users SET role = ? WHERE workspace_id = ? AND user_id = 'local'`)
    .run(role, workspaceId);
}

describe('agent capability storage (graded-permissions cut 2)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  describe('seed on member add', () => {
    it('seeds the full default capability set when an agent joins a workspace', async () => {
      t = buildTestApp();
      const alice = await makeAgent(t, 'alice');
      const ws = await createRegularWorkspace(t, 'team', [alice]);

      const caps = new AgentCapabilityRepo(t.ctx.db).list(ws, alice);
      expect([...caps].sort()).toEqual([...AGENT_CAPABILITIES].sort());
    });

    it('does not re-widen a narrowed set when an existing member is re-added', async () => {
      t = buildTestApp();
      const alice = await makeAgent(t, 'alice');
      const ws = await createRegularWorkspace(t, 'team', [alice]);
      const repo = new AgentCapabilityRepo(t.ctx.db);
      // Narrow to a single capability, then re-add the (already) member.
      repo.replaceSet(ws, alice, ['read_messages']);
      // insertMembership is idempotent (INSERT OR IGNORE) and is pure
      // persistence — it never seeds capabilities. Capability seeding is the
      // use case's `if (created)` decision, so re-adding an existing member
      // (created === false) leaves a narrowed set untouched.
      new WorkspaceRepo(t.ctx.db, { workspacesRoot: t.ctx.workspacesRoot }).insertMembership(ws, alice);
      expect(repo.list(ws, alice)).toEqual(['read_messages']);
    });
  });

  describe('canAgentUseCapability', () => {
    it('reads the per-(workspace, agent) set against the target scope', async () => {
      t = buildTestApp();
      const alice = await makeAgent(t, 'alice');
      const ws = await createRegularWorkspace(t, 'team', [alice]);
      const repo = new AgentCapabilityRepo(t.ctx.db);
      repo.replaceSet(ws, alice, ['read_messages', 'send_messages']);

      const principal: AgentPrincipal = {
        kind: 'agent',
        conversationId: 'irrelevant',
        agentId: alice,
      };
      expect(
        canAgentUseCapability(t.ctx, principal, 'send_messages', { workspaceId: ws }),
      ).toBe(true);
      expect(
        canAgentUseCapability(t.ctx, principal, 'write_tasks', { workspaceId: ws }),
      ).toBe(false);
    });

    it('passes system principals and fails user principals', async () => {
      t = buildTestApp();
      const alice = await makeAgent(t, 'alice');
      const ws = await createRegularWorkspace(t, 'team', [alice]);
      expect(
        canAgentUseCapability(t.ctx, { kind: 'system' }, 'write_tasks', { workspaceId: ws }),
      ).toBe(true);
      expect(
        canAgentUseCapability(
          t.ctx,
          { kind: 'user', userId: 'local' },
          'read_messages',
          { workspaceId: ws },
        ),
      ).toBe(false);
    });

    // agent_home exemption (Cindy `0VvD-47mLnkjgDvw`): VERY narrow — fires
    // only for the owning agent on its own agent_home (which has no
    // workspace_members row, so the seed never granted it caps).
    it('exempts an agent in its OWN agent_home even with no cap row', async () => {
      t = buildTestApp();
      const alice = await makeAgent(t, 'alice');
      const home = new WorkspaceRepo(t.ctx.db, {
        workspacesRoot: t.ctx.workspacesRoot,
      }).getAgentHomeByOwner(alice);
      expect(home).not.toBeNull();
      // No workspace_agent_capabilities row exists for the home; exemption
      // must carry full authority regardless of the requested bucket.
      expect(new AgentCapabilityRepo(t.ctx.db).list(home!.id, alice)).toEqual([]);
      const principal: AgentPrincipal = {
        kind: 'agent',
        conversationId: 'irrelevant',
        agentId: alice,
      };
      expect(
        canAgentUseCapability(t.ctx, principal, 'manage_schedules', { workspaceId: home!.id }),
      ).toBe(true);
      expect(
        canAgentUseCapability(t.ctx, principal, 'write_tasks', { workspaceId: home!.id }),
      ).toBe(true);
    });

    it('does NOT exempt another agent in someone else\'s agent_home', async () => {
      t = buildTestApp();
      const alice = await makeAgent(t, 'alice');
      const bob = await makeAgent(t, 'bob');
      const aliceHome = new WorkspaceRepo(t.ctx.db, {
        workspacesRoot: t.ctx.workspacesRoot,
      }).getAgentHomeByOwner(alice);
      const bobPrincipal: AgentPrincipal = {
        kind: 'agent',
        conversationId: 'irrelevant',
        agentId: bob,
      };
      expect(
        canAgentUseCapability(t.ctx, bobPrincipal, 'read_messages', {
          workspaceId: aliceHome!.id,
        }),
      ).toBe(false);
    });

    it('does NOT exempt a regular workspace member with no cap row', async () => {
      t = buildTestApp();
      const alice = await makeAgent(t, 'alice');
      const ws = await createRegularWorkspace(t, 'team', [alice]);
      // Strip the seeded caps to simulate an explicit empty set on a
      // regular workspace — no exemption applies, so every bucket denies.
      new AgentCapabilityRepo(t.ctx.db).replaceSet(ws, alice, []);
      const principal: AgentPrincipal = {
        kind: 'agent',
        conversationId: 'irrelevant',
        agentId: alice,
      };
      expect(
        canAgentUseCapability(t.ctx, principal, 'read_messages', { workspaceId: ws }),
      ).toBe(false);
    });
  });

  describe('GET capabilities', () => {
    it('returns the effective set for a member agent (any workspace viewer)', async () => {
      t = buildTestApp();
      const alice = await makeAgent(t, 'alice');
      const ws = await createRegularWorkspace(t, 'team', [alice]);

      const res = await http(t).get(capsPath(ws, alice));
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.workspace_id).toBe(ws);
      expect(body.agent_id).toBe(alice);
      expect([...body.capabilities].sort()).toEqual([...AGENT_CAPABILITIES].sort());
    });

    it('404s for an agent that is not a member of the workspace', async () => {
      t = buildTestApp();
      const alice = await makeAgent(t, 'alice');
      const bob = await makeAgent(t, 'bob');
      const ws = await createRegularWorkspace(t, 'team', [alice]);

      const res = await http(t).get(capsPath(ws, bob));
      expect(res.status).toBe(404);
    });
  });

  describe('PUT capabilities', () => {
    it('replaces the set (admin) and GET reflects it', async () => {
      t = buildTestApp();
      const alice = await makeAgent(t, 'alice');
      const ws = await createRegularWorkspace(t, 'team', [alice]);

      const res = await http(t).put(capsPath(ws, alice), {
        capabilities: ['read_messages', 'read_tasks'],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect([...body.capabilities].sort()).toEqual(['read_messages', 'read_tasks']);

      const after = (await (await http(t).get(capsPath(ws, alice))).json()) as any;
      expect([...after.capabilities].sort()).toEqual(['read_messages', 'read_tasks']);
    });

    it('403s when the editing human is below admin', async () => {
      t = buildTestApp();
      const alice = await makeAgent(t, 'alice');
      const ws = await createRegularWorkspace(t, 'team', [alice]);
      setRole(t, ws, 'member');

      const res = await http(t).put(capsPath(ws, alice), { capabilities: [] });
      expect(res.status).toBe(403);

      setRole(t, ws, 'admin');
      const ok = await http(t).put(capsPath(ws, alice), { capabilities: [] });
      expect(ok.status).toBe(200);
    });

    it('400s on an unknown capability bucket', async () => {
      t = buildTestApp();
      const alice = await makeAgent(t, 'alice');
      const ws = await createRegularWorkspace(t, 'team', [alice]);

      const res = await http(t).put(capsPath(ws, alice), {
        capabilities: ['read_messages', 'be_root'],
      });
      expect(res.status).toBe(400);
    });

    it('404s for a non-member agent before touching the cap set', async () => {
      t = buildTestApp();
      const alice = await makeAgent(t, 'alice');
      const bob = await makeAgent(t, 'bob');
      const ws = await createRegularWorkspace(t, 'team', [alice]);

      const res = await http(t).put(capsPath(ws, bob), { capabilities: [] });
      expect(res.status).toBe(404);
    });
  });
});
