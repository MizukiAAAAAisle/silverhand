import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_CAPABILITIES,
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { canAgentUseCapability, canEditAgentCapabilities } from '../../src/permissions.js';
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
      new WorkspaceRepo(t.ctx.db).insertMembership(ws, alice);
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
      const home = new WorkspaceRepo(t.ctx.db).getAgentHomeByOwner(alice);
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
      const aliceHome = new WorkspaceRepo(t.ctx.db).getAgentHomeByOwner(alice);
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
      // No phantom cap set is written for the non-member pair.
      expect(new AgentCapabilityRepo(t.ctx.db).list(ws, bob)).toEqual([]);
    });
  });

  /**
   * Admin-or-creator gate matrix (#task:1777, approved #1775 option A). The PUT
   * authorizes `admin(ws) ∨ (member(ws) ∧ canEnrollAgent(agent))`. Each cell
   * isolates one arm; the agent-self cell is a predicate assertion because the
   * PUT route only ever carries a user principal (agents reach caps via the
   * internal axis, never this human-axis route).
   */
  describe('PUT capabilities — admin-or-creator gate (#task:1777)', () => {
    const OWNER = 'teammate';
    const CREATOR = 'other';
    const UNRELATED = 'someone';
    const ADMIN = 'carol';
    const asOwner = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(OWNER) };
    const asCreator = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(CREATOR) };
    const asUnrelated = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(UNRELATED) };
    const asAdmin = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(ADMIN) };

    /**
     * OWNER owns `ws`; CREATOR and UNRELATED are invited plain `member`s; ADMIN is
     * an invited member promoted to the exact `admin` role (distinct from OWNER,
     * whose `owner` role outranks admin) so the admin arm of the escalation is
     * isolated by a real `admin`, not an owner. CREATOR creates `mine` and enrolls
     * it through the production route, so `mine.created_by_user_id === CREATOR` and
     * `mine` is a real member. No fixture memberships (permission-boundary test):
     * every row is production.
     */
    async function scenario(t: TestApp): Promise<{ ws: string; mine: string }> {
      const ws = ((await (
        await http(t).post('/api/workspaces', { name: 'gate', member_agent_ids: [] }, { headers: asOwner })
      ).json()) as any).workspace.id as string;
      for (const user of [CREATOR, UNRELATED, ADMIN]) {
        expect(
          (await http(t).post(`/api/workspaces/${ws}/members`, { kind: 'human', user_id: user }, { headers: asOwner }))
            .status,
        ).toBe(201);
      }
      // Promote ADMIN to the exact `admin` governance role (setUserRole is the
      // authoritative writer; it refuses `owner`, so this is a true admin, not the
      // owner). This isolates the escalation's admin arm from the owner path.
      const promoted = new WorkspaceRepo(t.ctx.db).setUserRole(ws, ADMIN, 'admin');
      expect(promoted?.role).toBe('admin');
      const mine = ((await (
        await http(t).post('/api/agents', { name: 'gated-agent', runtime: 'claude' }, { headers: asCreator })
      ).json()) as any).agent.id as string;
      t.fake.starts = [];
      t.fake.delivered = [];
      expect(
        (await http(t).post(`/api/workspaces/${ws}/members`, { agent_id: mine }, { headers: asCreator })).status,
      ).toBe(201);
      return { ws, mine };
    }

    it('the workspace owner (outranks admin, non-creator) may edit — role governs the whole roster', async () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const { ws, mine } = await scenario(t);
      const res = await http(t).put(capsPath(ws, mine), { capabilities: ['read_messages'] }, { headers: asOwner });
      expect(res.status).toBe(200);
      expect(new AgentCapabilityRepo(t.ctx.db).list(ws, mine)).toEqual(['read_messages']);
    });

    it('a distinct admin-role member (non-creator) may edit — isolates the escalation admin arm', async () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const { ws, mine } = await scenario(t);
      // ADMIN holds the exact `admin` role and did not create `mine`, so a 200
      // here proves the inner escalation genuinely admits admin — the arm the
      // owner case (owner outranks admin) cannot isolate now that the registry
      // floor has dropped from admin to member.
      const res = await http(t).put(capsPath(ws, mine), { capabilities: ['read_tasks'] }, { headers: asAdmin });
      expect(res.status).toBe(200);
      expect(new AgentCapabilityRepo(t.ctx.db).list(ws, mine)).toEqual(['read_tasks']);
    });

    it('a plain member who CREATED the agent may edit it', async () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const { ws, mine } = await scenario(t);
      const res = await http(t).put(capsPath(ws, mine), { capabilities: ['read_tasks'] }, { headers: asCreator });
      expect(res.status).toBe(200);
      expect(new AgentCapabilityRepo(t.ctx.db).list(ws, mine)).toEqual(['read_tasks']);
    });

    it("refuses a plain member editing an agent they did NOT create", async () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const { ws, mine } = await scenario(t);
      const before = new AgentCapabilityRepo(t.ctx.db).list(ws, mine);
      const res = await http(t).put(capsPath(ws, mine), { capabilities: [] }, { headers: asUnrelated });
      expect(res.status).toBe(403);
      // Unauthorized attempt leaves the set intact.
      expect(new AgentCapabilityRepo(t.ctx.db).list(ws, mine)).toEqual(before);
    });

    it('refuses the creator once they are no longer a workspace member (member floor)', async () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const { ws, mine } = await scenario(t);
      // The agent outlives the creator's own membership; the creator arm still
      // requires a live workspace role, so a departed creator cannot reach in.
      // Auth runs before the pair 404, so a now-non-member gets 403, not a 404
      // that would disclose the pair.
      t.ctx.db
        .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
        .run(ws, CREATOR);
      const before = new AgentCapabilityRepo(t.ctx.db).list(ws, mine);
      const res = await http(t).put(capsPath(ws, mine), { capabilities: [] }, { headers: asCreator });
      expect(res.status).toBe(403);
      expect(new AgentCapabilityRepo(t.ctx.db).list(ws, mine)).toEqual(before);
    });

    it('never authorizes an agent principal against its own caps (no self-escalation)', async () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const { ws, mine } = await scenario(t);
      const selfPrincipal: AgentPrincipal = {
        kind: 'agent',
        conversationId: 'irrelevant',
        agentId: mine,
      };
      // canEnrollAgent — and therefore this composite — is false for every agent
      // principal, so an agent can never widen its own capability set.
      expect(canEditAgentCapabilities(t.ctx, selfPrincipal, ws, mine)).toBe(false);
    });
  });
});
