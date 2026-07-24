import { afterEach, describe, expect, it } from 'vitest';
import {
  HOST_PROXY_CONFIG_OFFLINE_ERROR_CODE,
  HOST_WS_CLOSE_REASON_DISCONNECTED,
  HOST_WS_CLOSE_REASON_REVOKED,
  apiPaths,
  assembleConnectCommand,
} from '@silverhand/shared';
import type {
  OutboundServerCommandKind,
  OutboundServerCommandParams,
  OutboundServerCommandResult,
} from '@silverhand/host';
import { HostTokenService, hashHostToken } from '../../src/auth/host-token.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import type { HostWsServerController } from '../../src/ws/host-ws-server.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('host routes', () => {
  let t: TestApp | null = null;

  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('claims the legacy local host and stores only a host_token hash', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    const userToken = t.ctx.authSessions.issueSession({
      userId: t.viewerUserId,
    }).userToken;
    const legacyLocal = new HostRepo(t.ctx.db).getByName('local');
    expect(legacyLocal).toMatchObject({
      user_id: null,
      installation_id: null,
      revoked_at: null,
    });

    const res = await sessionHttp(t, userToken).post(apiPaths.hostClaimOrCreate, {
      installation_id: '11111111-1111-4111-8111-111111111111',
      label: 'Dev Mac',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      host_id: legacyLocal!.id,
      host: {
        id: legacyLocal!.id,
        name: 'local',
        kind: 'local',
        created_at: expect.any(Number),
        revoked_at: null,
        last_seen_at: expect.any(Number),
      },
      host_token: expect.any(String),
    });
    expect(body.host.id).toBe(body.host_id);
    // Pure form: claim-or-create ships identity only — it never echoes the
    // server's own URL, so the bind address cannot leak to the daemon (which
    // uses its own connected URL for daemon-config).
    expect(body.server_url).toBeUndefined();

    const host = new HostRepo(t.ctx.db).get(body.host_id);
    expect(host).toMatchObject({
      user_id: t.viewerUserId,
      installation_id: '11111111-1111-4111-8111-111111111111',
      revoked_at: null,
    });

    const credential = t.ctx.db
      .prepare<[string], { token_hash: string; kind: string }>(
        `SELECT token_hash, kind FROM host_credentials WHERE host_id = ?`,
      )
      .get(body.host_id);
    expect(credential).toEqual({
      token_hash: hashHostToken(body.host_token),
      kind: 'long_lived',
    });
    expect(credential!.token_hash).not.toBe(body.host_token);
    expect(new HostTokenService(t.ctx.db).verifyHostToken(body.host_token))
      .toMatchObject({
        ok: true,
        hostId: body.host_id,
        userId: t.viewerUserId,
      });
  });

  it('reuses the existing host without minting a token when desktop already has one', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    const userToken = t.ctx.authSessions.issueSession({
      userId: t.viewerUserId,
    }).userToken;
    const h = sessionHttp(t, userToken);
    const first = await h.json<any>(
      h.post(apiPaths.hostClaimOrCreate, {
        installation_id: '22222222-2222-4222-8222-222222222222',
      }),
    );

    const secondRes = await h.post(apiPaths.hostClaimOrCreate, {
      installation_id: '22222222-2222-4222-8222-222222222222',
      current_host_id: first.host_id,
    });

    expect(secondRes.status).toBe(200);
    const second = await secondRes.json() as any;
    expect(second.host_id).toBe(first.host_id);
    expect(second).not.toHaveProperty('host_token');
    const count = t.ctx.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM host_credentials WHERE host_id = ?`,
      )
      .get(first.host_id);
    expect(count?.c).toBe(1);
  });

  it('mints a replacement token when current_host_id has no active credential', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    const userToken = t.ctx.authSessions.issueSession({
      userId: t.viewerUserId,
    }).userToken;
    const h = sessionHttp(t, userToken);
    const first = await h.json<any>(
      h.post(apiPaths.hostClaimOrCreate, {
        installation_id: '22222222-2222-4222-8222-222222222223',
      }),
    );
    t.ctx.db
      .prepare(`UPDATE host_credentials SET revoked_at = ? WHERE host_id = ?`)
      .run(1_700_000_000_000, first.host_id);

    const secondRes = await h.post(apiPaths.hostClaimOrCreate, {
      installation_id: '22222222-2222-4222-8222-222222222223',
      current_host_id: first.host_id,
    });

    expect(secondRes.status).toBe(200);
    const second = await secondRes.json() as any;
    expect(second.host_id).toBe(first.host_id);
    expect(second.host_token).toEqual(expect.any(String));
    expect(second.host_token).not.toBe(first.host_token);
    const count = t.ctx.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM host_credentials WHERE host_id = ?`,
      )
      .get(first.host_id);
    expect(count?.c).toBe(2);
    expect(new HostTokenService(t.ctx.db).verifyHostToken(second.host_token))
      .toMatchObject({
        ok: true,
        hostId: first.host_id,
        userId: t.viewerUserId,
      });
  });

  it('mints a fresh active host when the prior (user, installation) was revoked (Stage B.4 active-only UNIQUE)', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    const userToken = t.ctx.authSessions.issueSession({
      userId: t.viewerUserId,
    }).userToken;
    const h = sessionHttp(t, userToken);
    const first = await h.json<any>(
      h.post(apiPaths.hostClaimOrCreate, {
        installation_id: '33333333-3333-4333-8333-333333333333',
      }),
    );

    expect(new HostRepo(t.ctx.db).revoke(first.host_id)).toBe(true);
    const second = await h.post(apiPaths.hostClaimOrCreate, {
      installation_id: '33333333-3333-4333-8333-333333333333',
    });

    // Stage B.4: re-claim after revoke transparently mints a NEW
    // active host row (no 409). The old revoked row stays for audit
    // history; the active-only partial UNIQUE permits a second
    // active row for the same (user, installation).
    expect(second.status).toBe(200);
    const body = (await second.json()) as any;
    expect(body.host_id).not.toBe(first.host_id);
    expect(body.host).toMatchObject({
      id: body.host_id,
      kind: 'local',
      revoked_at: null,
    });
    expect(body.host_token).toEqual(expect.any(String));
    const rows = t.ctx.db
      .prepare<[string, string], { id: string; revoked_at: number | null }>(
        `SELECT id, revoked_at FROM hosts
          WHERE user_id = ?
            AND installation_id = ?
          ORDER BY created_at ASC`,
      )
      .all(t.viewerUserId, '33333333-3333-4333-8333-333333333333');
    expect(rows).toHaveLength(2);
    const firstRow = rows.find(r => r.id === first.host_id);
    const newRow = rows.find(r => r.id === body.host_id);
    expect(firstRow?.revoked_at).toEqual(expect.any(Number));
    expect(newRow?.revoked_at).toBeNull();
  });

  it('rejects retired server-config bearer access to the token-bearing claim route', async () => {
    t = buildTestApp();
    const res = await legacyServerAuthHttp(t).post(apiPaths.hostClaimOrCreate, {
      installation_id: '44444444-4444-4444-8444-444444444444',
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    const count = t.ctx.db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM host_credentials`)
      .get();
    expect(count?.c).toBe(0);
  });

  // ── POST /api/hosts/claim_or_create — standalone (D4.c C2) ───
  describe('POST /api/hosts/claim_or_create (standalone)', () => {
    /**
     * D4.c C2 — pre-D4.c the standalone branch in routes.ts short-
     * circuited every host-mutation route to `host_runtime_disabled`
     * (409). C2 lifts that guard: standalone now owns a real hosts
     * table populated by remote daemons attaching over outbound WSS,
     * so claim_or_create has to succeed and persist a credential just
     * like embedded.
     *
     * R4 boundary: this test exercises the SAME HTTP route, the SAME
     * DB write, and the SAME host_token contract regardless of
     * deployment mode — there is no wire-protocol fork.
     */
    it('claims a host and mints a credential under standalone (no host_runtime_disabled)', async () => {
      t = buildTestApp({
        deploymentMode: 'standalone',
        ownedLocalHostUserIds: [],
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;

      const res = await sessionHttp(t, userToken).post(apiPaths.hostClaimOrCreate, {
        installation_id: '5a000001-1111-4111-8111-111111111111',
        label: 'Standalone Mac',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toMatchObject({
        host_id: expect.any(String),
        host: {
          id: body.host_id,
          kind: 'local',
          revoked_at: null,
        },
        host_token: expect.any(String),
      });
      // The new credential is verifiable end-to-end — same shape as
      // embedded mode.
      expect(new HostTokenService(t.ctx.db).verifyHostToken(body.host_token))
        .toMatchObject({
          ok: true,
          hostId: body.host_id,
          userId: t.viewerUserId,
        });
    });
  });

  // ── POST /api/hosts — user-managed computer create ─────────────
  describe('POST /api/hosts', () => {
    it('creates a pending user-managed computer and returns an identity-only bootstrap payload', async () => {
      const previousSpec = process.env.SILVERHAND_DAEMON_NPM_SPEC;
      delete process.env.SILVERHAND_DAEMON_NPM_SPEC;
      try {
        t = buildTestApp();
        const userToken = t.ctx.authSessions.issueSession({
          userId: t.viewerUserId,
        }).userToken;

        const res = await sessionHttp(t, userToken).post(apiPaths.hosts, {});

        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body).toMatchObject({
          host_id: expect.any(String),
          host: {
            id: body.host_id,
            kind: 'remote',
            activated_at: null,
            finalized_at: null,
            provisioning_source: 'user_invite',
            status: 'pending',
            placeable: false,
            revoked_at: null,
          },
          connect_token: expect.any(String),
          daemon_npm_spec: '@silverhand-ai/daemon@latest',
        });
        // Pure form: the server ships identity only — it never mints a command
        // string, never echoes its own URL, and no longer advertises any reach
        // origin, so the bind address cannot leak into the bootstrap wire.
        expect(body.daemon_command).toBeUndefined();
        expect(body.server_url).toBeUndefined();
        expect(body.advertised_origin_override).toBeUndefined();
        // The edge assembles the command from the recipe + its own reach URL;
        // verify the payload assembles to a token-bearing command with no host id.
        const command = assembleConnectCommand({
          daemonNpmSpec: body.daemon_npm_spec,
          serverUrl: 'https://silverhand.taobao.net',
          connectToken: body.connect_token,
        });
        expect(command).toContain('--connect-token');
        expect(command).toContain(body.connect_token);
        expect(command).not.toContain(body.host_id);

        const host = new HostRepo(t.ctx.db).get(body.host_id);
        expect(host).toMatchObject({
          user_id: t.viewerUserId,
          kind: 'remote',
          installation_id: null,
          activated_at: null,
          finalized_at: null,
          provisioning_source: 'user_invite',
        });
        const credential = t.ctx.db
          .prepare<[string], { token_hash: string; kind: string; revoked_at: number | null }>(
            `SELECT token_hash, kind, revoked_at FROM host_credentials WHERE host_id = ?`,
          )
          .get(body.host_id);
        expect(credential).toEqual({
          token_hash: hashHostToken(body.connect_token),
          kind: 'long_lived',
          revoked_at: null,
        });
        expect(credential!.token_hash).not.toBe(body.connect_token);
        expect(new HostTokenService(t.ctx.db).verifyHostToken(body.connect_token))
          .toMatchObject({
            ok: true,
            hostId: body.host_id,
            userId: t.viewerUserId,
          });
      } finally {
        if (previousSpec === undefined) {
          delete process.env.SILVERHAND_DAEMON_NPM_SPEC;
        } else {
          process.env.SILVERHAND_DAEMON_NPM_SPEC = previousSpec;
        }
      }
    });

    it('surfaces the daemon package spec from the environment as the edge-assembly recipe', async () => {
      const previousSpec = process.env.SILVERHAND_DAEMON_NPM_SPEC;
      process.env.SILVERHAND_DAEMON_NPM_SPEC = 'file:/repo/packages/silverhand-daemon';
      try {
        t = buildTestApp();
        const userToken = t.ctx.authSessions.issueSession({
          userId: t.viewerUserId,
        }).userToken;

        const res = await sessionHttp(t, userToken).post(apiPaths.hosts, {});

        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.daemon_npm_spec).toBe('file:/repo/packages/silverhand-daemon');
        // The recipe flows through the payload into the edge-assembled command.
        const command = assembleConnectCommand({
          daemonNpmSpec: body.daemon_npm_spec,
          serverUrl: 'https://silverhand.taobao.net',
          connectToken: body.connect_token,
        });
        expect(command).toContain(
          'npx file:/repo/packages/silverhand-daemon connect --server-url',
        );
        expect(command).toContain('--connect-token');
        expect(command).toContain(body.connect_token);
        expect(command).not.toContain(body.host_id);
      } finally {
        if (previousSpec === undefined) {
          delete process.env.SILVERHAND_DAEMON_NPM_SPEC;
        } else {
          process.env.SILVERHAND_DAEMON_NPM_SPEC = previousSpec;
        }
      }
    });
  });

  // ── GET /api/hosts/connect-token/resolve — daemon command bootstrap ──
  describe('GET /api/hosts/connect-token/resolve', () => {
    it('resolves a user-managed connect-token to its host id without exposing the id in the copied command', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));

      const res = await http(t, {
        authorization: `Bearer ${created.connect_token}`,
      }).get(apiPaths.hostConnectTokenResolve);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ host_id: created.host_id });
      // The copied command carries only the token (host id is resolved server-
      // side from it), so an edge-assembled command never contains the host id.
      const command = assembleConnectCommand({
        daemonNpmSpec: created.daemon_npm_spec,
        serverUrl: 'https://silverhand.taobao.net',
        connectToken: created.connect_token,
      });
      expect(command).not.toContain(created.host_id);
    });

    it('rejects invalid connect-token resolve attempts', async () => {
      t = buildTestApp();

      const res = await http(t, {
        authorization: 'Bearer not-a-real-token',
      }).get(apiPaths.hostConnectTokenResolve);

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error_code: 'unauthorized' });
    });
  });

  // ── GET /api/hosts/:id — by-id host read (includes setup drafts) ──
  describe('GET /api/hosts/:id', () => {
    it('lets the modal read an unfinalized draft while the bulk host list hides it', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));

      const listBeforeAttach = await h.json<{ hosts: any[] }>(h.get(apiPaths.hosts));
      expect(listBeforeAttach.hosts.map(host => host.id)).not.toContain(
        created.host_id,
      );

      const pending = await h.json<any>(h.get(apiPaths.host(created.host_id)));
      expect(pending.host).toMatchObject({
        id: created.host_id,
        status: 'pending',
        placeable: false,
      });

      new HostRepo(t.ctx.db).markActivated(created.host_id, 1_700_000_000_000);
      const attached = await h.json<any>(h.get(apiPaths.host(created.host_id)));
      expect(attached.host).toMatchObject({
        id: created.host_id,
        status: 'attached',
        placeable: false,
      });
      const listAfterAttach = await h.json<{ hosts: any[] }>(h.get(apiPaths.hosts));
      expect(listAfterAttach.hosts.map(host => host.id)).not.toContain(
        created.host_id,
      );
    });

    it('adds diagnostic connected_host_name from the live attachment only', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({
        hostWsController: () => controller,
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      controller = new FakeHostWsController(async () => ({}), {
        hostId: created.host_id,
        hostname: 'build-macbook.local',
      });

      const body = await h.json<any>(h.get(apiPaths.host(created.host_id)));

      expect(body.host).toMatchObject({
        id: created.host_id,
        connected_host_name: 'build-macbook.local',
      });
      expect(body.host.name).not.toBe('build-macbook.local');
    });

    it('returns 404 for cross-user host reads', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: ['alice', 'bob'] });
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const bobHost = new HostRepo(t.ctx.db).getOwnedLocalForUser('bob');
      expect(bobHost).not.toBeNull();

      const res = await sessionHttp(t, aliceToken).get(apiPaths.host(bobHost!.id));

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error_code: 'host_not_found' });
    });
  });

  // ── DELETE /api/hosts/:id — delete empty user-managed computer/setup ──
  describe('DELETE /api/hosts/:id', () => {
    it('hard-deletes a pending user-managed computer setup and invalidates its connect-token', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      const token = created.connect_token as string;

      const res = await h.del(apiPaths.hostCancelPending(created.host_id));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        host_id: created.host_id,
        deleted: true,
      });
      expect(new HostRepo(t.ctx.db).get(created.host_id)).toBeNull();
      expect(
        t.ctx.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM host_credentials WHERE host_id = ?`,
          )
          .get(created.host_id)?.c,
      ).toBe(0);
      expect(new HostTokenService(t.ctx.db).verifyHostToken(token)).toMatchObject({
        ok: false,
        code: 'missing',
      });
      const list = await h.json<{ hosts: any[] }>(h.get(apiPaths.hosts));
      expect(list.hosts.map(host => host.id)).not.toContain(created.host_id);
    });

    it('hard-deletes an attached-but-unfinalized setup and disconnects its live daemon', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({
        hostWsController: () => controller,
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      new HostRepo(t.ctx.db).markActivated(created.host_id, 1_700_000_000_000);
      controller = new FakeHostWsController(async () => {
        throw new Error('cancel must not dispatch commands');
      });

      const res = await h.del(apiPaths.hostCancelPending(created.host_id));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        host_id: created.host_id,
        deleted: true,
      });
      expect(controller.disconnects).toEqual([created.host_id]);
      expect(new HostRepo(t.ctx.db).get(created.host_id)).toBeNull();
      expect(
        new HostTokenService(t.ctx.db).verifyHostToken(created.connect_token),
      ).toMatchObject({
        ok: false,
        code: 'missing',
      });
    });

    it('hard-deletes a finalized empty user-managed computer and invalidates its connect-token', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      const repo = new HostRepo(t.ctx.db);
      repo.markActivated(created.host_id, 1_700_000_000_000);
      repo.markFinalized(created.host_id, 1_700_000_000_100);

      const res = await h.del(apiPaths.hostCancelPending(created.host_id));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        host_id: created.host_id,
        deleted: true,
      });
      expect(repo.get(created.host_id)).toBeNull();
      expect(
        new HostTokenService(t.ctx.db).verifyHostToken(created.connect_token),
      ).toMatchObject({
        ok: false,
        code: 'missing',
      });
    });

    it('rejects delete for user-managed computers with dependent agents/workspaces', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      const repo = new HostRepo(t.ctx.db);
      repo.markActivated(created.host_id, 1_700_000_000_000);
      repo.markFinalized(created.host_id, 1_700_000_000_100);
      const agentId = insertTestAgent(t, {
        name: 'agent-dependent',
        displayName: 'Agent Dependent',
        runtime: 'codex',
        hostId: created.host_id,
      });
      new WorkspaceRepo(t.ctx.db).insert({
        name: 'Dependent Workspace',
        description: null,
        workspacePath: '/tmp/dependent-workspace',
        workspaceHostId: created.host_id,
      });

      const res = await h.del(apiPaths.hostCancelPending(created.host_id));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'computer has dependent resources',
        error_code: 'has_dependents',
        dependents: {
          agents: 1,
          workspaces: 1,
        },
        agents: [
          {
            id: agentId,
            name: 'agent-dependent',
            display_name: 'Agent Dependent',
            runtime: 'codex',
          },
        ],
        can_cascade_agents: false,
      });
      expect(repo.get(created.host_id)).not.toBeNull();
      expect(
        new HostTokenService(t.ctx.db).verifyHostToken(created.connect_token),
      ).toMatchObject({
        ok: true,
        hostId: created.host_id,
      });
    });

    it('returns a cascadable dependency block for agent-only computers', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      const repo = new HostRepo(t.ctx.db);
      repo.markActivated(created.host_id, 1_700_000_000_000);
      repo.markFinalized(created.host_id, 1_700_000_000_100);
      const agentId = insertTestAgent(t, {
        name: 'agent-only-dependent',
        displayName: 'Agent Only Dependent',
        runtime: 'codex',
        hostId: created.host_id,
      });
      const agent = new AgentRepo(t.ctx.db).get(agentId);
      expect(agent).not.toBeNull();
      new WorkspaceRepo(t.ctx.db).insertAgentHome({
        agent: agent!,
        workspacePath: `/tmp/${agentId}`,
      });

      const res = await h.del(apiPaths.hostCancelPending(created.host_id));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'computer has dependent resources',
        error_code: 'has_dependents',
        dependents: {
          agents: 1,
          workspaces: 0,
        },
        agents: [
          {
            id: agentId,
            name: 'agent-only-dependent',
            display_name: 'Agent Only Dependent',
            runtime: 'codex',
          },
        ],
        can_cascade_agents: true,
      });
      expect(repo.get(created.host_id)).not.toBeNull();
    });

    it('returns a transient pending-agent block before offering agent cascade', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      const repo = new HostRepo(t.ctx.db);
      repo.markActivated(created.host_id, 1_700_000_000_000);
      repo.markFinalized(created.host_id, 1_700_000_000_100);
      const agentId = insertTestAgent(t, {
        name: 'pending-agent-dependent',
        displayName: 'Pending Agent Dependent',
        runtime: 'codex',
        hostId: created.host_id,
        materializationStatus: 'pending_materialization',
      });

      const res = await h.del(apiPaths.hostCancelPending(created.host_id), {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cascade_agents: true }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          'computer has agents whose creation is still in progress; try again after creation finishes',
        error_code: 'has_pending_agents',
        pending_agents: 1,
      });
      expect(repo.get(created.host_id)).not.toBeNull();
      expect(new AgentRepo(t.ctx.db).get(agentId)).not.toBeNull();
      expect(t.fakeHostWs!.calls).toHaveLength(0);
    });

    it('deletes an agent-only computer when cascade_agents is confirmed', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      const repo = new HostRepo(t.ctx.db);
      repo.markActivated(created.host_id, 1_700_000_000_000);
      repo.markFinalized(created.host_id, 1_700_000_000_100);
      const agentId = insertTestAgent(t, {
        name: 'agent-cascade-dependent',
        displayName: 'Agent Cascade Dependent',
        runtime: 'codex',
        hostId: created.host_id,
      });
      const agent = new AgentRepo(t.ctx.db).get(agentId);
      expect(agent).not.toBeNull();
      const workspaces = new WorkspaceRepo(t.ctx.db);
      const home = workspaces.insertAgentHome({
        agent: agent!,
        workspacePath: `/tmp/${agentId}`,
      });

      const res = await h.del(apiPaths.hostCancelPending(created.host_id), {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cascade_agents: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        host_id: created.host_id,
        deleted: true,
      });
      expect(repo.get(created.host_id)).toBeNull();
      expect(new AgentRepo(t.ctx.db).get(agentId)).toBeNull();
      expect(workspaces.get(home.id)).toBeNull();
      expect(
        t.fakeHostWs!.calls.filter(call => call.kind === 'agent_files_purge'),
      ).toEqual([
        {
          hostId: created.host_id,
          kind: 'agent_files_purge',
          params: {
            agent_id: agentId,
            scope: 'all',
            workspace_ids: [],
          },
        },
      ]);
    });

    it('deletes an agent-only computer while offline by skipping host-local purge', async () => {
      t = buildTestApp();
      t.fakeHostWs!.connectionIdForHostOverride = () => null;
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      const repo = new HostRepo(t.ctx.db);
      repo.markActivated(created.host_id, 1_700_000_000_000);
      repo.markFinalized(created.host_id, 1_700_000_000_100);
      const agentId = insertTestAgent(t, {
        name: 'offline-agent-cascade-dependent',
        displayName: 'Offline Agent Cascade Dependent',
        runtime: 'codex',
        hostId: created.host_id,
      });
      const agent = new AgentRepo(t.ctx.db).get(agentId);
      expect(agent).not.toBeNull();
      const workspaces = new WorkspaceRepo(t.ctx.db);
      const home = workspaces.insertAgentHome({
        agent: agent!,
        workspacePath: `/tmp/${agentId}`,
      });

      const res = await h.del(apiPaths.hostCancelPending(created.host_id), {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cascade_agents: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        host_id: created.host_id,
        deleted: true,
      });
      expect(repo.get(created.host_id)).toBeNull();
      expect(new AgentRepo(t.ctx.db).get(agentId)).toBeNull();
      expect(workspaces.get(home.id)).toBeNull();
      expect(
        t.fakeHostWs!.calls.some(call => call.kind === 'agent_files_purge'),
      ).toBe(false);
    });

    it('row-deletes failed agents during computer cascade without host-local purge', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      const repo = new HostRepo(t.ctx.db);
      repo.markActivated(created.host_id, 1_700_000_000_000);
      repo.markFinalized(created.host_id, 1_700_000_000_100);
      const agentId = insertTestAgent(t, {
        name: 'failed-agent-cascade-dependent',
        displayName: 'Failed Agent Cascade Dependent',
        runtime: 'codex',
        hostId: created.host_id,
        materializationStatus: 'failed',
      });

      const res = await h.del(apiPaths.hostCancelPending(created.host_id), {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cascade_agents: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        host_id: created.host_id,
        deleted: true,
      });
      expect(repo.get(created.host_id)).toBeNull();
      expect(new AgentRepo(t.ctx.db).get(agentId)).toBeNull();
      expect(
        t.fakeHostWs!.calls.some(call => call.kind === 'agent_files_purge'),
      ).toBe(false);
    });

    it('does not let cascade_agents bypass regular workspace dependents', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      const repo = new HostRepo(t.ctx.db);
      repo.markActivated(created.host_id, 1_700_000_000_000);
      repo.markFinalized(created.host_id, 1_700_000_000_100);
      const agentId = insertTestAgent(t, {
        name: 'agent-with-workspace-dependent',
        displayName: 'Agent With Workspace Dependent',
        runtime: 'codex',
        hostId: created.host_id,
      });
      new WorkspaceRepo(t.ctx.db).insert({
        name: 'Dependent Workspace',
        description: null,
        workspacePath: '/tmp/dependent-workspace',
        workspaceHostId: created.host_id,
      });

      const res = await h.del(apiPaths.hostCancelPending(created.host_id), {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cascade_agents: true }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'computer has dependent resources',
        error_code: 'has_dependents',
        dependents: {
          agents: 1,
          workspaces: 1,
        },
        agents: [
          {
            id: agentId,
            name: 'agent-with-workspace-dependent',
            display_name: 'Agent With Workspace Dependent',
            runtime: 'codex',
          },
        ],
        can_cascade_agents: false,
      });
      expect(repo.get(created.host_id)).not.toBeNull();
    });

    it('hard-deletes a revoked empty user-managed row rather than exposing a second user-facing remove verb', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      const repo = new HostRepo(t.ctx.db);
      repo.revoke(created.host_id);

      const res = await h.del(apiPaths.hostCancelPending(created.host_id));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        host_id: created.host_id,
        deleted: true,
      });
      expect(repo.get(created.host_id)).toBeNull();
    });

    it('rejects delete for non-user-managed rows', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const systemPending = new HostRepo(t.ctx.db).create('system-pending', 'remote', {
        userId: t.viewerUserId,
        activatedAt: null,
        provisioningSource: 'system',
      });

      const res = await h.del(apiPaths.hostCancelPending(systemPending.id));

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error_code: 'provisioning_source_not_supported',
      });
      expect(new HostRepo(t.ctx.db).get(systemPending.id)).not.toBeNull();

      const appManaged = await h.json<any>(
        h.post(apiPaths.hostClaimOrCreate, {
          installation_id: '60000000-1111-4111-8111-111111111111',
        }),
      );
      const appManagedRes = await h.del(apiPaths.hostCancelPending(appManaged.host_id));
      expect(appManagedRes.status).toBe(409);
      expect(await appManagedRes.json()).toMatchObject({
        error_code: 'provisioning_source_not_supported',
      });
      expect(new HostRepo(t.ctx.db).get(appManaged.host_id)).not.toBeNull();
    });
  });

  // ── GET /api/hosts viewer filter (Stage B.4) ─────────────────
  describe('GET /api/hosts viewer filter', () => {
    it('returns only hosts owned by the session bearer (Alice cannot see Bob\'s host)', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: ['alice', 'bob'] });
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;

      const res = await sessionHttp(t, aliceToken).get(apiPaths.hosts);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hosts: any[] };
      // Every returned row must be owned by Alice; Bob's row is invisible.
      expect(body.hosts.length).toBeGreaterThanOrEqual(1);
      const aliceHostIds = new Set(
        t.ctx.db
          .prepare<[], { id: string }>(`SELECT id FROM hosts WHERE user_id = 'alice'`)
          .all()
          .map(r => r.id),
      );
      for (const h of body.hosts) {
        expect(aliceHostIds.has(h.id)).toBe(true);
      }
      const bobHostIds = new Set(
        t.ctx.db
          .prepare<[], { id: string }>(`SELECT id FROM hosts WHERE user_id = 'bob'`)
          .all()
          .map(r => r.id),
      );
      for (const h of body.hosts) {
        expect(bobHostIds.has(h.id)).toBe(false);
      }
    });

    it('rejects retired server-config bearer (no cross-user enumeration)', async () => {
      t = buildTestApp();
      const res = await legacyServerAuthHttp(t).get(apiPaths.hosts);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    });

    it('includes both active and revoked rows (audit history) for the owner', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: ['alice'] });
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const aliceHost = new HostRepo(t.ctx.db).getOwnedLocalForUser('alice');
      expect(aliceHost).not.toBeNull();
      // Mint a second active row, revoke the first.
      new HostRepo(t.ctx.db).create('local-extra', 'local', {
        userId: 'alice',
        installationId: 'install-alice-extra',
      });
      new HostRepo(t.ctx.db).revoke(aliceHost!.id);

      const body = (await sessionHttp(t, aliceToken).json<{ hosts: any[] }>(
        sessionHttp(t, aliceToken).get(apiPaths.hosts),
      ));
      const ids = body.hosts.map(h => h.id);
      expect(ids).toContain(aliceHost!.id);
      const revokedRow = body.hosts.find(h => h.id === aliceHost!.id);
      expect(revokedRow).toMatchObject({ revoked_at: expect.any(Number) });
    });
  });

  // ── POST /api/hosts/:id/revoke (Stage B.4) ───────────────────
  describe('POST /api/hosts/:id/revoke', () => {
    it('soft-deletes host + sweeps active credentials in one transaction; agents/workspaces unchanged', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const claimed = await h.json<any>(
        h.post(apiPaths.hostClaimOrCreate, {
          installation_id: '50000001-1111-4111-8111-111111111111',
        }),
      );
      // Snapshot agent/workspace counts to prove no cascade-delete.
      const agentCountBefore = t.ctx.db
        .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM agents`)
        .get()?.c ?? 0;
      const workspaceCountBefore = t.ctx.db
        .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM workspaces`)
        .get()?.c ?? 0;
      const credCountBefore = t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM host_credentials
            WHERE host_id = ? AND revoked_at IS NULL`,
        )
        .get(claimed.host_id)?.c ?? 0;
      expect(credCountBefore).toBe(1);

      const res = await h.post(apiPaths.hostRevoke(claimed.host_id));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { host: any };
      expect(body.host).toMatchObject({
        id: claimed.host_id,
        revoked_at: expect.any(Number),
      });

      const credCountAfter = t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM host_credentials
            WHERE host_id = ? AND revoked_at IS NULL`,
        )
        .get(claimed.host_id)?.c ?? 0;
      expect(credCountAfter).toBe(0);
      expect(
        t.ctx.db
          .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM agents`)
          .get()?.c ?? 0,
      ).toBe(agentCountBefore);
      expect(
        t.ctx.db
          .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM workspaces`)
          .get()?.c ?? 0,
      ).toBe(workspaceCountBefore);
    });

    it('rejects user-managed computers because Delete/Rotate are the user-facing lifecycle actions', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));

      const res = await h.post(apiPaths.hostRevoke(created.host_id));

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error_code: 'provisioning_source_not_supported',
      });
      expect(new HostRepo(t.ctx.db).get(created.host_id)).toMatchObject({
        revoked_at: null,
      });
      expect(
        new HostTokenService(t.ctx.db).verifyHostToken(created.connect_token),
      ).toMatchObject({
        ok: true,
        hostId: created.host_id,
      });
    });

    it('is idempotent and still sweeps a half-failed credential row', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const claimed = await h.json<any>(
        h.post(apiPaths.hostClaimOrCreate, {
          installation_id: '50000002-1111-4111-8111-111111111111',
        }),
      );
      // Manufacture a half-failed state: host already revoked, but
      // a stray credential is still active. Stage B.4 contract: a
      // re-revoke must reconcile this.
      const beforeRevokedAt = Date.now() - 60_000;
      t.ctx.db
        .prepare(`UPDATE hosts SET revoked_at = ? WHERE id = ?`)
        .run(beforeRevokedAt, claimed.host_id);
      t.ctx.db
        .prepare(`UPDATE host_credentials SET revoked_at = NULL WHERE host_id = ?`)
        .run(claimed.host_id);

      const res = await h.post(apiPaths.hostRevoke(claimed.host_id));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { host: any };
      // Tombstone timestamp must NOT advance on re-revoke.
      expect(body.host.revoked_at).toBe(beforeRevokedAt);
      expect(
        t.ctx.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM host_credentials
              WHERE host_id = ? AND revoked_at IS NULL`,
          )
          .get(claimed.host_id)?.c ?? 0,
      ).toBe(0);
    });

    it('returns 404 (not 403) for cross-user revoke attempts (no enumeration)', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: ['alice', 'bob'] });
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const bobHost = new HostRepo(t.ctx.db).getOwnedLocalForUser('bob');
      expect(bobHost).not.toBeNull();
      const res = await sessionHttp(t, aliceToken).post(apiPaths.hostRevoke(bobHost!.id));
      expect(res.status).toBe(404);
      // Bob's host is still active.
      expect(new HostRepo(t.ctx.db).get(bobHost!.id)).toMatchObject({ revoked_at: null });
    });

    it('returns 404 for missing host id', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const res = await sessionHttp(t, userToken).post(apiPaths.hostRevoke('nonexistent'));
      expect(res.status).toBe(404);
    });

    it('rejects retired server-config bearer', async () => {
      t = buildTestApp();
      const res = await legacyServerAuthHttp(t).post(apiPaths.hostRevoke('whatever'));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    });

    /**
     * D4.c C2 — pre-D4.c the standalone branch short-circuited
     * /api/hosts/:id/revoke to `host_runtime_disabled`. C2 lifts the
     * guard AND adds a best-effort `wsController.disconnectHost(id)`
     * call after the revoke transaction commits, so the kicked
     * daemon learns its credential is gone via WS close 1008
     * (`host_revoked`) instead of waiting for the next heartbeat /
     * attachment timeout.
     *
     * R4 boundary: the disconnect is a transport-layer hint, not a
     * server↔daemon protocol mechanism. The credential is already
     * revoked at the DB level; if the disconnect throws or the host
     * isn't currently attached, the revoke still succeeds (best-
     * effort, log-and-swallow) — backend correctness still rests on
     * `verifyHostToken` rejecting the credential on the next attach.
     */
    it('standalone revoke succeeds and asks the WS controller to kick the live attachment', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({
        deploymentMode: 'standalone',
        hostWsController: () => controller,
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId)!;
      controller = new FakeHostWsController(async () => ({}));

      const res = await sessionHttp(t, userToken).post(apiPaths.hostRevoke(host.id));

      expect(res.status).toBe(200);
      const body = (await res.json()) as { host: any };
      expect(body.host).toMatchObject({
        id: host.id,
        revoked_at: expect.any(Number),
      });
      // DB-level revoke did happen (the authoritative bit).
      expect(new HostRepo(t.ctx.db).get(host.id)).toMatchObject({
        revoked_at: expect.any(Number),
      });
      // Best-effort kick: controller saw exactly this host id.
      expect(controller!.disconnects).toEqual([host.id]);
    });

    it('standalone revoke still succeeds when the WS controller throws (best-effort)', async () => {
      class ThrowingController extends FakeHostWsController {
        constructor() {
          super(async () => ({}));
        }
        override disconnectHost(hostId: string): boolean {
          this.disconnects.push(hostId);
          throw new Error('synthetic disconnect failure');
        }
      }
      let controller: ThrowingController | null = null;
      t = buildTestApp({
        deploymentMode: 'standalone',
        hostWsController: () => controller,
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId)!;
      controller = new ThrowingController();

      const res = await sessionHttp(t, userToken).post(apiPaths.hostRevoke(host.id));

      expect(res.status).toBe(200);
      // Even though the controller threw, the revoke is committed.
      expect(new HostRepo(t.ctx.db).get(host.id)).toMatchObject({
        revoked_at: expect.any(Number),
      });
      // And the controller was indeed asked.
      expect(controller!.disconnects).toEqual([host.id]);
    });

    /**
     * D4.c C2 round-1 fixup (Cindy nit) — pin that the standalone
     * lift didn't smuggle a path past the owner check. Pre-D4.c the
     * standalone guard would have short-circuited at
     * `host_runtime_disabled` BEFORE the cross-user check; if a
     * future refactor accidentally swaps the order, the cross-user
     * 404 test under default (embedded) mode wouldn't catch it.
     * This test pins both: standalone returns 404 (not 403, not
     * `host_runtime_disabled`) for cross-user revoke, AND the WS
     * controller's `disconnectHost` is never called.
     */
    it('standalone — cross-user revoke still 404 + does NOT call disconnectHost', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({
        deploymentMode: 'standalone',
        ownedLocalHostUserIds: ['alice', 'bob'],
        hostWsController: () => controller,
      });
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const bobHost = new HostRepo(t.ctx.db).getOwnedLocalForUser('bob');
      expect(bobHost).not.toBeNull();
      controller = new FakeHostWsController(async () => ({}));

      const res = await sessionHttp(t, aliceToken).post(apiPaths.hostRevoke(bobHost!.id));

      expect(res.status).toBe(404);
      // Bob's host stays active.
      expect(new HostRepo(t.ctx.db).get(bobHost!.id)).toMatchObject({
        revoked_at: null,
      });
      // The kick is never invoked — owner check rejects before the
      // best-effort disconnect runs.
      expect(controller!.disconnects).toEqual([]);
    });

    // P9 (#task:978) pre-refactor characterization: the host-row revoke and
    // the credential sweep are a SINGLE better-sqlite3 transaction. If the
    // sweep (second write) fails, the revoke (first write) must roll back too —
    // no half state (host tombstoned but credentials still active). Forced via
    // a TEMP abort trigger on the host_credentials UPDATE. Pins the tx boundary
    // before it moves into the use case (it must stay a single tx there).
    it('rolls back the host-row revoke atomically when the credential sweep fails (single tx)', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const claimed = await h.json<any>(
        h.post(apiPaths.hostClaimOrCreate, {
          installation_id: '50000009-1111-4111-8111-111111111111',
        }),
      );
      // The host has exactly one active credential from the claim, so the
      // sweep's UPDATE touches a row and the BEFORE-UPDATE trigger fires.
      t.ctx.db.exec(
        `CREATE TEMP TRIGGER force_fail_cred_sweep
           BEFORE UPDATE ON host_credentials
           BEGIN SELECT RAISE(ABORT, 'forced sweep failure'); END;`,
      );

      const res = await h.post(apiPaths.hostRevoke(claimed.host_id));
      // Uncaught SqliteError (RAISE ABORT) → Hono default 500 (no app.onError).
      expect(res.status).toBe(500);

      // The first write rolled back with the second: host NOT revoked, and the
      // credential is still active (sweep rolled back).
      expect(new HostRepo(t.ctx.db).get(claimed.host_id)).toMatchObject({
        revoked_at: null,
      });
      const activeCreds =
        t.ctx.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM host_credentials
              WHERE host_id = ? AND revoked_at IS NULL`,
          )
          .get(claimed.host_id)?.c ?? 0;
      expect(activeCreds).toBe(1);
    });

    // P9 (#task:978) pre-refactor characterization: the 200 body is exactly
    // `{ host: <full HostDto> }` — every DTO field, not just id/revoked_at —
    // so the use-case extraction + route mapper must preserve the whole
    // projection verbatim.
    it('returns the full revoked HostDto verbatim in the 200 body', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const claimed = await h.json<any>(
        h.post(apiPaths.hostClaimOrCreate, {
          installation_id: '50000010-1111-4111-8111-111111111111',
        }),
      );

      const res = await h.post(apiPaths.hostRevoke(claimed.host_id));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { host: unknown };

      // The body must be the full toDto of the revoked row — assert it equals
      // the repo's own projection field-by-field (envelope + every field).
      const repo = new HostRepo(t.ctx.db);
      const updated = repo.get(claimed.host_id);
      expect(updated).not.toBeNull();
      const expectedDto = repo.toDto(updated!);
      expect(body).toEqual({ host: expectedDto });
      // Sanity: the projected row is the revoked tombstone.
      expect(typeof expectedDto.revoked_at).toBe('number');
    });
  });

  // ── POST /api/hosts/:id/rotate-token (Stage B.4) ─────────────
  describe('POST /api/hosts/:id/rotate-token', () => {
    it('rotates the active credential with a 60s grace and mints a new long_lived token', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const claimed = await h.json<any>(
        h.post(apiPaths.hostClaimOrCreate, {
          installation_id: '50000003-1111-4111-8111-111111111111',
        }),
      );
      const oldToken = claimed.host_token as string;
      expect(oldToken).toBeTruthy();

      const before = Date.now();
      const res = await h.post(apiPaths.hostRotateToken(claimed.host_id));
      const after = Date.now();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { host_id: string; host_token: string; host: any };
      expect(body.host_id).toBe(claimed.host_id);
      expect(body.host_token).toEqual(expect.any(String));
      expect(body.host_token).not.toBe(oldToken);
      expect(body.host).toMatchObject({ id: claimed.host_id, revoked_at: null });

      // 2 rows: prior cred has a scheduled grace revoke in [before+60s, after+60s]
      // and records the rotation handoff in consumed_at; new cred is active.
      const rows = t.ctx.db
        .prepare<
          [string],
          {
            token_hash: string;
            expires_at: number | null;
            consumed_at: number | null;
            revoked_at: number | null;
          }
        >(
          `SELECT token_hash, expires_at, consumed_at, revoked_at
             FROM host_credentials
            WHERE host_id = ?
            ORDER BY rowid ASC`,
        )
        .all(claimed.host_id);
      expect(rows).toHaveLength(2);
      const oldRow = rows.find(r => r.token_hash === hashHostToken(oldToken));
      const newRow = rows.find(r => r.token_hash === hashHostToken(body.host_token));
      expect(oldRow).toBeDefined();
      expect(newRow).toBeDefined();
      expect(oldRow!.expires_at).toBeNull();
      expect(oldRow!.consumed_at).toBeGreaterThanOrEqual(before);
      expect(oldRow!.consumed_at).toBeLessThanOrEqual(after);
      expect(oldRow!.revoked_at).toBeGreaterThanOrEqual(before + 60_000);
      expect(oldRow!.revoked_at).toBeLessThanOrEqual(after + 60_000);
      expect(newRow!.expires_at).toBeNull();
      expect(newRow!.consumed_at).toBeNull();
      expect(newRow!.revoked_at).toBeNull();

      // Within the grace window the old token still verifies.
      const verifier = new HostTokenService(t.ctx.db);
      expect(verifier.verifyHostToken(oldToken)).toMatchObject({ ok: true });
      // Past the grace window, it's expired.
      expect(
        verifier.verifyHostToken(oldToken, { now: oldRow!.revoked_at! + 1 }),
      ).toMatchObject({ ok: false, code: 'credential_expired' });
      // New token verifies indefinitely.
      expect(verifier.verifyHostToken(body.host_token)).toMatchObject({ ok: true });
    });

    it('standalone rotates over host websocket without returning cleartext token', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({
        deploymentMode: 'standalone',
        hostWsController: () => controller,
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      expect(host).not.toBeNull();
      const tokens = new HostTokenService(t.ctx.db);
      const old = tokens.issueHostToken({ hostId: host!.id });
      controller = new FakeHostWsController(async call => {
        expect(call).toMatchObject({
          hostId: host!.id,
          kind: 'rotate_token',
        });
        expect(call.params.host_token).not.toBe(old.hostToken);
        return {
          rotated: true,
          host_id: host!.id,
          config_refreshed_at: 1_700_000_000_123,
        };
      });

      const res = await sessionHttp(t, userToken).post(
        apiPaths.hostRotateToken(host!.id),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        host_id: host!.id,
        status: 'rotated',
      });
      expect(body).not.toHaveProperty('host_token');
      expect(controller!.calls).toHaveLength(1);
      expect(tokens.verifyHostToken(old.hostToken)).toMatchObject({
        ok: true,
        hostId: host!.id,
      });
      const oldRow = t.ctx.db
        .prepare<[string], { consumed_at: number | null; revoked_at: number | null }>(
          `SELECT consumed_at, revoked_at FROM host_credentials WHERE id = ?`,
        )
        .get(old.credential.id);
      expect(oldRow?.consumed_at).toEqual(expect.any(Number));
      expect(oldRow?.revoked_at).toEqual(expect.any(Number));
    });

    it('standalone leaves credentials unchanged when daemon rejects rotate', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({
        deploymentMode: 'standalone',
        hostWsController: () => controller,
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId)!;
      const tokens = new HostTokenService(t.ctx.db);
      const old = tokens.issueHostToken({ hostId: host.id });
      const beforeRows = t.ctx.db
        .prepare<[string], Record<string, unknown>>(
          `SELECT id, token_hash, consumed_at, revoked_at
             FROM host_credentials
            WHERE host_id = ?
            ORDER BY rowid ASC`,
        )
        .all(host.id);
      controller = new FakeHostWsController(async () => ({
        rotated: false,
        reason: 'write_failed',
        message: 'EACCES',
      }));

      const res = await sessionHttp(t, userToken).post(
        apiPaths.hostRotateToken(host.id),
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({
        error_code: 'host_token_rotation_failed',
        reason: 'write_failed',
      });
      expect(
        t.ctx.db
          .prepare<[string], Record<string, unknown>>(
            `SELECT id, token_hash, consumed_at, revoked_at
               FROM host_credentials
              WHERE host_id = ?
              ORDER BY rowid ASC`,
          )
          .all(host.id),
      ).toEqual(beforeRows);
      expect(tokens.verifyHostToken(old.hostToken)).toMatchObject({ ok: true });
    });

    it('returns 404 for cross-user rotate (no enumeration)', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: ['alice', 'bob'] });
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const bobHost = new HostRepo(t.ctx.db).getOwnedLocalForUser('bob');
      expect(bobHost).not.toBeNull();
      const res = await sessionHttp(t, aliceToken).post(
        apiPaths.hostRotateToken(bobHost!.id),
      );
      expect(res.status).toBe(404);
      // No new credential row was minted on Bob's host.
      expect(
        t.ctx.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM host_credentials WHERE host_id = ?`,
          )
          .get(bobHost!.id)?.c ?? 0,
      ).toBeLessThanOrEqual(1);
    });

    it('returns 409 host_revoked on a soft-deleted host', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const claimed = await h.json<any>(
        h.post(apiPaths.hostClaimOrCreate, {
          installation_id: '50000004-1111-4111-8111-111111111111',
        }),
      );
      new HostRepo(t.ctx.db).revoke(claimed.host_id);
      const res = await h.post(apiPaths.hostRotateToken(claimed.host_id));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error_code: 'host_revoked' });
    });

    it('returns 409 kind_not_supported for non-local hosts', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      // V1 surface only allows rotating the user's local host. Inject
      // a remote-kind row owned by the user to exercise the guard
      // (production has no UI to provision remote hosts yet).
      const remote = new HostRepo(t.ctx.db).create('remote-test', 'remote', {
        userId: t.viewerUserId,
        installationId: 'install-remote',
      });
      const res = await sessionHttp(t, userToken).post(apiPaths.hostRotateToken(remote.id));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error_code: 'kind_not_supported' });
    });

    it('user-managed connect-token rotate returns cleartext once, invalidates old token immediately, and disconnects live WS', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({
        hostWsController: () => controller,
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      const oldToken = created.connect_token as string;
      controller = new FakeHostWsController(async () => {
        throw new Error('user-managed rotate must not dispatch rotate_token');
      });

      const res = await h.post(apiPaths.hostRotateConnectToken(created.host_id));

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toMatchObject({
        host_id: created.host_id,
        status: 'rotated',
        connect_token: expect.any(String),
        daemon_npm_spec: '@silverhand-ai/daemon@latest',
      });
      expect(body.advertised_origin_override).toBeUndefined();
      expect(body.daemon_command).toBeUndefined();
      expect(body.connect_token).not.toBe(oldToken);
      const rotatedCommand = assembleConnectCommand({
        daemonNpmSpec: body.daemon_npm_spec,
        serverUrl: 'https://silverhand.taobao.net',
        connectToken: body.connect_token,
      });
      expect(rotatedCommand).toContain(body.connect_token);
      expect(rotatedCommand).not.toContain(created.host_id);
      expect(controller!.calls).toEqual([]);
      expect(controller!.disconnects).toEqual([created.host_id]);
      expect(controller!.disconnectReasons).toEqual([
        { hostId: created.host_id, reason: HOST_WS_CLOSE_REASON_REVOKED },
      ]);

      const verifier = new HostTokenService(t.ctx.db);
      expect(verifier.verifyHostToken(oldToken)).toMatchObject({
        ok: false,
        code: 'credential_expired',
      });
      expect(verifier.verifyHostToken(body.connect_token)).toMatchObject({
        ok: true,
        hostId: created.host_id,
        userId: t.viewerUserId,
      });
    });

    it('user-managed connect-token rotate rejects app-managed hosts', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const claimed = await h.json<any>(
        h.post(apiPaths.hostClaimOrCreate, {
          installation_id: '50000005-1111-4111-8111-111111111111',
        }),
      );

      const res = await h.post(apiPaths.hostRotateConnectToken(claimed.host_id));

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error_code: 'provisioning_source_not_supported',
      });
    });

    it('user-managed disconnect drops live WS but leaves credentials and lifecycle unchanged', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({
        hostWsController: () => controller,
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      const connectToken = created.connect_token as string;
      const repo = new HostRepo(t.ctx.db);
      repo.markActivated(created.host_id, 1_700_000_000_000);
      repo.markFinalized(created.host_id, 1_700_000_000_100);
      const before = repo.get(created.host_id)!;
      controller = new FakeHostWsController(async () => {
        throw new Error('disconnect must not dispatch a host command');
      });

      const res = await h.post(apiPaths.hostDisconnect(created.host_id));

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toMatchObject({
        host_id: created.host_id,
        disconnected: true,
        host: {
          id: created.host_id,
          status: 'active',
          revoked_at: null,
          activated_at: before.activated_at,
          finalized_at: before.finalized_at,
        },
      });
      expect(controller!.calls).toEqual([]);
      expect(controller!.disconnects).toEqual([created.host_id]);
      expect(controller!.disconnectReasons).toEqual([
        { hostId: created.host_id, reason: HOST_WS_CLOSE_REASON_DISCONNECTED },
      ]);

      const after = repo.get(created.host_id)!;
      expect(after.revoked_at).toBeNull();
      expect(after.activated_at).toBe(before.activated_at);
      expect(after.finalized_at).toBe(before.finalized_at);
      expect(new HostTokenService(t.ctx.db).verifyHostToken(connectToken)).toMatchObject({
        ok: true,
        hostId: created.host_id,
        userId: t.viewerUserId,
      });
    });

    it('user-managed disconnect is a benign no-op when no live WS exists', async () => {
      class OfflineController extends FakeHostWsController {
        constructor() {
          super(async () => ({}));
        }
        override disconnectHost(
          hostId: string,
          reason = HOST_WS_CLOSE_REASON_REVOKED,
        ): boolean {
          this.disconnects.push(hostId);
          this.disconnectReasons.push({ hostId, reason });
          return false;
        }
      }
      let controller: OfflineController | null = null;
      t = buildTestApp({
        hostWsController: () => controller,
      });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      const repo = new HostRepo(t.ctx.db);
      repo.markActivated(created.host_id, 1_700_000_000_000);
      repo.markFinalized(created.host_id, 1_700_000_000_100);
      controller = new OfflineController();

      const res = await h.post(apiPaths.hostDisconnect(created.host_id));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        host_id: created.host_id,
        disconnected: false,
        host: {
          id: created.host_id,
          status: 'active',
        },
      });
      expect(controller!.disconnects).toEqual([created.host_id]);
    });

    it('user-managed disconnect rejects drafts, app-managed hosts, and cross-user hosts', async () => {
      t = buildTestApp({ ownedLocalHostUserIds: [] });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const draft = await h.json<any>(h.post(apiPaths.hosts, {}));

      const draftRes = await h.post(apiPaths.hostDisconnect(draft.host_id));
      expect(draftRes.status).toBe(409);
      expect(await draftRes.json()).toMatchObject({
        error_code: 'host_not_active',
      });

      const claimed = await h.json<any>(
        h.post(apiPaths.hostClaimOrCreate, {
          installation_id: '50000005-1111-4111-8111-111111111112',
        }),
      );
      const appManagedRes = await h.post(apiPaths.hostDisconnect(claimed.host_id));
      expect(appManagedRes.status).toBe(409);
      expect(await appManagedRes.json()).toMatchObject({
        error_code: 'provisioning_source_not_supported',
      });

      const bobToken = t.ctx.authSessions.issueSession({ userId: 'bob' }).userToken;
      const bobHost = new HostRepo(t.ctx.db).create('bob-daemon', 'remote', {
        userId: 'bob',
        provisioningSource: 'user_invite',
        activatedAt: 1_700_000_000_000,
        finalizedAt: 1_700_000_000_100,
      });
      const crossUserRes = await sessionHttp(t, userToken).post(
        apiPaths.hostDisconnect(bobHost.id),
      );
      expect(crossUserRes.status).toBe(404);
      expect(await crossUserRes.json()).toMatchObject({
        error_code: 'host_not_found',
      });

      const bobRes = await sessionHttp(t, bobToken).post(apiPaths.hostDisconnect(bobHost.id));
      expect(bobRes.status).toBe(200);
    });

    it('rejects retired server-config bearer', async () => {
      t = buildTestApp();
      const res = await legacyServerAuthHttp(t).post(apiPaths.hostRotateToken('whatever'));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    });
  });

  // ─── v36 (#task:808) — PATCH /api/hosts/:id rename ──────────────────
  describe('PATCH /api/hosts/:id', () => {
    it('finalizes an attached user-managed draft when the modal submits a name', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      new HostRepo(t.ctx.db).markActivated(created.host_id, 1_700_000_000_000);

      const res = await h.patch(apiPaths.host(created.host_id), {
        display_label: 'Build Mac',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.host).toMatchObject({
        id: created.host_id,
        display_label: 'Build Mac',
        status: 'active',
        placeable: true,
        activated_at: 1_700_000_000_000,
        finalized_at: expect.any(Number),
      });
      const list = await h.json<{ hosts: any[] }>(h.get(apiPaths.hosts));
      expect(list.hosts.map(host => host.id)).toContain(created.host_id);
    });

    it('rejects finalizing a user-managed draft before daemon attach', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));

      const res = await h.patch(apiPaths.host(created.host_id), {
        display_label: 'Build Mac',
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error_code: 'host_pending_attach',
      });
      expect(new HostRepo(t.ctx.db).get(created.host_id)?.finalized_at).toBeNull();
    });

    it('requires a name when finalizing a user-managed draft', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      new HostRepo(t.ctx.db).markActivated(created.host_id, 1_700_000_000_000);

      const res = await h.patch(apiPaths.host(created.host_id), {
        display_label: '   ',
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error_code: 'display_label_required',
      });
      expect(new HostRepo(t.ctx.db).get(created.host_id)?.finalized_at).toBeNull();
    });

    it('renames a host the caller owns and exposes display_label on the DTO', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      expect(host).not.toBeNull();

      const res = await sessionHttp(t, userToken).patch(
        apiPaths.host(host!.id),
        { display_label: 'Studio Mac' },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { host: { id: string; name: string; display_label: string | null } };
      expect(body.host.id).toBe(host!.id);
      expect(body.host.display_label).toBe('Studio Mac');
      // `name` stays stable — never the rename target.
      expect(body.host.name).toBe(host!.name);
    });

    it('clears the label with null', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      const h = sessionHttp(t, userToken);
      await h.patch(apiPaths.host(host!.id), { display_label: 'temp' });
      const res = await h.patch(apiPaths.host(host!.id), { display_label: null });
      expect(res.status).toBe(200);
      const body = await res.json() as { host: { display_label: string | null } };
      expect(body.host.display_label).toBeNull();
    });

    it('auto-truncates over-long labels via the repo (single round-trip UX)', async () => {
      // Schema allows up to 256; the repo trims+slices to 64. A 200-char
      // input should land as the first 64 chars, NOT as a 400.
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      const long = 'A'.repeat(200);
      const res = await sessionHttp(t, userToken).patch(
        apiPaths.host(host!.id),
        { display_label: long },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { host: { display_label: string | null } };
      expect(body.host.display_label).toBe('A'.repeat(64));
    });

    it('rejects display_label past the hard cap (256 chars)', async () => {
      // Anything well past the UI's plausible cap is rejected — protects
      // the column from a buggy renderer / direct curl spamming KB-class
      // strings (Cindy slice-1 nit #2 boundary).
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      const tooBig = 'A'.repeat(257);
      const res = await sessionHttp(t, userToken).patch(
        apiPaths.host(host!.id),
        { display_label: tooBig },
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 for cross-user host (no enumeration)', async () => {
      // Default fixture provisions a local host for every TEST_FIXTURE_USER_IDS
      // entry — `alice` and `bob` each own one. Caller=alice, target=bob's.
      t = buildTestApp();
      const bobHost = new HostRepo(t.ctx.db)
        .listOwnedActiveLocalForUser('bob')[0];
      expect(bobHost).toBeDefined();
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const res = await sessionHttp(t, aliceToken).patch(
        apiPaths.host(bobHost!.id),
        { display_label: 'ha' },
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error_code: 'host_not_found' });
    });

    it('returns 404 for missing id (no enumeration)', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const res = await sessionHttp(t, userToken).patch(
        apiPaths.host('nonexistent'),
        { display_label: 'x' },
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error_code: 'host_not_found' });
    });

    it('rejects rename on a revoked host with 409', async () => {
      t = buildTestApp();
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const repo = new HostRepo(t.ctx.db);
      const host = repo.getOwnedLocalForUser(t.viewerUserId);
      expect(repo.revoke(host!.id)).toBe(true);

      const res = await sessionHttp(t, userToken).patch(
        apiPaths.host(host!.id),
        { display_label: 'new' },
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error_code: 'host_revoked' });
    });
  });

  describe('GET/PUT /api/hosts/:id/proxy-config', () => {
    it('dispatches get through the host adapter for app-managed and user-managed computers', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({ hostWsController: () => controller });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const repo = new HostRepo(t.ctx.db);
      const localHost = repo.getOwnedLocalForUser(t.viewerUserId);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      repo.markActivated(created.host_id, 1_700_000_000_000);
      repo.markFinalized(created.host_id, 1_700_000_000_100);
      const calls: Array<{ hostId: string; kind: string; params: unknown }> = [];
      controller = new FakeHostWsController(async call => {
        calls.push(call);
        expect(call.kind).toBe('host_proxy_config_get');
        expect(call.params).toEqual({});
        return {
          config: {
            proxy_url: `http://proxy-for-${call.hostId}`,
            proxy_runtimes: ['codex'],
          },
        };
      });

      const localRes = await h.get(apiPaths.hostProxyConfig(localHost!.id));
      const remoteRes = await h.get(apiPaths.hostProxyConfig(created.host_id));

      expect(localRes.status).toBe(200);
      expect(remoteRes.status).toBe(200);
      expect(await localRes.json()).toEqual({
        config: {
          proxy_url: `http://proxy-for-${localHost!.id}`,
          proxy_runtimes: ['codex'],
        },
      });
      expect(await remoteRes.json()).toEqual({
        config: {
          proxy_url: `http://proxy-for-${created.host_id}`,
          proxy_runtimes: ['codex'],
        },
      });
      expect(calls.map(call => call.hostId)).toEqual([
        localHost!.id,
        created.host_id,
      ]);
    });

    it('dispatches set with the symmetric proxy config DTO and strips unknown fields', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({ hostWsController: () => controller });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const h = sessionHttp(t, userToken);
      const repo = new HostRepo(t.ctx.db);
      const created = await h.json<any>(h.post(apiPaths.hosts, {}));
      repo.markActivated(created.host_id, 1_700_000_000_000);
      repo.markFinalized(created.host_id, 1_700_000_000_100);
      controller = new FakeHostWsController(async call => {
        expect(call.hostId).toBe(created.host_id);
        expect(call.kind).toBe('host_proxy_config_set');
        expect(call.params).toEqual({
          proxy_url: 'http://user:pass@127.0.0.1:7890',
          proxy_runtimes: ['codex'],
        });
        return { config: call.params };
      });

      const res = await h.put(apiPaths.hostProxyConfig(created.host_id), {
        proxy_url: 'http://user:pass@127.0.0.1:7890',
        proxy_runtimes: ['codex'],
        ignored: true,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        config: {
          proxy_url: 'http://user:pass@127.0.0.1:7890',
          proxy_runtimes: ['codex'],
        },
      });
    });

    it('returns typed computer_offline when no daemon is attached', async () => {
      t = buildTestApp({ hostWsController: () => null });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const repo = new HostRepo(t.ctx.db);
      const host = repo.getOwnedLocalForUser(t.viewerUserId);

      const getRes = await sessionHttp(t, userToken).get(
        apiPaths.hostProxyConfig(host!.id),
      );
      const putRes = await sessionHttp(t, userToken).put(
        apiPaths.hostProxyConfig(host!.id),
        { proxy_url: null, proxy_runtimes: [] },
      );

      expect(getRes.status).toBe(503);
      expect(await getRes.json()).toMatchObject({
        error_code: HOST_PROXY_CONFIG_OFFLINE_ERROR_CODE,
      });
      expect(putRes.status).toBe(503);
      expect(await putRes.json()).toMatchObject({
        error_code: HOST_PROXY_CONFIG_OFFLINE_ERROR_CODE,
      });
    });

    it('rejects unfinalized drafts and cross-user hosts', async () => {
      t = buildTestApp();
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const bobToken = t.ctx.authSessions.issueSession({ userId: 'bob' }).userToken;
      const aliceHttp = sessionHttp(t, aliceToken);
      const created = await aliceHttp.json<any>(aliceHttp.post(apiPaths.hosts, {}));

      const draftRes = await aliceHttp.get(apiPaths.hostProxyConfig(created.host_id));
      const crossUserRes = await sessionHttp(t, bobToken).get(
        apiPaths.hostProxyConfig(created.host_id),
      );

      expect(draftRes.status).toBe(409);
      expect(await draftRes.json()).toMatchObject({
        error_code: 'host_not_active',
      });
      expect(crossUserRes.status).toBe(404);
      expect(await crossUserRes.json()).toMatchObject({
        error_code: 'host_not_found',
      });
    });
  });

  // ─── v36 (#task:808) — GET /api/hosts/:id/status snapshot ──────────
  describe('GET /api/hosts/:id/status', () => {
    it('returns `available` arm with snapshot + top-level agents when the daemon answers', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({ hostWsController: () => controller });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      expect(host).not.toBeNull();

      // Register an agent on this host so the registration list has at
      // least one row to enrich with `online`.
      const insertedAgentId = insertTestAgent(t, {
        hostId: host!.id,
        name: 'helper',
        displayName: 'Helper',
        runtime: 'claude',
      });

      controller = new FakeHostWsController(async call => {
        expect(call.kind).toBe('host_status');
        expect(call.params).toEqual({});
        return {
          os: 'macOS 14.5',
          os_arch: 'arm64',
          daemon_pid: 4242,
          daemon_version: '0.1.0',
          started_at: 1_700_000_000_000,
          uptime_ms: 60_000,
          active_agent_ids: [insertedAgentId],
        };
      });
      await seedHostStatus(t, host!.id);

      const res = await sessionHttp(t, userToken).get(
        apiPaths.hostStatus(host!.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      // uptime_ms derives from the seed base + elapsed-since-seed, so it
      // is >= the daemon-reported value rather than an exact echo.
      const uptime = (body as { snapshot: { uptime_ms: number } }).snapshot
        .uptime_ms;
      expect(uptime).toBeGreaterThanOrEqual(60_000);
      expect(uptime).toBeLessThan(70_000);
      expect(Number.isInteger(uptime)).toBe(true);
      expect(body).toMatchObject({
        host_id: host!.id,
        availability: 'available',
        snapshot: {
          os: 'macOS 14.5',
          os_arch: 'arm64',
          daemon_pid: 4242,
          daemon_version: '0.1.0',
          started_at: 1_700_000_000_000,
        },
        agents: [
          {
            agent_id: insertedAgentId,
            display_name: 'Helper',
            handle: '@helper',
            runtime: 'claude',
            avatar_url: null,
            online: 'online',
          },
        ],
      });
      // Registration moved OUT of snapshot (Cindy `Mtf5zZL-Y7PauIDi` P1):
      // snapshot carries ONLY dynamic daemon-derived fields now.
      expect(body.snapshot as Record<string, unknown>).not.toHaveProperty('agents');
      // Tagged-union strictness: `available` arm MUST NOT carry a `reason`.
      expect(body).not.toHaveProperty('reason');
    });

    it('marks unregistered active agent_ids as filler-noise (NOT injected into top-level agents[])', async () => {
      // The registration list is the source of truth. A daemon that
      // reports an active id NOT in `agents.host_id == hostId` does not
      // get a phantom row injected — ComputerPane shows registrations
      // only.
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({ hostWsController: () => controller });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      const agentId = insertTestAgent(t, {
        hostId: host!.id,
        name: 'real',
        displayName: 'Real Agent',
        runtime: 'claude',
      });

      controller = new FakeHostWsController(async () => ({
        os: 'macOS 14.5',
        daemon_pid: 1,
        daemon_version: '0.1.0',
        started_at: 1,
        uptime_ms: 1,
        active_agent_ids: [agentId, 'phantom-not-registered'],
      }));
      await seedHostStatus(t, host!.id);

      const res = await sessionHttp(t, userToken).get(
        apiPaths.hostStatus(host!.id),
      );
      const body = await res.json() as {
        availability: string;
        agents: Array<{ agent_id: string; online: string }>;
      };
      expect(body.availability).toBe('available');
      expect(body.agents.map(a => a.agent_id)).toEqual([agentId]);
      expect(body.agents[0]!.online).toBe('online');
    });

    it('returns `disconnected` arm with registration list (all offline) when daemon not attached', async () => {
      // Cindy `Mtf5zZL-Y7PauIDi` P1: registration view must survive daemon
      // disconnect. ComputerPane still shows which agents live on this
      // host even when the daemon is offline — they just can't be online.
      t = buildTestApp({ hostWsController: () => null });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      const agentA = insertTestAgent(t, {
        hostId: host!.id,
        name: 'a',
        displayName: 'A',
        runtime: 'claude',
      });
      const agentB = insertTestAgent(t, {
        hostId: host!.id,
        name: 'b',
        displayName: 'B',
        runtime: 'claude',
      });

      const res = await sessionHttp(t, userToken).get(
        apiPaths.hostStatus(host!.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        availability: string;
        agents: Array<{ agent_id: string; online: string; handle: string; avatar_url: string | null }>;
      } & Record<string, unknown>;
      expect(body).toMatchObject({
        host_id: host!.id,
        availability: 'disconnected',
      });
      // Registration survives daemon disconnect, all offline.
      expect(body.agents.map(a => a.agent_id).sort()).toEqual([agentA, agentB].sort());
      expect(body.agents.every(a => a.online === 'offline')).toBe(true);
      // `avatar_url` MUST be present on every offline-arm row too —
      // the field is canonical on the producer side regardless of
      // availability. Cindy `r96u1vc8awdjfnVT`: pin every arm so the
      // schema/route invariant doesn't drift on one arm only.
      expect(body.agents.every(a => 'avatar_url' in a && a.avatar_url === null)).toBe(true);
      // Tagged-union strictness: never leak a half-snapshot or a reason
      // onto a non-`available` arm (Cindy `nTB67NWSepk054UL` constraint).
      expect(body).not.toHaveProperty('snapshot');
      expect(body).not.toHaveProperty('reason');
    });

    it('returns `unreachable` (pending seed) with registration list when the seed failed — and the GET itself never dispatches (#task:1588 gate #4)', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({ hostWsController: () => controller });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      const agentId = insertTestAgent(t, {
        hostId: host!.id,
        name: 'reg',
        displayName: 'Reg',
        runtime: 'claude',
      });

      controller = new FakeHostWsController(async call => {
        // Importing the error class inline keeps this test from
        // forcing a top-level dependency the other suites don't need.
        const { HostWsCommandTransportError } = await import(
          '../../src/ws/host-ws-server.js'
        );
        throw new HostWsCommandTransportError(
          'transport_timeout',
          'simulated timeout',
          { hostId: call.hostId, commandKind: call.kind },
        );
      });
      // Background seed attempt fails; the generation stays un-seeded.
      await seedHostStatus(t, host!.id);
      const callsAfterSeed = controller.calls.length;
      expect(callsAfterSeed).toBe(1);

      const res = await sessionHttp(t, userToken).get(
        apiPaths.hostStatus(host!.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        availability: string;
        agents: Array<{ agent_id: string; online: string; avatar_url: string | null }>;
      } & Record<string, unknown>;
      expect(body).toMatchObject({
        host_id: host!.id,
        availability: 'unreachable',
        reason: 'daemon_unreachable',
      });
      // Gate #4: the HTTP read surface performed ZERO daemon RPC.
      expect(controller.calls.length).toBe(callsAfterSeed);
      // Registration still visible; offline because no confirmed snapshot.
      expect(body.agents.map(a => a.agent_id)).toEqual([agentId]);
      expect(body.agents[0]!.online).toBe('offline');
      expect(body.agents[0]!.avatar_url).toBeNull();
      expect(body).not.toHaveProperty('snapshot');
    });

    it('a pre-seed GET (daemon attached, seed not landed) returns unreachable and performs zero RPC', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({ hostWsController: () => controller });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const host = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
      controller = new FakeHostWsController(async () => {
        throw new Error('the HTTP read surface must not dispatch');
      });

      const res = await sessionHttp(t, userToken).get(
        apiPaths.hostStatus(host!.id),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        availability: 'unreachable',
        reason: 'daemon_unreachable',
      });
      expect(controller.calls).toHaveLength(0);
    });

    it('returns `revoked` arm with registration list (all offline), no daemon dispatch', async () => {
      let controller: FakeHostWsController | null = null;
      t = buildTestApp({ hostWsController: () => controller });
      const userToken = t.ctx.authSessions.issueSession({
        userId: t.viewerUserId,
      }).userToken;
      const repo = new HostRepo(t.ctx.db);
      const host = repo.getOwnedLocalForUser(t.viewerUserId);
      const agentId = insertTestAgent(t, {
        hostId: host!.id,
        name: 'orphan',
        displayName: 'Orphan',
        runtime: 'claude',
      });
      expect(repo.revoke(host!.id)).toBe(true);

      controller = new FakeHostWsController(async () => {
        throw new Error('daemon should NOT be dispatched for a revoked host');
      });

      const res = await sessionHttp(t, userToken).get(
        apiPaths.hostStatus(host!.id),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        availability: string;
        agents: Array<{ agent_id: string; online: string; avatar_url: string | null }>;
      } & Record<string, unknown>;
      expect(body).toMatchObject({
        host_id: host!.id,
        availability: 'revoked',
      });
      // Registrations survive revocation so the user can audit / cleanup.
      expect(body.agents.map(a => a.agent_id)).toEqual([agentId]);
      expect(body.agents[0]!.online).toBe('offline');
      expect(body.agents[0]!.avatar_url).toBeNull();
      expect(body).not.toHaveProperty('snapshot');
      expect(body).not.toHaveProperty('reason');
      // Daemon dispatch was short-circuited — controller stayed idle.
      expect(controller!.calls).toHaveLength(0);
    });

    it('returns 404 for cross-user host', async () => {
      t = buildTestApp();
      const bobHost = new HostRepo(t.ctx.db)
        .listOwnedActiveLocalForUser('bob')[0];
      const aliceToken = t.ctx.authSessions.issueSession({ userId: 'alice' }).userToken;
      const res = await sessionHttp(t, aliceToken).get(
        apiPaths.hostStatus(bobHost!.id),
      );
      expect(res.status).toBe(404);
    });
  });
});

/** Helper: insert a minimal agent row bound to `hostId` so the route's
 *  registration projection has something to render. The agent service
 *  has its own materialization machinery (D4.d) we don't need here —
 *  these tests focus on the route projection, not the spawn lifecycle.
 */
function insertTestAgent(
  t: TestApp,
  input: {
    hostId: string;
    name: string;
    displayName: string;
    runtime: string;
    materializationStatus?: 'pending_materialization' | 'active' | 'failed';
  },
): string {
  const id = `agent-${input.name}-${Math.floor(Math.random() * 1_000_000)}`;
  const now = Date.now();
  t.ctx.db
    .prepare(
      `INSERT INTO agents
         (id, name, display_name, runtime, model, reasoning_effort, fast_mode,
          host_id, description, created_by_user_id,
          materialization_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name,
      input.displayName,
      input.runtime,
      input.hostId,
      t.viewerUserId,
      input.materializationStatus ?? 'active',
      now,
      now,
    );
  return id;
}

function sessionHttp(t: TestApp, token: string) {
  return http(t, { authorization: `Bearer ${token}` });
}

/** #task:1588 gate #4 — the /status route is a memory-only read; tests
 *  drive the background seeding chain explicitly (production seeds on
 *  daemon attach via the fanout's onHostReady). */
async function seedHostStatus(t: TestApp, hostId: string): Promise<void> {
  await t.ctx.hostStatusReadModel!().seedEagerly(hostId);
}

function legacyServerAuthHttp(t: TestApp) {
  return http(t, { authorization: `Bearer ${t.legacyServerAuthToken}` });
}

class FakeHostWsController implements HostWsServerController {
  readonly calls: Array<{
    hostId: string;
    kind: OutboundServerCommandKind;
    params: any;
  }> = [];
  readonly disconnects: string[] = [];
  readonly disconnectReasons: Array<{ hostId: string; reason: string | undefined }> = [];

  constructor(
    private readonly handler: (call: {
      hostId: string;
      kind: OutboundServerCommandKind;
      params: any;
    }) => Promise<unknown>,
    private readonly attachment: { hostId: string; hostname: string | null } | null = null,
  ) {}

  activeConnectionCount(): number {
    return 1;
  }

  connectedHostIds(): string[] {
    return ['host'];
  }

  connectionIdForHost(): string | null {
    return 'conn-1';
  }

  getAttachment(hostId: string) {
    if (!this.attachment || this.attachment.hostId !== hostId) return null;
    return {
      hostId,
      connectionId: 'conn-1',
      attachedAt: 1_700_000_000_000,
      hostname: this.attachment.hostname,
      capabilities: [],
    };
  }

  async sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
  ): Promise<OutboundServerCommandResult<K>> {
    const call = { hostId, kind, params };
    this.calls.push(call);
    return await this.handler(call) as OutboundServerCommandResult<K>;
  }

  // D4.c C2 — record the disconnect call so tests can assert the
  // revoke route invoked it. Returns true unconditionally; the
  // route's contract is "best-effort, log and swallow", so the
  // value isn't load-bearing for the route side.
  disconnectHost(hostId: string, reason = HOST_WS_CLOSE_REASON_REVOKED): boolean {
    this.disconnects.push(hostId);
    this.disconnectReasons.push({ hostId, reason });
    return true;
  }

  async close(): Promise<void> {
    // no-op
  }
}
