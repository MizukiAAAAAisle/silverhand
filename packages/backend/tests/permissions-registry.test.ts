import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeUserPrincipalHeader,
  internalPaths,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { createApiRouter } from '../src/routes.js';
import {
  AGENT_ROUTE_CAPABILITIES,
  EXPECTED_PENDING_AGENT_ROUTES,
  GOVERNANCE_PATH_PREFIXES,
  HUMAN_GOVERNANCE_ROUTES,
  NON_GOVERNANCE_MUTATING_ROUTES,
} from '../src/permissions-registry.js';
import { buildTestApp, http, type TestApp } from './utils/app.js';

const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function liveMutatingGovernanceRoutes(t: TestApp): Set<string> {
  // Enumerate the live public route table and keep mutating routes that
  // live under a governance path prefix. Dedupe (Hono lists middleware +
  // handler separately) by `METHOD path`.
  const router = createApiRouter(t.ctx);
  const found = new Set<string>();
  for (const route of router.routes) {
    const method = route.method.toUpperCase();
    if (!MUTATION_METHODS.has(method)) continue;
    if (!GOVERNANCE_PATH_PREFIXES.some(p => route.path.startsWith(p))) continue;
    found.add(`${method} ${route.path}`);
  }
  return found;
}

describe('permissions registry — drift protection (v40 Layer A)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  describe('human governance registry', () => {
    it('declares only routes that exist in the live route table', () => {
      t = buildTestApp();
      const live = liveMutatingGovernanceRoutes(t);
      const missing = HUMAN_GOVERNANCE_ROUTES.filter(
        d => !live.has(`${d.method} ${d.path}`),
      ).map(d => `${d.method} ${d.path}`);
      expect(missing, 'governance registry entries not mounted as live routes').toEqual([]);
    });

    it('covers every mutating route under the governance prefixes (no silent god-gate)', () => {
      t = buildTestApp();
      const live = liveMutatingGovernanceRoutes(t);
      const declared = new Set<string>([
        ...HUMAN_GOVERNANCE_ROUTES.map(d => `${d.method} ${d.path}`),
        ...NON_GOVERNANCE_MUTATING_ROUTES.map(d => `${d.method} ${d.path}`),
      ]);
      // A new mutating workspace/channel route must be declared in EITHER
      // the governance registry (role-gated) OR the non-governance
      // allowlist (different gate, with a reason). Anything else is an
      // undeclared route that could quietly inherit a wrong gate.
      const undeclared = [...live].filter(r => !declared.has(r)).sort();
      expect(undeclared, 'mutating governance-prefix routes missing a registry/allowlist entry').toEqual([]);
    });

    it('keeps the non-governance allowlist tight (every entry is a real live route)', () => {
      t = buildTestApp();
      const live = liveMutatingGovernanceRoutes(t);
      const stale = NON_GOVERNANCE_MUTATING_ROUTES.filter(
        d => !live.has(`${d.method} ${d.path}`),
      ).map(d => `${d.method} ${d.path}`);
      expect(stale, 'allowlist entries not present in the live route table').toEqual([]);
      for (const d of NON_GOVERNANCE_MUTATING_ROUTES) {
        expect(d.reason.length, `${d.method} ${d.path} needs a non-empty reason`).toBeGreaterThan(0);
      }
    });

    /**
     * `minRole` is a FLOOR, and until #task:1683 nothing checked that the
     * declared floor was the LIVE floor: the coverage tests above only assert a
     * route is *listed*. Three composite routes had drifted to a member floor
     * while still declaring `admin`, i.e. the registry that calls itself the
     * authority SSOT was asserting the opposite of the gate. These probes bind
     * the declaration to behaviour in both directions:
     *
     *   - every `member`-floor declaration must be exercised here (the set
     *     comparison fails if one is added without a probe), and
     *   - each probe drives the REAL route twice: at the floor with the target
     *     class the floor admits (must not be 403) and from below the floor
     *     (must be 403). Re-tightening a gate to `admin` without updating the
     *     declaration now reddens this file.
     *
     * What the floor admits is only ever the *floor-legal* target — the
     * per-target escalations (a human, or someone else's agent) are pinned in
     * `tests/routes/agent-self-service-membership.test.ts`.
     */
    const MEMBER_FLOOR_PROBES = [
      'POST /api/workspaces/:id/members',
      'DELETE /api/workspaces/:id/members/:agentId',
      'POST /api/conversations/:id/members',
      'DELETE /api/conversations/:id/members/agents/:agentId',
    ];

    it('probes every route declared with a member floor (no unprobed floor claim)', () => {
      const declared = HUMAN_GOVERNANCE_ROUTES.filter(d => d.minRole === 'member')
        .map(d => `${d.method} ${d.path}`)
        .sort();
      expect(declared, 'member-floor declarations must all be probed below').toEqual(
        [...MEMBER_FLOOR_PROBES].sort(),
      );
      // A floor that grades further inside MUST say so, or the declaration reads
      // as "a plain member may do all of this".
      for (const d of HUMAN_GOVERNANCE_ROUTES.filter(x => x.minRole === 'member')) {
        expect(d.note ?? '', `${d.method} ${d.path} needs its escalation spelled out`).toMatch(
          /ESCALATES|FLOOR/,
        );
      }
    });

    it('proves the member floor is live: a plain member places and retracts their OWN agent', async () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const owner = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate') };
      const stranger = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('other') };

      const ws = ((await (
        await http(t).post('/api/workspaces', { name: 'floor', member_agent_ids: [] }, { headers: owner })
      ).json()) as any).workspace.id as string;
      expect(
        (await http(t).post(`/api/workspaces/${ws}/members`, { kind: 'human', user_id: 'local' }, { headers: owner }))
          .status,
      ).toBe(201);
      const channelId = ((await (
        await http(t).post(
          `/api/workspaces/${ws}/channels`,
          { title: 'floor-room', member_agent_ids: [], member_user_ids: ['local'] },
          { headers: owner },
        )
      ).json()) as any).channel.id as string;
      const mine = ((await (
        await http(t).post('/api/agents', { name: 'floor-probe-agent', runtime: 'claude' })
      ).json()) as any).agent.id as string;

      // Default identity below is `local`: a plain workspace `member` and a
      // member of `channelId`. Each route is driven at the floor, then from
      // below it (a workspace non-member) — the floor must actually refuse.
      const wsMemberAdd = await http(t).post(`/api/workspaces/${ws}/members`, { agent_id: mine });
      expect(wsMemberAdd.status).toBe(201);
      expect(
        (await http(t).post(`/api/workspaces/${ws}/members`, { agent_id: mine }, { headers: stranger }))
          .status,
      ).toBe(403);

      const channelAdd = await http(t).post(`/api/conversations/${channelId}/members`, {
        kind: 'agent',
        agent_id: mine,
      });
      expect(channelAdd.status).toBe(200);
      expect(
        (await http(t).post(
          `/api/conversations/${channelId}/members`,
          { kind: 'agent', agent_id: mine },
          { headers: stranger },
        )).status,
      ).toBe(403);

      expect(
        (await http(t).del(`/api/conversations/${channelId}/members/agents/${mine}`, {
          headers: stranger,
        })).status,
      ).toBe(403);
      expect((await http(t).del(`/api/conversations/${channelId}/members/agents/${mine}`)).status).toBe(200);

      expect(
        (await http(t).del(`/api/workspaces/${ws}/members/${mine}`, { headers: stranger })).status,
      ).toBe(403);
      expect((await http(t).del(`/api/workspaces/${ws}/members/${mine}`)).status).toBe(204);
    });
  });

  describe('agent capability registry', () => {
    it('declares exactly the internalPaths route set (new route forces a decision)', () => {
      const declared = Object.keys(AGENT_ROUTE_CAPABILITIES).sort();
      const live = Object.keys(internalPaths).sort();
      expect(declared).toEqual(live);
    });

    it('pins the cut-1 pending ledger exactly (cut 2 may only shrink it)', () => {
      const actualPending = Object.entries(AGENT_ROUTE_CAPABILITIES)
        .filter(([, decl]) => decl.status === 'pending')
        .map(([key]) => key)
        .sort();
      const expected = [...EXPECTED_PENDING_AGENT_ROUTES].sort();
      expect(actualPending).toEqual(expected);
    });

    it('requires a reason on every none-justified declaration', () => {
      for (const [key, decl] of Object.entries(AGENT_ROUTE_CAPABILITIES)) {
        if (decl.status === 'none-justified') {
          expect(decl.reason.length, `${key} none-justified needs a reason`).toBeGreaterThan(0);
        } else {
          expect(decl.scope.length, `${key} pending needs a scope`).toBeGreaterThan(0);
        }
      }
    });
  });
});
