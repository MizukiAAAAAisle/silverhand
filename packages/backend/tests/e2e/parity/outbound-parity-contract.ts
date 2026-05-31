/**
 * D5.a-4 — outbound frame adapter PARITY contract.
 *
 * The whole point of D5.a is that embedded and standalone backends speak
 * the SAME outbound frame envelope; the transport differs (embedded =
 * local Unix socket, standalone = WSS) but the command/event schemas,
 * error taxonomy, and backend dispatch path do NOT. This module encodes
 * that "do NOT differ" as a single set of e2e phases both deployments run
 * verbatim — neither side gets its own bespoke success path (Cindy
 * `8a5PMGwqiBIO8ccg` focus #1).
 *
 * A `ParityRig` is the only thing that differs between the two: it stands
 * up a real backend wired to a real daemon over the deployment's
 * transport, and exposes the handful of handles the shared phases need.
 * Each transport's test file owns the rig lifecycle (beforeAll/afterAll)
 * and calls {@link registerParityPhases} to register the identical specs.
 *
 * Phases (all through real route → real adapter → real daemon dispatch →
 * real handler → DB; no fake success — Cindy focus #4):
 *
 *   A. runtime_start dispatch + session_init projection. `runtimeHost.start`
 *      claims a pending inbox row, dispatches `runtime_start` over the
 *      adapter, the real daemon supervisor spawns the fixture which emits
 *      a session_init sentinel; the real fanout projects it to
 *      `conversation_agents.cli_session_id`.
 *   B. agent_materialize create. POST /api/agents → route → adapter →
 *      daemon `IntentDispatcher` → real `materializeAgent` → wire response
 *      → row flips `materialization_status='active'` + real L1 template on
 *      the daemon-side home dir.
 *   C. connection-id replacement guard. A command pinned to a stale
 *      `expectedConnectionId` must reject (never be answered by the live
 *      connection), while the live connection still serves — proving a
 *      late response bound to a replaced connection cannot pollute the
 *      current one (Cindy focus #3, command-level arm). The deeper
 *      "old-connection disconnect/replay doesn't wipe new state" arm is a
 *      transport-specific spec in the standalone file (multi-daemon
 *      reconnect) and is referenced from the embedded file's notes.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { Driver, DriverSpawnContext, ParsedEvent } from '@silverhand/host/drivers';
import type { RunningBackend } from '../../../src/index.js';
import type { OutboundFrameAdapter } from '../../../src/runtime/outbound-frame-adapter.js';
import { ConversationInboxRepo } from '../../../src/repos/conversation-inbox-repo.js';

/**
 * Real runtime fixture both rigs spawn (via the daemon supervisor) — the
 * same `echo-runtime.cjs` the standalone G2 suite uses. It echoes a
 * sentinel line so the driver's `parseLine` can synthesize a deterministic
 * `session_init`.
 */
const PARITY_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../host/tests/_fixtures/echo-runtime.cjs',
);

/**
 * The SAME driver for both transports — Phase A's parity rests on both
 * daemons interpreting the runtime identically and emitting the same
 * session_init through the same envelope.
 */
export function makeParitySessionInitDriver(sessionId: string): Driver {
  return {
    kind: 'claude',
    binary: PARITY_FIXTURE,
    kickoffMode: 'self_inits',
    busyDeliveryMode: 'direct',
    oneShot: false,
    supportsNativeStandingPrompt: true,
    initLivenessSilenceMs: 30_000,
    initPreProtocolCapMs: 5 * 60_000,
    initPostProtocolMs: 60_000,
    buildArgs: (_ctx: DriverSpawnContext): string[] => [
      PARITY_FIXTURE,
      '--emit-line',
      `${PARITY_SESSION_PREFIX}${sessionId}`,
      '--echo-stdin',
    ],
    applyEnv: env => ({ ...env }),
    encodeStdinMessage: (text: string) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: text } }),
    encodeInterruptControl: () => null,
    parseLine: (line: string): ParsedEvent[] => {
      const idx = line.indexOf(PARITY_SESSION_PREFIX);
      if (idx < 0) return [];
      const sid = line.slice(idx + PARITY_SESSION_PREFIX.length).trim();
      return [{ kind: 'session_init', sessionId: sid }];
    },
    classifyInitProgress: () => null,
  };
}

/**
 * Sentinel the parity session_init driver emits right after READY. Both
 * rigs wire `makeParitySessionInitDriver(rig.expectedSessionId)` into the
 * daemon supervisor, so Phase A can assert the projected `cli_session_id`
 * deterministically.
 */
export const PARITY_SESSION_PREFIX = '__D5A4_PARITY_SESSION__:';

export interface ParityRig {
  /** Which transport this rig exercises. */
  readonly name: 'embedded' | 'standalone';
  /** The booted backend (real `startBackend`, real fanout). */
  readonly backend: RunningBackend;
  /** Final bound URL (never the `:0` placeholder). */
  readonly baseUrl: string;
  /** Session bearer for the public POST /api/agents route. */
  readonly bearer: string;
  /** Local host row id that owns the seeded agents/workspaces. */
  readonly hostId: string;
  /** Seeded user id (creator of seeded agents). */
  readonly userId: string;
  /** Temp `.silverhand` root — used for real workspace_path dirs. */
  readonly silverhandDir: string;
  /** Session id the daemon's parity driver emits (Phase A assertion). */
  readonly expectedSessionId: string;
  /** Daemon-side home dir `materializeAgent` writes the L1 template under. */
  readonly agentHomeDir: string;
  /** The live, mode-specific outbound adapter the backend is using. */
  adapter(): OutboundFrameAdapter;
  /** Tear down backend + daemon + temp dirs. */
  shutdown(): Promise<void>;
}

export async function waitFor<T>(
  predicate: () => T | null | undefined,
  { timeoutMs = 10_000, label = 'condition' }: { timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const start = Date.now();
  let last: T | null | undefined;
  while (Date.now() - start < timeoutMs) {
    last = predicate();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Daemon-side L1 dir for `agentId` under `homeDir` (mirrors computeAgentDir). */
function agentL1Dir(homeDir: string, agentId: string): string {
  return join(homeDir, '.silverhand', 'agents', agentId);
}

interface CreateAgentOk {
  agent: { id: string; name: string; materialization_status: string };
  agent_home_workspace_id: string;
  dm_channel_id: string;
  onboarding_message_id: string;
}

interface SeededRuntimePair {
  workspaceId: string;
  agentId: string;
  conversationId: string;
}

/**
 * Seed a (workspace, agent, conversation, conversation_agents=idle) triple
 * owned by `rig.hostId`/`rig.userId` plus one pending inbox row, so
 * `runtimeHost.start` has delivery-backed work to dispatch. Identical SQL
 * for both transports (the schema is transport-agnostic — that is the
 * whole point).
 */
function seedRuntimePair(rig: ParityRig): SeededRuntimePair {
  const db = rig.backend.context.db;
  const now = Date.now();
  const suffix = `${rig.name}-${now}`;
  const workspaceId = `ws-parity-${suffix}`;
  const agentId = `agent-parity-${suffix}`;
  const conversationId = `conv-parity-${suffix}`;
  const workspacePath = join(rig.silverhandDir, 'workspaces', workspaceId);
  mkdirSync(workspacePath, { recursive: true });

  db.prepare(
    `INSERT INTO workspaces
      (id, name, description, workspace_kind, workspace_path,
       workspace_host_id, owner_agent_id, archived_at, created_at, updated_at)
      VALUES (?, ?, NULL, 'regular', ?, ?, NULL, NULL, ?, ?)`,
  ).run(workspaceId, `parity-ws-${suffix}`, workspacePath, rig.hostId, now, now);
  db.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, joined_at)
      VALUES (?, ?, ?)`,
  ).run(workspaceId, rig.userId, now);
  db.prepare(
    `INSERT INTO agents
      (id, name, runtime, model, host_id, description, created_at,
       updated_at, display_name, reasoning_effort, fast_mode,
       created_by_user_id, avatar_storage_key, avatar_content_type)
      VALUES (?, ?, 'claude', NULL, ?, NULL, ?, ?, ?, NULL, NULL,
              ?, NULL, NULL)`,
  ).run(agentId, `parity-agent-${suffix}`, rig.hostId, now, now, 'Parity Agent', rig.userId);
  db.prepare(
    `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
      VALUES (?, ?, ?)`,
  ).run(workspaceId, agentId, now);
  db.prepare(
    `INSERT INTO conversations
      (id, workspace_id, workspace_path, kind, parent_conversation_id,
       title, status, spawned_by_agent_id, closed_at, close_summary,
       pinned_at, created_at, updated_at)
      VALUES (?, ?, ?, 'channel', NULL, ?, 'active', NULL, NULL, NULL,
              NULL, ?, ?)`,
  ).run(conversationId, workspaceId, workspacePath, `parity-channel-${suffix}`, now, now);
  db.prepare(
    `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
      VALUES (?, ?, ?)`,
  ).run(conversationId, rig.userId, now);
  db.prepare(
    `INSERT INTO conversation_agents
      (conversation_id, agent_id, cli_session_id, pid, status, joined_at)
      VALUES (?, ?, NULL, NULL, 'idle', ?)`,
  ).run(conversationId, agentId, now);

  const messageId = `msg-parity-${suffix}`;
  db.prepare(
    `INSERT INTO messages
      (id, conversation_id, from_kind, from_agent_id, from_user_id,
       content, metadata, seq, created_at)
      VALUES (?, ?, 'user', NULL, ?, ?, NULL, 1, ?)`,
  ).run(messageId, conversationId, rig.userId, 'hello parity agent', now);
  new ConversationInboxRepo(db).enqueue(conversationId, agentId, messageId);

  return { workspaceId, agentId, conversationId };
}

async function postCreateAgent(
  baseUrl: string,
  bearer: string,
  body: unknown,
  idempotencyKey: string,
  qs = '',
): Promise<{ status: number; json: CreateAgentOk & { error?: string; code?: string } }> {
  const res = await fetch(`${baseUrl}/api/agents${qs}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text ? JSON.parse(text) : {},
  };
}

/**
 * Register the three identical parity phases against `getRig()` (resolved
 * lazily inside each spec so the test file can boot the rig in `beforeAll`).
 */
export function registerParityPhases(getRig: () => ParityRig): void {
  it('Phase A — runtime_start dispatch → real daemon spawn → session_init projects cli_session_id (same envelope)', async () => {
    const rig = getRig();
    const { agentId, conversationId } = seedRuntimePair(rig);

    // Production trigger: same path the delivery coordinator takes.
    // `start` → `startDeliveryBacked` claims the pending inbox row and
    // dispatches `runtime_start` over the outbound adapter; the real
    // daemon supervisor spawns the fixture which emits session_init.
    await rig.backend.context.runtimeHost.start(conversationId, agentId);

    await waitFor(
      () => {
        const row = rig.backend.context.db
          .prepare(
            `SELECT cli_session_id, status FROM conversation_agents
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(conversationId, agentId) as
          | { cli_session_id: string | null; status: string }
          | undefined;
        return row && row.cli_session_id === rig.expectedSessionId ? row : null;
      },
      { timeoutMs: 15_000, label: 'session_init projected to conversation_agents' },
    );

    const row = rig.backend.context.db
      .prepare(
        `SELECT cli_session_id, status FROM conversation_agents
          WHERE conversation_id = ? AND agent_id = ?`,
      )
      .get(conversationId, agentId) as { cli_session_id: string | null; status: string };
    expect(row.cli_session_id).toBe(rig.expectedSessionId);
    expect(row.status).toBe('active');
  }, 30_000);

  it('Phase B — POST /api/agents → real adapter → real materializeAgent → row active + real L1 template', async () => {
    const rig = getRig();
    const key = `parity-${rig.name}-${Date.now()}`;
    const body = { name: `parity-${rig.name}-${Date.now()}`, runtime: 'claude' };

    const created = await postCreateAgent(rig.baseUrl, rig.bearer, body, key);
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const ok = created.json as CreateAgentOk;
    expect(ok.agent.materialization_status).toBe('active');

    // Real template seeded on the daemon side over the real wire — proves
    // the dispatch reached the REAL `materializeAgent`, not a fake success.
    const l1 = agentL1Dir(rig.agentHomeDir, ok.agent.id);
    expect(existsSync(join(l1, 'system_prompt.md'))).toBe(true);
    expect(existsSync(join(l1, 'MEMORY.md'))).toBe(true);
    expect(existsSync(join(l1, '.materialized'))).toBe(true);
    const sentinel = JSON.parse(readFileSync(join(l1, '.materialized'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(sentinel.version).toBe(1);
    expect(sentinel.agent_id).toBe(ok.agent.id);
    expect(sentinel.runtime).toBe('claude');

    // Backend-side dependent rows (L3a tx) landed.
    const homeRow = rig.backend.context.db
      .prepare(`SELECT owner_agent_id FROM workspaces WHERE id = ?`)
      .get(ok.agent_home_workspace_id) as { owner_agent_id: string } | undefined;
    expect(homeRow?.owner_agent_id).toBe(ok.agent.id);
    const dmRow = rig.backend.context.db
      .prepare(`SELECT kind FROM conversations WHERE id = ?`)
      .get(ok.dm_channel_id) as { kind: string } | undefined;
    expect(dmRow?.kind).toBe('dm_channel');

    // Idempotent echo over the SAME key+body must NOT re-dispatch — 200.
    const echo = await postCreateAgent(rig.baseUrl, rig.bearer, body, key);
    expect(echo.status, JSON.stringify(echo.json)).toBe(200);
    expect((echo.json as CreateAgentOk).agent.id).toBe(ok.agent.id);
  }, 30_000);

  it('Phase C — connection-id replacement guard: stale expectedConnectionId rejects, live connection still serves', async () => {
    const rig = getRig();
    const adapter = rig.adapter();
    const conn = adapter.connectionIdForHost(rig.hostId);
    expect(conn, 'adapter must report a live connectionId for the local host').toBeTruthy();

    // A command pinned to a connection that is no longer current must fail
    // fast — it can NEVER be answered by the live connection. This is the
    // exact guarantee that a late response bound to a replaced connection
    // cannot pollute the current one (Cindy focus #3, command-level arm).
    await expect(
      adapter.sendCommand(
        rig.hostId,
        'runtime_status',
        {},
        { expectedConnectionId: `${conn}-stale`, timeoutMs: 5_000 },
      ),
    ).rejects.toMatchObject({
      // Both adapters throw a typed transport error on connection-id
      // mismatch (`transport_disconnected`); the route layer maps it to
      // host_attach_pending. We assert the code shape, not the class, so
      // the same matcher works across both transports.
      code: 'transport_disconnected',
    });

    // The live connection (correct id) still serves the same command.
    const result = await adapter.sendCommand(
      rig.hostId,
      'runtime_status',
      {},
      { expectedConnectionId: conn ?? undefined, timeoutMs: 5_000 },
    );
    expect(Array.isArray((result as { runtimes: unknown[] }).runtimes)).toBe(true);
  }, 20_000);

  it('Phase D — workspace lifecycle: POST create → real workspace_provision bind; direct re-provision idempotent + index resolve/unresolved (same envelope)', async () => {
    const rig = getRig();
    const now = Date.now();
    const suffix = `${rig.name}-${now}`;

    // ── 1) CREATE via the real route → real adapter → REAL daemon
    //    `workspace_provision` → real `WorkspaceRegistry` binds the path.
    //
    // MEMBERLESS on purpose. The create-with-members seed path writes agent
    // L1/L2 on the BACKEND disk and is gated to the backend's co-located
    // host (D4.e-1 3b): standalone's `coLocatedHostId` is undefined, so a
    // member create would 409 there and the two rigs could not run the SAME
    // phase. Memberless create binds the workspace path in EVERY mode, which
    // is exactly the envelope leg under test. Membership, when a later test
    // needs it, is attached by direct `INSERT INTO workspace_members` — the
    // supported post-3b path — never via this gated route.
    const requestedPath = join(rig.silverhandDir, 'parity-prov', `ws-${suffix}`);
    const createRes = await fetch(`${rig.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${rig.bearer}`,
      },
      body: JSON.stringify({
        name: `parity-prov-${suffix}`,
        workspace_host_id: rig.hostId,
        workspace_path: requestedPath,
      }),
    });
    const createBody = (await createRes.json()) as {
      workspace?: { id: string; workspace_path: string };
      error?: string;
      code?: string;
    };
    expect(createRes.status, JSON.stringify(createBody)).toBe(201);
    const workspaceId = createBody.workspace!.id;
    const boundPath = createBody.workspace!.workspace_path;
    expect(boundPath).toBeTruthy();

    const adapter = rig.adapter();
    const conn = adapter.connectionIdForHost(rig.hostId) ?? undefined;
    // Like Phase C: assert a live connection up front so a lost/replaced
    // connection fails sharply here, not as an opaque transport error deep
    // in the first dispatch below.
    expect(conn, 'adapter must report a live connectionId for the local host').toBeTruthy();

    // ── 2) IDEMPOTENT re-provision — proven by DIRECT dispatch, never a
    //    second POST. POST /api/workspaces pre-generates a fresh
    //    `workspace_id` every call, so it can NEVER exercise "same id +
    //    same path → provisioned:false". Dispatching `workspace_provision`
    //    straight to the live daemon with the bound id+path does: the
    //    registry already holds that mapping → `created:false`.
    const reprov = (await adapter.sendCommand(
      rig.hostId,
      'workspace_provision',
      { workspace_id: workspaceId, kind: 'regular', requested_path: boundPath },
      { expectedConnectionId: conn, timeoutMs: 5_000 },
    )) as { provisioned: boolean; bound_workspace_path: string };
    expect(reprov).toMatchObject({
      provisioned: false,
      bound_workspace_path: boundPath,
    });

    // ── 3) agent_workspace_index over the SAME live daemon registry:
    //    a provisioned regular id resolves to a daemon-stamped `agent_dir`
    //    under the bound path; a never-provisioned id comes back fail-closed
    //    in `unresolved` (the backend must NOT synthesize a path for it).
    //
    //    This true-daemon `unresolved` lives at the DIRECT adapter layer on
    //    purpose: post-3b the `list_workspaces` route first lazily
    //    `workspace_provision(requested_path=workspace_path)`s every visible
    //    regular row, so a never-provisioned id can never reach `index` via
    //    the normal route — route-level fail-closed (503/409) stays covered
    //    by the 3b fake-registry pins, and the genuine daemon `unresolved`
    //    is asserted here against the real registry.
    const agentId = `agent-prov-${suffix}`;
    const neverId = `ws-never-${suffix}`;
    const index = (await adapter.sendCommand(
      rig.hostId,
      'agent_workspace_index',
      { agent_id: agentId, workspace_ids: [workspaceId, neverId] },
      { expectedConnectionId: conn, timeoutMs: 5_000 },
    )) as {
      entries: { workspace_id: string; agent_dir: string }[];
      unresolved: string[];
    };
    expect(index.entries).toEqual([
      {
        workspace_id: workspaceId,
        agent_dir: join(boundPath, '.silverhand', 'agents', agentId),
      },
    ]);
    expect(index.unresolved).toEqual([neverId]);
  }, 30_000);
}
