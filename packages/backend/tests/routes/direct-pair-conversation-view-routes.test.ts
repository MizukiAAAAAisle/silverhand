/**
 * #task:2105 — workspace-less DirectPair contract coverage for the three
 * conversation-level collection routes that gate reads on
 * `canViewConversation`:
 *
 *   1. GET /api/conversations/:id/threads        (routes/conversations.ts:544)
 *   2. GET /api/channels/:id/attachments         (routes/attachments.ts:155)
 *   3. GET /api/channels/:id/attachments/senders (routes/attachments.ts:212)
 *
 * All three share ONE guard, in this fixed order:
 *   `getChannelLike(id)` missing → 404 `{ error: 'channel not found' }`
 *   `canViewConversation(...)` false → 403 `{ error: 'forbidden' }`
 * `getChannelLike` has no placement filter, so it returns a
 * `placement_kind='direct_pair'` (workspace-less, `workspace_id NULL`) row
 * exactly as it returns a channel — which means a DirectPair travels the SAME
 * route code and the SAME authority. Existing route tests only ever drive
 * channels and workspace-scoped `dm_channel`s (which still carry a
 * `workspace_id`); the workspace-less DirectPair arm of these three routes was
 * unpinned at the HTTP-contract level. This file closes that gap.
 *
 * CONTRACT NOTE (why 404 and 403 are NOT collapsed here). The task originally
 * asked to merge unknown/unauthorized into one shape. That is the rule for the
 * runtime DeliveryTarget/reach surface (`docs/agent-scoped-session-v1.md:478`),
 * not for these human viewer reads. The governing authority for viewer reads is
 * `docs/graded-permissions-v1.md:93`: a nonexistent id keeps the route-wide 404
 * convention, an existing-but-outsider gets a 403 that is uniform across the
 * conversation's kind/closed/private shape — so it exposes EXISTENCE (403 for
 * an existing id vs 404 for a missing one) but NOT the shape. These three
 * routes are conversation-level collections with no
 * sub-resource query position, so `docs/cli-system.md:559` (uniform code for a
 * sub-resource within an authorized conversation) does not apply. We therefore
 * assert the current, intentional 404-vs-403 split, and pin the denial bodies to
 * the channel branch verbatim — the falsifier being: if any route grew a
 * placement-specific branch that treated a DirectPair differently from a
 * channel, one of these status codes or bodies would diverge.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/** The three conversation-level collection routes under test. */
const ROUTES: ReadonlyArray<{ name: string; path: (id: string) => string }> = [
  {
    name: 'GET /api/conversations/:id/threads',
    path: id => `/api/conversations/${id}/threads`,
  },
  {
    name: 'GET /api/channels/:id/attachments',
    path: id => `/api/channels/${id}/attachments`,
  },
  {
    name: 'GET /api/channels/:id/attachments/senders',
    path: id => `/api/channels/${id}/attachments/senders`,
  },
];

interface Fixture {
  readonly t: TestApp;
  /** `agent` ↔ `human` DM whose human endpoint IS the fixture viewer. */
  readonly dpHumanId: string;
  /** `agent` ↔ `agent` DM the fixture viewer is no endpoint of. */
  readonly dpAgentsId: string;
}

/**
 * Memberships are NOT fixture-seeded (`seedAllFixtureMemberships: false`): the
 * whole point is that the row's endpoints — not an auto-snapshotted
 * `conversation_users` membership — decide access, so a seeding trigger would
 * answer the question before the ACL does.
 */
function setup(): Fixture {
  const t = buildTestApp({ seedAllFixtureMemberships: false });
  const agents = new AgentRepo(t.ctx.db);
  const conversations = new ConversationRepo(t.ctx.db);
  const hostId = new HostRepo(t.ctx.db).ensureLocal().id;
  const mk = (name: string): string =>
    agents.create({ name, runtime: 'claude' }, hostId, t.viewerUserId).id;
  const self = mk('dp-self');
  const peer = mk('dp-peer');

  // Build the DirectPairs through the production get-or-create constructor —
  // the DirectPair aggregate's ONLY constructor — so this test exercises the
  // real production shape (placement fields, canonical endpoint ordering,
  // title/visibility defaults, and any future schema change) rather than a
  // hand-rolled DDL approximation. `workspace_id` is NULL: this IS the
  // workspace-LESS DirectPair the coverage gap is about.
  //
  // Participant DM: the human endpoint is the viewer → the view gate admits.
  const dpHuman = conversations.getOrCreateDirectPair(
    { kind: 'agent', id: self },
    { kind: 'human', id: t.viewerUserId },
    1,
  ).conversation.id;
  // Non-participant DM: two agents, no human endpoint at all → the viewer human
  // matches neither endpoint. Canonical endpoint ordering is the constructor's
  // job, not the test's.
  const dpAgents = conversations.getOrCreateDirectPair(
    { kind: 'agent', id: self },
    { kind: 'agent', id: peer },
    1,
  ).conversation.id;

  return { t, dpHumanId: dpHuman, dpAgentsId: dpAgents };
}

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.t.cleanup();
  fixture = undefined;
});

/** HTTP client authenticated as the DirectPair's human endpoint (the viewer). */
function asViewer(f: Fixture) {
  return http(f.t, {
    [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(f.t.viewerUserId),
  });
}

describe('workspace-less DirectPair × canViewConversation view routes (#task:2105)', () => {
  for (const route of ROUTES) {
    describe(route.name, () => {
      it('admits the DirectPair participant with 200 (same authority as a channel member)', async () => {
        fixture = setup();
        const res = await asViewer(fixture).get(route.path(fixture.dpHumanId));
        expect(res.status).toBe(200);
      });

      it('returns 404 with the channel branch body for an unknown conversation id', async () => {
        fixture = setup();
        const res = await asViewer(fixture).get(route.path('no-such-conversation'));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'channel not found' });
      });

      it('returns 403 with the channel branch body for an existing DirectPair the viewer is no endpoint of', async () => {
        fixture = setup();
        const res = await asViewer(fixture).get(route.path(fixture.dpAgentsId));
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'forbidden' });
      });
    });
  }
});
