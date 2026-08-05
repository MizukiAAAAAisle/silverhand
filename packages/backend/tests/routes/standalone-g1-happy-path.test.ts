/**
 * D4.a Commit 6 (1) — standalone backend G1 happy-path integration.
 *
 * **Naming / fixture invariant (Cindy `MqA4uoNcRByKcf9E` lock).**
 * This file deliberately runs under `deploymentMode: 'standalone'`
 * for every test. Test names, describe blocks, and fixture variables
 * are all phrased around STANDALONE semantics — there is no embedded
 * setup short-circuit here. The whole point of the G1 path is that
 * a remote-deployed backend (no daemon attached, no agent runtime
 * available) can still serve the user-facing control plane:
 *
 *   GET  /api/server/info           → signup_enabled + bind_address_scope
 *   POST /auth/signup               → user + user_token (mints session)
 *   POST /auth/login                → user + user_token (re-mints session)
 *   POST /api/workspaces            → empty-agent workspace (server-side host)
 *   POST /api/workspaces/:id/channels → empty-agent channel
 *   POST /api/channels/:id/messages → human-authored message + bus event
 *
 * Each route operates on the same standalone `BackendContext` (no
 * embedded `loadOrCreateServerConfig` artifact ever materializes —
 * that gate lives in the desktop `executeBackendStartup` adapter and
 * is pinned separately in `apps/desktop/src/main/__tests__/`).
 *
 * **Out of scope on purpose:**
 *   - Anything that needs a live daemon host (agent CREATE / START /
 *     STOP / message-to-agent). Those are blocked by the
 *     `standaloneMode(ctx)` gate at the top of each route and are
 *     covered by the typed-fail tests in
 *     `agents-no-host-typed-fail.test.ts` (D4.a Commit 6 part 3).
 *   - Outbound WS bring-up. The test bus is an in-process
 *     `ScopeEventBus`; we assert the publish/subscribe happens at the
 *     application layer. Outbound fanout wiring is pinned in
 *     `ws/host-ws-server.test.ts` and `routes/readyz.test.ts`.
 *
 * R4 note (re-stated for the PR description): the IPC between
 * desktop main process and backend is a local supervisor/control
 * channel, not server↔daemon formal semantics. Standalone deployment
 * exercises the server↔daemon outbound WS protocol exclusively.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { OUTBOUND_PROTOCOL_VERSION } from '@silverhand/host';
import {
  apiPaths,
  authPaths,
  DESKTOP_SERVER_API_EPOCH,
  MINIMUM_CLIENT_API_EPOCH,
  suggestParticipantNameFromEmail,
} from '@silverhand/shared';
import type { ConversationBusEvent } from '../../src/ws/scope-event-bus.js';
import { buildTestApp, type TestApp } from '../utils/app.js';
import { CURRENT_DESKTOP_EPOCH_HEADERS } from '../utils/desktop-client-epoch.js';

describe('standalone backend G1 — user-facing happy path (no daemon attached)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('GET /api/server/info on a standalone (lan-scoped) backend exposes signup_enabled + bind_address_scope', async () => {
    // Pinned shape —
    // these two fields are the contract the desktop wizard reads to
    // decide whether to render the signup form and whether to surface
    // the "exposed beyond loopback" badge. A drift that drops either
    // field is a remote-onboarding UX regression.
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const res = await fetchJson(t, 'GET', apiPaths.serverInfo);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      signup_enabled: true,
      bind_address_scope: 'lan',
      outbound_protocol_version: OUTBOUND_PROTOCOL_VERSION,
      // #task:1761 — epoch advertisement joins the server-info contract.
      desktop_api: {
        current_epoch: DESKTOP_SERVER_API_EPOCH,
        minimum_client_epoch: MINIMUM_CLIENT_API_EPOCH,
      },
    });
  });

  it('GET /api/server/info on a standalone backend with signup disabled reports signup_enabled=false (no route flip)', async () => {
    // D4.a Commit 4 contract: signup is always mounted; the disabled
    // state is signaled via this field + a typed 403 on POST /auth/signup.
    // Pin the standalone variant of that contract here.
    t = buildTestApp({
      deploymentMode: 'standalone',
      bindAddressScope: 'public',
      authConfig: { signupEnabled: false },
    });
    const info = await fetchJson(t, 'GET', apiPaths.serverInfo);
    expect(info.status).toBe(200);
    expect(info.body).toEqual({
      signup_enabled: false,
      bind_address_scope: 'public',
      outbound_protocol_version: OUTBOUND_PROTOCOL_VERSION,
      // #task:1761 — epoch advertisement joins the server-info contract.
      desktop_api: {
        current_epoch: DESKTOP_SERVER_API_EPOCH,
        minimum_client_epoch: MINIMUM_CLIENT_API_EPOCH,
      },
    });
    const blocked = await fetchJson(t, 'POST', authPaths.signup, {
      email: 'late@example.com',
      password: 'correct-password',
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'signup_disabled' });
  });

  it('POST /auth/signup on a standalone backend issues a real user + user_token (no embedded bootstrap involved)', async () => {
    // Standalone path: there is no `consumeEmbeddedBootstrapToken`
    // route in this mode (the embedded bootstrap route is mounted
    // only when `ctx.deploymentMode === 'embedded'`). The signup
    // endpoint MUST stand on its own as the way to mint a session.
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const signup = await fetchJson(t, 'POST', authPaths.signup, {
      email: 'remote.user@example.test',
      password: 'correct-password',
      name: 'remote-user',
      display_name: 'Remote User',
    });
    expect(signup.status).toBe(200);
    expect(signup.body.user_token).toEqual(expect.any(String));
    expect(signup.body.user).toMatchObject({
      name: 'remote-user',
      display_name: 'Remote User',
    });

    // The standalone embedded-bootstrap route is NOT mounted; pin
    // that calling it returns 404 (Hono default → plain text body,
    // so we only assert status). If a future regression mounts it
    // unconditionally, the test fails loud — that route is the
    // single-user shortcut for embedded loopback and has no meaning
    // on a multi-user standalone deployment.
    const bootstrap = await t.app.fetch(
      new Request(`http://localhost${authPaths.embeddedBootstrap}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'whatever' }),
      }),
    );
    expect(bootstrap.status).toBe(404);
  });

  it('POST /auth/login on a standalone backend authenticates a previously-signed-up user', async () => {
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const signup = await fetchJson(t, 'POST', authPaths.signup, {
      email: 'login.test@example.test',
      password: 'correct-password',
      name: 'login-test',
    });
    expect(signup.status).toBe(200);

    const login = await fetchJson(t, 'POST', authPaths.login, {
      email: 'login.test@example.test',
      password: 'correct-password',
    });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(signup.body.user.id);
    expect(login.body.user_token).toEqual(expect.any(String));
    // A fresh login mints a NEW session, not the same token. Pin
    // that — a regression that returned the previously issued token
    // would mean logout-of-one-session silently logs out every
    // device, which is a real security regression on standalone
    // (multi-device) deployments.
    expect(login.body.user_token).not.toBe(signup.body.user_token);

    const wrong = await fetchJson(t, 'POST', authPaths.login, {
      email: 'login.test@example.test',
      password: 'incorrect-password',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error_code: 'auth_failed' });
  });

  it('POST /api/workspaces on standalone — succeeds with or without a claimed local host, and binds the workspace to no computer (§7-4)', async () => {
    // D4.c C3 retired the synthetic `STANDALONE_SERVER` host and made create
    // resolve `resolveOwnedLocalForUser(viewerUserId)` instead. relocation-v1
    // §7-4 (#task:1808) then retired PLACEMENT itself: a regular workspace has
    // no owning computer, so create resolves none and the 0-host case is no
    // longer a failure — an unclaimed installation can create a workspace.
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const token = await signupReturnToken(t, 'ws.owner@example.test');

    // Inverted pin: no host claimed yet used to be a typed 409
    // `local_host_unbound`. There is nothing left to place, so it is a 201.
    const beforeClaim = await fetchJson(
      t,
      'POST',
      apiPaths.workspaces,
      { name: `g1-pre-${randomSlug()}` },
      bearer(token),
    );
    expect(beforeClaim.status).toBe(201);
    expect(beforeClaim.body.workspace.workspace_host_id).toBeUndefined();

    // Claiming a local host is still what makes the installation usable for
    // AGENT placement; workspace create is unaffected by it either way.
    await claimLocalHost(t, token);
    const create = await fetchJson(
      t,
      'POST',
      apiPaths.workspaces,
      { name: `g1-${randomSlug()}` },
      bearer(token),
    );
    expect(create.status).toBe(201);
    expect(create.body.workspace).toMatchObject({
      name: expect.stringMatching(/^g1-/),
    });
    // relocation-v1 §7-4 — a regular workspace has no owning computer, so the
    // create DTO carries no host pointer (the claim above is still what makes
    // the installation usable for AGENT placement).
    expect(create.body.workspace.workspace_host_id).toBeUndefined();
    expect(create.body.onboarding_channel_id).toEqual(expect.any(String));
  });

  it('POST /api/workspaces with nonexistent member_agent_ids on standalone — silently filtered (existing pattern), workspace creates', async () => {
    // D4.c C3 — pre-C3 this returned typed
    // `host_runtime_disabled` because standalone POST short-circuited.
    // After C3 the route runs the same path as embedded:
    // `agents.get(id)` resolves to null, the filter drops it, and
    // workspace creation proceeds with `memberAgents = []`. This is
    // the embedded behavior carried into standalone — no special
    // case. (Cross-host members are ACCEPTED since #task:1600; the
    // acceptance pins live in the workspace route tests, not this
    // G1 happy-path file.)
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const token = await signupReturnToken(t, 'ws.refuse@example.test');
    await claimLocalHost(t, token);
    const res = await fetchJson(
      t,
      'POST',
      apiPaths.workspaces,
      {
        name: `g1-refuse-${randomSlug()}`,
        member_agent_ids: ['nonexistent-agent-id'],
      },
      bearer(token),
    );
    expect(res.status).toBe(201);
    expect(res.body.workspace.member_agent_ids ?? []).toEqual([]);
  });

  it('POST /api/workspaces with REAL member_agent_ids on standalone → 201, pure DB write: NO provision, NO eager seed (provisioning collapse)', async () => {
    // D4.e-3 — pre-D4.e-3 this combo was refused 409
    // `workspace_member_seed_unsupported` because the create route seeded agent
    // L2 on the BACKEND disk, which in standalone (owning daemon is another
    // machine) would write a remote host's path locally (I1 violation). D4.e-3
    // moved seeding to the owning daemon; relocation-v1 §7 task 4 then severed
    // create from the daemon registry entirely: create-with-members is a pure
    // DB membership write — no `workspace_provision`, no eager seed — and each
    // member's L2 is materialized lazily at its first spawn.
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const token = await signupReturnToken(t, 'ws.seed@example.test');
    const claimedHostId = await claimLocalHost(t, token);

    // A REAL agent on the claimed host — the request reaches the
    // daemon-mediated seed on that same host (same-host member path).
    const ownerUserId = t.ctx.db
      .prepare<[], { id: string }>(
        `SELECT id FROM users WHERE email = 'ws.seed@example.test'`,
      )
      .get()?.id;
    expect(ownerUserId).toEqual(expect.any(String));
    const agentId = `seed-agent-${randomSlug()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
      )
      .run(agentId, `seed-${randomSlug()}`, claimedHostId, ownerUserId!, now, now);

    const wsName = `g1seed-${randomSlug()}`;
    const res = await fetchJson(
      t,
      'POST',
      apiPaths.workspaces,
      { name: wsName, member_agent_ids: [agentId] },
      bearer(token),
    );
    expect(res.status).toBe(201);

    // Pure DB write: NO daemon provision and NO eager seed.
    const seedCalls = t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed');
    expect(seedCalls).toHaveLength(0);

    // Workspace row + membership persisted.
    const rowCount = t.ctx.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM workspaces WHERE name = ?`,
      )
      .get(wsName)?.c;
    expect(rowCount).toBe(1);
    const memberCount = t.ctx.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM workspace_members WHERE agent_id = ?`,
      )
      .get(agentId)?.c;
    expect(memberCount).toBe(1);
  });

  it('POST /api/workspaces/:id/channels (no agents) on standalone creates a channel and publishes workspace_channels_changed', async () => {
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const token = await signupReturnToken(t, 'channel.owner@example.test');
    await claimLocalHost(t, token);

    const ws = await fetchJson(
      t,
      'POST',
      apiPaths.workspaces,
      { name: `g1ch-${randomSlug()}` },
      bearer(token),
    );
    expect(ws.status).toBe(201);
    const workspaceId = ws.body.workspace.id as string;

    // The channel-create handler publishes a
    // `workspace_channels_changed` event to the `workspace:{id}` WS
    // scope. We don't have a WS server here, but the in-process bus
    // exposes `subscribeScope` directly. Subscribing pins that the
    // standalone happy path still fans an event up to the workspace
    // scope — that's what the renderer's React Query invalidator
    // listens to.
    const scopedEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubscribe = t.ctx.events.subscribeScope(
      `workspace:${workspaceId}`,
      event => {
        scopedEvents.push({ kind: event.kind, payload: event.payload });
      },
    );

    const channel = await fetchJson(
      t,
      'POST',
      apiPaths.workspaceChannels(workspaceId),
      { title: 'standalone-g1-channel' },
      bearer(token),
    );
    unsubscribe();
    expect(channel.status).toBe(201);
    expect(channel.body.channel).toMatchObject({
      title: 'standalone-g1-channel',
    });
    expect(
      scopedEvents.find(e => e.kind === 'workspace_channels_changed'),
    ).toBeDefined();
  });

  it('POST /api/workspaces/:id/channels with member_agent_ids on standalone creates an agent-backed channel', async () => {
    // Remote standalone servers are now control-plane capable for
    // existing workspace agents. The old route-level
    // `host_runtime_disabled` guard was stale after daemon-mediated
    // workspace/member provisioning landed.
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const token = await signupReturnToken(t, 'channel.agent@example.test');
    const claimedHostId = await claimLocalHost(t, token);
    const ownerUserId = t.ctx.db
      .prepare<[], { id: string }>(
        `SELECT id FROM users WHERE email = 'channel.agent@example.test'`,
      )
      .get()?.id;
    expect(ownerUserId).toEqual(expect.any(String));

    const agentId = `channel-agent-${randomSlug()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
      )
      .run(agentId, `channel-${randomSlug()}`, claimedHostId, ownerUserId!, now, now);

    const ws = await fetchJson(
      t,
      'POST',
      apiPaths.workspaces,
      { name: `g1agentch-${randomSlug()}`, member_agent_ids: [agentId] },
      bearer(token),
    );
    expect(ws.status).toBe(201);
    const workspaceId = ws.body.workspace.id as string;

    const channel = await fetchJson(
      t,
      'POST',
      apiPaths.workspaceChannels(workspaceId),
      { title: 'standalone-agent-backed', member_agent_ids: [agentId] },
      bearer(token),
    );
    expect(channel.status).toBe(201);
    const memberCount = t.ctx.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c
           FROM conversation_agents
          WHERE conversation_id = ? AND agent_id = ?`,
      )
      .get(channel.body.channel.id as string, agentId)?.c;
    expect(memberCount).toBe(1);
  });

  it('POST /api/channels/:id/messages (no agents in channel) on standalone persists the message and publishes a conversation event', async () => {
    // End-to-end pin: standalone backend, fresh user, fresh workspace
    // + channel, post a human message, observe the conversation-level
    // 'message' event hit a subscriber. This is the slimmest possible
    // signal the renderer/CLI rely on to refresh their conversation
    // view in the absence of any daemon-side activity.
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const token = await signupReturnToken(t, 'sender@example.test');
    await claimLocalHost(t, token);
    const ws = await fetchJson(
      t,
      'POST',
      apiPaths.workspaces,
      { name: `g1msg-${randomSlug()}` },
      bearer(token),
    );
    expect(ws.status).toBe(201);
    const workspaceId = ws.body.workspace.id as string;
    const channel = await fetchJson(
      t,
      'POST',
      apiPaths.workspaceChannels(workspaceId),
      { title: 'standalone-g1-chat' },
      bearer(token),
    );
    expect(channel.status).toBe(201);
    const channelId = channel.body.channel.id as string;

    const seenEvents: ConversationBusEvent[] = [];
    const unsubscribe = t.ctx.events.subscribe(channelId, event => {
      seenEvents.push(event);
    });

    const send = await fetchJson(
      t,
      'POST',
      apiPaths.channelMessages(channelId),
      { content: 'hello from standalone G1' },
      bearer(token),
    );
    unsubscribe();
    expect(send.status).toBe(201);
    expect(send.body.message).toMatchObject({
      content: 'hello from standalone G1',
      from_kind: 'user',
    });

    const messageEvents = seenEvents.filter(e => e.kind === 'message');
    expect(messageEvents).toHaveLength(1);
    expect(messageEvents[0]?.payload).toMatchObject({
      message: { id: send.body.message.id },
    });

    // The fake runtime host (which would normally see a
    // `deliverMessage` for any subscribed agent) is unused on
    // standalone because the channel has no agent members. Pin that
    // — the FakeConversationManager has zero calls, ruling out an
    // accidental embedded-path drift that tried to spawn a runtime
    // for an agent-less channel.
    expect(t.fake.delivered).toEqual([]);
    expect(t.fake.starts).toEqual([]);
  });

  it('POST /api/channels/:id/messages on standalone delivers to agent-backed channel via fake runtime (D4.b P1-1 lift)', async () => {
    // D4.b P1-1 lift: the blanket `standaloneMode(ctx)` guard on
    // send-to-agent-backed was removed because standalone with an
    // attached daemon must accept user messages and surface them
    // through the outbound dispatch path. With `buildTestApp`'s
    // FakeConversationManager standing in for runtimeHost,
    // `deliverMessage` is recorded on `t.fake.delivered`.
    //
    // The pre-D4.b test asserted 409 `host_runtime_disabled` here;
    // that arm is now obsolete (the gate is gone). The "no daemon
    // attached" scenario produces typed `host_attach_pending` (503)
    // through `OutboundRuntimeEventFanout.connectedConnectionId`
    // and is covered end-to-end by the G2 route e2e
    // (`standalone-route-runtime.test.ts`).
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const token = await signupReturnToken(t, 'fail.send@example.test');
    const claimedHostId = await claimLocalHost(t, token);
    const ws = await fetchJson(
      t,
      'POST',
      apiPaths.workspaces,
      { name: `g1fs-${randomSlug()}` },
      bearer(token),
    );
    expect(ws.status).toBe(201);
    const workspaceId = ws.body.workspace.id as string;
    const channel = await fetchJson(
      t,
      'POST',
      apiPaths.workspaceChannels(workspaceId),
      { title: 'standalone-g1-fail-send' },
      bearer(token),
    );
    expect(channel.status).toBe(201);
    const channelId = channel.body.channel.id as string;

    // The synthetic agent lives on the user's claimed local host so
    // runtime delivery routes to the daemon this test drives
    // (cross-computer membership is legal since #task:1600, but this
    // test exercises the same-host delivery path).
    const agentId = `synthetic-agent-${randomSlug()}`;
    const now = Date.now();
    const ownerUserId = t.ctx.db
      .prepare<[], { id: string }>(
        `SELECT id FROM users WHERE email = 'fail.send@example.test'`,
      )
      .get()?.id;
    expect(ownerUserId).toEqual(expect.any(String));
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
      )
      .run(
        agentId,
        `synthetic-${randomSlug()}`,
        claimedHostId,
        ownerUserId!,
        now,
        now,
      );
    t.ctx.db
      .prepare(
        `INSERT INTO conversation_agents (conversation_id, agent_id, status, joined_at)
         VALUES (?, ?, 'idle', ?)`,
      )
      .run(channelId, agentId, now);

    const send = await fetchJson(
      t,
      'POST',
      apiPaths.channelMessages(channelId),
      { content: 'delivered via fake' },
      bearer(token),
    );
    expect(send.status).toBe(201);
    expect(send.body.message.content).toBe('delivered via fake');
    // Lift contract: deliverMessage IS called now (was blocked
    // pre-lift). The fake records the (conv, agent, messageId)
    // tuple so a regression that re-adds the gate flips this
    // assertion red.
    expect(t.fake.delivered).toHaveLength(1);
    expect(t.fake.delivered[0]).toMatchObject({
      conversationId: channelId,
      agentId,
      messageId: send.body.message.id,
    });
  });
});

// ── Test helpers ────────────────────────────────────────────────────

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function randomSlug(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function signupReturnToken(t: TestApp, email: string): Promise<string> {
  const signup = await fetchJson(t, 'POST', authPaths.signup, {
    email,
    password: 'correct-password',
    // Signup now requires an explicit handle; these callers only care about the
    // resulting session, so they take the same prefill the signup form offers.
    name: suggestParticipantNameFromEmail(email),
  });
  if (signup.status !== 200) {
    throw new Error(
      `signupReturnToken: unexpected status ${signup.status}: ${JSON.stringify(
        signup.body,
      )}`,
    );
  }
  return signup.body.user_token as string;
}

/**
 * D4.c C3 helper — claim a local host for the bearer's user. After
 * C3 the standalone POST /api/workspaces path goes through
 * `resolveOwnedLocalForUser`, so a freshly signed-up user with no
 * claimed host fails closed with 409 `local_host_unbound`. The
 * pre-D4.c synthetic `STANDALONE_SERVER` host placeholder is gone.
 * Real users / desktops get here by running the host claim flow
 * once on first login (Stage B.4 + the desktop main process
 * onboarding); tests have to do the same.
 */
async function claimLocalHost(t: TestApp, token: string): Promise<string> {
  const res = await fetchJson(
    t,
    'POST',
    apiPaths.hostClaimOrCreate,
    { installation_id: crypto.randomUUID() },
    bearer(token),
  );
  if (res.status !== 200) {
    throw new Error(
      `claimLocalHost: unexpected status ${res.status}: ${JSON.stringify(
        res.body,
      )}`,
    );
  }
  return res.body.host_id as string;
}

/**
 * Raw fetch helper — does NOT auto-attach the fixture's pre-seeded
 * `target.authToken` like the shared `http()` helper does, because the
 * standalone happy path is specifically about exercising the
 * signup-and-login-issued token flow. Tests pass explicit headers
 * when they need authentication.
 *
 * The desktop API epoch header IS attached: it is not authentication but
 * client-generation admission, and every caller here speaks for a current
 * desktop (an epoch-less client is refused with 426 before any route runs).
 */
async function fetchJson(
  t: TestApp,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await t.app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...CURRENT_DESKTOP_EPOCH_HEADERS,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}
