import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMaterializationStatus } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../../src/auth/principal.js';
import type { BackendContext } from '../../src/context.js';
import { canViewAgent } from '../../src/permissions.js';
import { makeTestContext } from '../utils/test-context.js';

/**
 * TS-first half of the cross-language `GET /api/agents` list set-signer
 * (#task:2195, batch 5).
 *
 * The SAME checked-in fixture the Rust parity test replays
 * (backend-sqlite/tests/agent_list_visibility_parity.rs) is replayed here — but as
 * a STRUCTURED DOMAIN seed, not an executable SQL script. The fixture names domain
 * entities (humans, agents with a creator/created_at/stage, direct pairs, shared
 * workspaces) with symbolic refs; this half resolves those refs to real seeded
 * users and repository-minted agent ids and BUILDS the world through the
 * `test-context` builders, so the business test carries ZERO native SQL. The Rust
 * half builds its own current-schema fixture from the same structured facts. Both
 * sides share ONE set of product facts + expected ordered ref sets, not a dialect.
 *
 * The expectation is ratified by the REAL production read authority the list route
 * composes (agents.ts): the actual `AgentRepo.list()` (whose `ORDER BY created_at
 * ASC` the Rust port carries verbatim) filtered by the actual `canViewAgent` ACL
 * (creator ∪ human direct-pair endpoints ∪ shared-workspace members, ACL-first then
 * the stage widener) and the route's `?scope=owned` narrowing by ACTUAL creator. A
 * wrong hand-authored ref set goes red against reality BEFORE the Rust side is asked
 * to match it. This is a SET signer — the ordered visible-id set is the load-bearing
 * signal of the cold-read + `visible_agents` projector; the per-agent DTO projection
 * is signed by the `GET /api/agents/:id` gate, not re-checked here.
 *
 * Only the query-string→intent mapping is out of scope (it is route perimeter, and
 * the Rust cold-read consumes the parsed intent directly): the `includeStatuses`
 * assembly below mirrors agents.ts verbatim so no authority is re-implemented.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  here,
  '..',
  '..',
  '..',
  'shared',
  'tests',
  'fixtures',
  'agent-list-visibility.json',
);

type SeedStatus = 'active' | 'failed' | 'pending';

interface AgentSeed {
  ref: string;
  creator: string;
  created_at: number;
  status: SeedStatus;
}

interface DirectPairSeed {
  agent: string;
  human: string;
}

interface WorkspaceSeed {
  ref: string;
  agent_members: string[];
  human_users: string[];
}

interface VisibilityCase {
  name: string;
  viewer: string;
  scope: 'all' | 'owned';
  include_failed: boolean;
  include_pending: boolean;
  expected_agent_ids: string[];
}

interface VisibilityFixture {
  humans: string[];
  agents: AgentSeed[];
  direct_pairs: DirectPairSeed[];
  workspaces: WorkspaceSeed[];
  cases: VisibilityCase[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as VisibilityFixture;

/** The route's stage-flag → status-set assembly, mirrored verbatim (agents.ts). */
function includeStatusesFor(testCase: VisibilityCase): AgentMaterializationStatus[] {
  const includeStatuses: AgentMaterializationStatus[] = ['active'];
  if (testCase.include_failed) includeStatuses.push('failed');
  if (testCase.include_pending) includeStatuses.push('pending_materialization');
  return includeStatuses;
}

/**
 * Build the whole structured world through the repository/test-context builders and
 * return the two lookups the assertion needs: each human ref's resolved user id, and
 * each agent's real id keyed by ref (so `AgentRepo.list()` rows map back to refs).
 */
function seedWorld(ctx: ReturnType<typeof makeTestContext>): {
  userIdByHuman: Map<string, string>;
  refByAgentId: Map<string, string>;
} {
  // The pre-seeded fixture users this DB already holds; the viewer is the canonical
  // one. Each declared human ref takes a distinct id by position — the ref strings
  // are the shared symbolic language, the ids are this side's concretes.
  const seededUserPool = [ctx.viewerUserId, 'alice', 'bob', 'carol', 'teammate'];
  const userIdByHuman = new Map<string, string>();
  fixture.humans.forEach((human, index) => {
    const userId = seededUserPool[index];
    if (!userId) throw new Error(`no seeded user for human ref ${human}`);
    userIdByHuman.set(human, userId);
  });
  const resolveHuman = (human: string): string => {
    const userId = userIdByHuman.get(human);
    if (!userId) throw new Error(`unknown human ref ${human}`);
    return userId;
  };

  const agentIdByRef = new Map<string, string>();
  const refByAgentId = new Map<string, string>();
  for (const agent of fixture.agents) {
    const id = ctx.createAgentAs(`agent-${agent.ref}`, {
      createdBy: resolveHuman(agent.creator),
      createdAt: agent.created_at,
      status: agent.status,
    });
    agentIdByRef.set(agent.ref, id);
    refByAgentId.set(id, agent.ref);
  }
  const resolveAgent = (ref: string): string => {
    const id = agentIdByRef.get(ref);
    if (!id) throw new Error(`unknown agent ref ${ref}`);
    return id;
  };

  const now = 1;
  for (const pair of fixture.direct_pairs) {
    ctx.repos.conversations.getOrCreateDirectPair(
      { kind: 'agent', id: resolveAgent(pair.agent) },
      { kind: 'human', id: resolveHuman(pair.human) },
      now,
    );
  }

  for (const workspace of fixture.workspaces) {
    const ws = ctx.createWorkspace(workspace.ref);
    for (const agentRef of workspace.agent_members) {
      ctx.repos.workspaces.insertMembership(ws.id, resolveAgent(agentRef));
    }
    for (const humanRef of workspace.human_users) {
      ctx.repos.workspaces.addUserMember(ws.id, resolveHuman(humanRef));
    }
  }

  return { userIdByHuman, refByAgentId };
}

describe('GET /api/agents list set parity (#task:2195)', () => {
  for (const testCase of fixture.cases) {
    it(`the real TS list authority produces the shared "${testCase.name}" id set`, () => {
      // seedAllFixtureMemberships:false so only the fixture's explicit memberships
      // exist — otherwise the compatibility trigger would snapshot every fixture
      // user into the shared workspace and break viewer-relativity.
      const ctx = makeTestContext({ seedAllFixtureMemberships: false });
      try {
        const { userIdByHuman, refByAgentId } = seedWorld(ctx);

        const backendCtx = {
          authorizationReads: ctx.authorizationReads,
        } as unknown as BackendContext;
        const viewerUserId = userIdByHuman.get(testCase.viewer);
        if (!viewerUserId) throw new Error(`unknown case viewer ${testCase.viewer}`);
        const principal: Principal = { kind: 'user', userId: viewerUserId };
        const includeStatuses = includeStatusesFor(testCase);
        const ownedOnly = testCase.scope === 'owned';

        const visibleRefs = ctx.repos.agents
          .list()
          .filter(
            agent =>
              canViewAgent(backendCtx, principal, agent.id, { includeStatuses })
              && (!ownedOnly || agent.created_by_user_id === principal.userId),
          )
          .map(agent => {
            const ref = refByAgentId.get(agent.id);
            if (!ref) throw new Error(`unmapped agent id ${agent.id}`);
            return ref;
          });

        expect(visibleRefs).toEqual(testCase.expected_agent_ids);
      } finally {
        ctx.cleanup();
      }
    });
  }
});
