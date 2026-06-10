import { afterEach, describe, expect, it } from 'vitest';
import { internalPaths } from '@silverhand/shared';
import { createApiRouter } from '../src/routes.js';
import {
  AGENT_ROUTE_CAPABILITIES,
  EXPECTED_PENDING_AGENT_ROUTES,
  GOVERNANCE_PATH_PREFIXES,
  HUMAN_GOVERNANCE_ROUTES,
  NON_GOVERNANCE_MUTATING_ROUTES,
} from '../src/permissions-registry.js';
import { buildTestApp, type TestApp } from './utils/app.js';

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
