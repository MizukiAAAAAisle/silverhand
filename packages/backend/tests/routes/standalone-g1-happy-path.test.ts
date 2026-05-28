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
import { apiPaths, authPaths } from '@silverhand/shared';
import type { ConversationBusEvent } from '../../src/ws/scope-event-bus.js';
import { buildTestApp, type TestApp } from '../utils/app.js';

describe('standalone backend G1 — user-facing happy path (no daemon attached)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('GET /api/server/info on a standalone (lan-scoped) backend exposes signup_enabled + bind_address_scope', async () => {
    // Pinned shape per `docs/remote-backend-d4-design.md` §6.2 / §6.3 —
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

  it('POST /api/workspaces on a standalone backend creates a no-agent workspace (server-side host) with an onboarding channel', async () => {
    // Standalone-specific assertion: the workspace's host is
    // `hosts.ensureStandaloneServer()` — NOT the viewer's local
    // host. The route resolves that automatically when no
    // `workspace_host_id` is provided AND `member_agent_ids` is
    // empty. A regression that fell into the embedded
    // `resolveCreateHostId(undefined, viewerUserId)` branch on
    // standalone would surface as `host_not_owned` (the viewer has
    // no local host claimed in a remote deployment) — this test
    // catches that by asserting the 201 + the workspace host id
    // matches the standalone server row.
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const token = await signupReturnToken(t, 'ws.owner@example.test');

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
    expect(create.body.onboarding_channel_id).toEqual(expect.any(String));

    // Verify host pointer matches the standalone server host row.
    // The standalone host row is created lazily on first standalone
    // workspace create via `hosts.ensureStandaloneServer()`; the row
    // is identified by its well-known name (kind='remote').
    const standaloneHostId = t.ctx.db
      .prepare<[], { id: string }>(
        `SELECT id FROM hosts WHERE name = 'standalone-server'`,
      )
      .get()?.id;
    expect(standaloneHostId).toEqual(expect.any(String));
    expect(create.body.workspace.workspace_host_id).toBe(standaloneHostId);
  });

  it('POST /api/workspaces with member_agent_ids on standalone → typed host_runtime_disabled (409, no agent path)', async () => {
    // Negative pin: even if the renderer or a malformed client tries
    // to slip agent ids past the gate, standalone backends MUST refuse
    // with the typed `host_runtime_disabled` body. Without this the
    // workspace create would fall through to placement.assertAgentMatchesHost
    // and produce a less typed error.
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const token = await signupReturnToken(t, 'ws.refuse@example.test');
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
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'host_runtime_disabled' });
  });

  it('POST /api/workspaces/:id/channels (no agents) on standalone creates a channel and publishes workspace_channels_changed', async () => {
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const token = await signupReturnToken(t, 'channel.owner@example.test');

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

  it('POST /api/channels/:id/messages (no agents in channel) on standalone persists the message and publishes a conversation event', async () => {
    // End-to-end pin: standalone backend, fresh user, fresh workspace
    // + channel, post a human message, observe the conversation-level
    // 'message' event hit a subscriber. This is the slimmest possible
    // signal the renderer/CLI rely on to refresh their conversation
    // view in the absence of any daemon-side activity.
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const token = await signupReturnToken(t, 'sender@example.test');
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

  it('POST /api/channels/:id/messages on standalone refuses to send to an agent-backed channel with host_runtime_disabled (409)', async () => {
    // We can't create an agent on standalone (`POST /api/agents` is
    // blocked too), so simulate the negative arm by adding an agent
    // row directly via the test database, then flipping the channel
    // to include it. The route's send-time `standaloneMode(ctx) &&
    // conversations.listAgents(...).length > 0` gate must fire BEFORE
    // the message service runs.
    t = buildTestApp({ deploymentMode: 'standalone', bindAddressScope: 'lan' });
    const token = await signupReturnToken(t, 'fail.send@example.test');
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

    // Side-door: insert a synthetic agent row + add it to the
    // channel directly. The route handler doesn't care whether the
    // agent is "live" on a daemon; the gate is purely a count check.
    // Reuse the standalone-server host row (already materialized by
    // the workspace create above) to satisfy `agents.host_id NOT NULL`.
    const standaloneHostId = t.ctx.db
      .prepare<[], { id: string }>(
        `SELECT id FROM hosts WHERE name = 'standalone-server'`,
      )
      .get()?.id;
    expect(standaloneHostId).toEqual(expect.any(String));
    const agentId = `synthetic-agent-${randomSlug()}`;
    const now = Date.now();
    // Resolve the freshly-signed-up user id from the workspace owner
    // bearer — agents.created_by_user_id is NOT NULL FK to users.id.
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
        standaloneHostId!,
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
      { content: 'should be refused' },
      bearer(token),
    );
    expect(send.status).toBe(409);
    expect(send.body).toMatchObject({ code: 'host_runtime_disabled' });
    expect(t.fake.delivered).toEqual([]);
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
 * Raw fetch helper — does NOT auto-attach the fixture's pre-seeded
 * `target.authToken` like the shared `http()` helper does, because the
 * standalone happy path is specifically about exercising the
 * signup-and-login-issued token flow. Tests pass explicit headers
 * when they need authentication.
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
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}
