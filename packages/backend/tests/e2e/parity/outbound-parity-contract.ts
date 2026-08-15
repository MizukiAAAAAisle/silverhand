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
 *      `agent_runtime_slots.cli_session_id`.
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
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { fixedConversationTitle } from '@silverhand/shared';
import type { Driver, DriverSpawnContext, ParsedEvent } from '@silverhand/host/drivers';
import type { TestRunningBackend } from '../../utils/test-backend.js';
import type { OutboundFrameAdapter } from '../../../src/runtime/outbound-frame-adapter.js';
import { ConversationInboxRepo } from '../../../src/repos/conversation-inbox-repo.js';
import { CURRENT_DESKTOP_EPOCH_HEADERS } from '../../utils/desktop-client-epoch.js';

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
    releaseProfile: 'native-steer',
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
  /** The booted backend (real `startTestBackend`, real fanout — the shared
   *  contract asserts on rows no repository projects, so it needs the
   *  server's own connection, #task:1983 W5). */
  readonly backend: TestRunningBackend;
  /** Final bound URL (never the `:0` placeholder). */
  readonly baseUrl: string;
  /** Session bearer for the public POST /api/agents route. */
  readonly bearer: string;
  /** Local host row id that owns the seeded agents/workspaces. */
  readonly hostId: string;
  /** Seeded user id (creator of seeded agents). */
  readonly userId: string;
  /** Temp `.silverhand` root the rig's host-local dirs hang off. */
  readonly silverhandDir: string;
  /** Session id the daemon's parity driver emits (Phase A assertion). */
  readonly expectedSessionId: string;
  /** Daemon-side agents ROOT `materializeAgent` writes each agent's L1
   *  template under — one join from the L1 dir (#task:1813). */
  readonly agentsRootDir: string;
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
async function seedRuntimePair(rig: ParityRig): Promise<SeededRuntimePair> {
  const db = rig.backend.context.db;
  const now = Date.now();
  const suffix = `${rig.name}-${now}`;
  const workspaceId = `ws-parity-${suffix}`;
  const agentId = `agent-parity-${suffix}`;
  // Minted with the production generator, not a readable suffix
  // (#task:2021 P4-3): a delivery header renders this id as the stream's
  // absolute `target`, whose domain is exactly 16 base64url chars. The
  // per-transport suffix stays on the channel's NAME below.
  const conversationId = randomBytes(12).toString('base64url');
  const workspacePath = join(rig.silverhandDir, 'workspaces', workspaceId);
  mkdirSync(workspacePath, { recursive: true });

  db.prepare(
    `INSERT INTO workspaces
      (id, name, name_key, description, workspace_kind,
       owner_agent_id, archived_at, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'regular', NULL, NULL, ?, ?)`,
  ).run(workspaceId, `parity-ws-${suffix}`, `parity-ws-${suffix}`, now, now);
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
  // A workspace-placed conversation now carries its ADDRESS (#task:2016), and the
  // key comes from the one canonicalizer rather than a hand-folded literal.
  const channelTitle = fixedConversationTitle(`parity-channel-${suffix}`);
  db.prepare(
    `INSERT INTO conversations
      (id, workspace_id, placement_kind, roster_policy,
       title, title_key, status, spawned_by_agent_id, closed_at, close_summary,
       pinned_at, created_at, updated_at)
      VALUES (?, ?, 'workspace', 'open', ?, ?, 'active', NULL, NULL, NULL,
              NULL, ?, ?)`,
  ).run(
    conversationId,
    workspaceId,
    channelTitle.title,
    channelTitle.key,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
      VALUES (?, ?, ?)`,
  ).run(conversationId, rig.userId, now);
  db.prepare(
    `INSERT INTO conversation_agents
      (conversation_id, agent_id, joined_at)
     VALUES (?, ?, ?)`,
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
      ...CURRENT_DESKTOP_EPOCH_HEADERS,
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
    const { agentId, conversationId } = await seedRuntimePair(rig);

    // Production trigger: same path the delivery coordinator takes.
    // `start` → `startDeliveryBacked` claims the pending inbox row and
    // dispatches `runtime_start` over the outbound adapter; the real
    // daemon supervisor spawns the fixture which emits session_init.
    await rig.backend.context.runtimeHost.start(conversationId, agentId);

    await waitFor(
      () => {
        const row = rig.backend.context.db
          .prepare(
            `SELECT cli_session_id, observed_status AS status FROM agent_runtime_slots
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(conversationId, agentId) as
          | { cli_session_id: string | null; status: string }
          | undefined;
        return row && row.cli_session_id === rig.expectedSessionId ? row : null;
      },
      { timeoutMs: 15_000, label: 'session_init projected to runtime slot' },
    );

    const row = rig.backend.context.db
      .prepare(
        `SELECT cli_session_id, observed_status AS status FROM agent_runtime_slots
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
    const l1 = join(rig.agentsRootDir, ok.agent.id);
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

  it('Phase D — workspace lifecycle: POST create → pure DB write (no daemon bind); index resolve/unresolved keys on bundle-dir existence, not registry (same envelope)', async () => {
    const rig = getRig();
    const now = Date.now();
    const suffix = `${rig.name}-${now}`;

    // ── 1) CREATE via the real route → pure DB write. relocation-v1 §7-4:
    //    create NO LONGER dispatches any daemon command (registry demotion),
    //    so nothing is bound on the daemon for the new id, and §6's atomic
    //    epoch cut removed the caller-path input from the contract outright.
    //    Resolution is coordinate-based and lazy — exercised via
    //    `agent_workspace_index` below.
    //
    // MEMBERLESS on purpose: the phase runs identically in both rigs, and
    // membership (when a later test needs it) is attached by direct
    // `INSERT INTO workspace_members`, never via this route.
    const createRes = await fetch(`${rig.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: {
        ...CURRENT_DESKTOP_EPOCH_HEADERS,
        'content-type': 'application/json',
        authorization: `Bearer ${rig.bearer}`,
      },
      body: JSON.stringify({
        name: `parity-prov-${suffix}`,
      }),
    });
    const createBody = (await createRes.json()) as {
      workspace?: { id: string };
      error?: string;
      code?: string;
    };
    expect(createRes.status, JSON.stringify(createBody)).toBe(201);
    const workspaceId = createBody.workspace!.id;

    const adapter = rig.adapter();
    const conn = adapter.connectionIdForHost(rig.hostId) ?? undefined;
    // Like Phase C: assert a live connection up front so a lost/replaced
    // connection fails sharply here, not as an opaque transport error deep
    // in the first dispatch below.
    expect(conn, 'adapter must report a live connectionId for the local host').toBeTruthy();

    // ── 2) agent_workspace_index over the real daemon — a CWD fact keyed on
    //    the deterministic agent-centric bundle COORDINATE, NOT on a registry
    //    binding (relocation-v1 §7 task 4). An id resolves to a daemon-stamped
    //    `agent_dir` (`<agent home>/workspaces/<workspace_id>`, NOT under the
    //    bound workspace path) iff that bundle coordinate is a usable working
    //    directory on this computer RIGHT NOW.
    //
    //    2a — BEFORE any materialization: neither id has a materialized bundle
    //    dir yet, so both `workspaceId` and the never-seeded `neverId` come back
    //    `unresolved`. This is the falsifier for the coordinate-vs-registry
    //    decoupling — resolution keys on the bundle dir existing, never on a
    //    registry binding: the legal lazy window after a pure-DB membership add
    //    (member added, agent never spawned here). The daemon NEVER synthesizes
    //    a path for a dir that does not exist (no eager guest realization after
    //    the provisioning collapse).
    const agentId = `agent-prov-${suffix}`;
    const neverId = `ws-never-${suffix}`;
    const bundleDir = join(
      join(rig.agentsRootDir, agentId),
      'workspaces',
      workspaceId,
    );
    const preIndex = (await adapter.sendCommand(
      rig.hostId,
      'agent_workspace_index',
      { agent_id: agentId, workspace_ids: [workspaceId, neverId] },
      { expectedConnectionId: conn, timeoutMs: 5_000 },
    )) as { entries: unknown[]; unresolved: string[] };
    expect(preIndex.entries).toEqual([]);
    expect(preIndex.unresolved).toEqual([workspaceId, neverId]);

    //    2b — materialize `workspaceId`'s bundle via `agent_l2_seed` (the write
    //    half of the coordinate-vs-availability split — it mkdirs the coordinate
    //    directly, no registry gate), then re-index: `workspaceId` now resolves
    //    to its bundle dir while the still-unseeded `neverId` stays `unresolved`.
    const seedForIndex = (await adapter.sendCommand(
      rig.hostId,
      'agent_l2_seed',
      { agent_id: agentId, workspace_id: workspaceId, template_choice: 'default' },
      { expectedConnectionId: conn, timeoutMs: 5_000 },
    )) as { ok: true; l2_present: boolean };
    expect(seedForIndex).toMatchObject({ ok: true, l2_present: true });

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
      { workspace_id: workspaceId, agent_dir: bundleDir },
    ]);
    expect(index.unresolved).toEqual([neverId]);
  }, 30_000);

  it('Phase F — agent_l2_seed over the real daemon: seeds MEMORY.md + notes/ (NO system_prompt.md), idempotent, coordinate-derived (seeds even a never-provisioned id, same envelope)', async () => {
    const rig = getRig();
    const now = Date.now();
    const suffix = `${rig.name}-${now}`;

    // Create a real workspace via the route (pure DB write; mirrors Phase D's
    // create leg). The daemon resolves the host-local L2 coordinate from the
    // ids alone — lazily, not from any registry binding.
    const createRes = await fetch(`${rig.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: {
        ...CURRENT_DESKTOP_EPOCH_HEADERS,
        'content-type': 'application/json',
        authorization: `Bearer ${rig.bearer}`,
      },
      body: JSON.stringify({
        name: `parity-l2-${suffix}`,
      }),
    });
    const createBody = (await createRes.json()) as {
      workspace?: { id: string };
    };
    expect(createRes.status, JSON.stringify(createBody)).toBe(201);
    const workspaceId = createBody.workspace!.id;

    const adapter = rig.adapter();
    const conn = adapter.connectionIdForHost(rig.hostId) ?? undefined;
    expect(conn, 'adapter must report a live connectionId for the local host').toBeTruthy();

    const agentId = `agent-l2-${suffix}`;
    // ── 1) Seed L2 on the REAL daemon over the real wire.
    const seed = (await adapter.sendCommand(
      rig.hostId,
      'agent_l2_seed',
      { agent_id: agentId, workspace_id: workspaceId, template_choice: 'default' },
      { expectedConnectionId: conn, timeoutMs: 5_000 },
    )) as { ok: true; seeded: boolean; l2_present: boolean };
    expect(seed).toMatchObject({ ok: true, seeded: true, l2_present: true });

    // The daemon wrote its OWN host-local L2 at the deterministic bundle
    // root (relocation-v1 §3.2: `<agent home>/workspaces/<id>`, no longer a
    // `.silverhand/agents/<id>` sub-path under the workspace): MEMORY.md +
    // notes/, NEVER L1 system_prompt.md.
    const l2 = join(
      join(rig.agentsRootDir, agentId),
      'workspaces',
      workspaceId,
    );
    expect(existsSync(join(l2, 'MEMORY.md'))).toBe(true);
    expect(existsSync(join(l2, 'system_prompt.md'))).toBe(false);
    expect(existsSync(join(l2, 'notes'))).toBe(true);

    // ── 2) IDEMPOTENT re-seed: an agent edit survives; nothing re-written.
    const memPath = join(l2, 'MEMORY.md');
    const edited = `# edited ${suffix}\n`;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(memPath, edited, 'utf8');
    const reseed = (await adapter.sendCommand(
      rig.hostId,
      'agent_l2_seed',
      { agent_id: agentId, workspace_id: workspaceId, template_choice: 'default' },
      { expectedConnectionId: conn, timeoutMs: 5_000 },
    )) as { seeded: boolean; l2_present: boolean };
    expect(reseed).toMatchObject({ seeded: false, l2_present: true });
    expect(readFileSync(memPath, 'utf8')).toBe(edited);

    // ── 3) COORDINATE-DERIVED, NOT registry-gated (relocation-v1 §7 task 4):
    //    a workspace id that was NEVER provisioned in the registry still seeds
    //    successfully — seeding IS what makes the deterministic coordinate
    //    available, so the daemon mkdirs `<agent home>/workspaces/<id>` directly
    //    from the id alone and fails closed only on the fs, never on a missing
    //    registry binding. The old `workspace_not_provisioned` reject went away
    //    with the establishment gate.
    const neverId = `ws-never-${suffix}`;
    const neverSeed = (await adapter.sendCommand(
      rig.hostId,
      'agent_l2_seed',
      { agent_id: agentId, workspace_id: neverId, template_choice: 'default' },
      { expectedConnectionId: conn, timeoutMs: 5_000 },
    )) as { ok: true; seeded: boolean; l2_present: boolean };
    expect(neverSeed).toMatchObject({ ok: true, seeded: true, l2_present: true });
    // The coordinate was materialized from the id alone — no registry binding.
    const neverL2 = join(
      join(rig.agentsRootDir, agentId),
      'workspaces',
      neverId,
    );
    expect(existsSync(join(neverL2, 'MEMORY.md'))).toBe(true);
    expect(existsSync(join(neverL2, 'system_prompt.md'))).toBe(false);
  }, 30_000);

  it('Phase G — agent_files_purge over the real daemon: removes the agent home tree, idempotent (same envelope)', async () => {
    const rig = getRig();
    const now = Date.now();
    const suffix = `${rig.name}-purge-${now}`;

    // Create a real workspace + seed an L2 dir so the daemon has something to
    // remove (the daemon resolves the L2 coordinate lazily from the ids, not
    // from a backend-supplied path).
    const createRes = await fetch(`${rig.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: {
        ...CURRENT_DESKTOP_EPOCH_HEADERS,
        'content-type': 'application/json',
        authorization: `Bearer ${rig.bearer}`,
      },
      body: JSON.stringify({
        name: `parity-purge-${suffix}`,
      }),
    });
    const createBody = (await createRes.json()) as {
      workspace?: { id: string };
    };
    expect(createRes.status, JSON.stringify(createBody)).toBe(201);
    const workspaceId = createBody.workspace!.id;

    const adapter = rig.adapter();
    const conn = adapter.connectionIdForHost(rig.hostId) ?? undefined;
    expect(conn, 'adapter must report a live connectionId for the local host').toBeTruthy();

    const agentId = `agent-purge-${suffix}`;
    await adapter.sendCommand(
      rig.hostId,
      'agent_l2_seed',
      { agent_id: agentId, workspace_id: workspaceId, template_choice: 'default' },
      { expectedConnectionId: conn, timeoutMs: 5_000 },
    );
    const l2 = join(
      join(rig.agentsRootDir, agentId),
      'workspaces',
      workspaceId,
    );
    expect(existsSync(l2)).toBe(true);

    // ── 1) PURGE — relocation-v1 §7 task 4 nests every per-workspace L2 bundle
    //    UNDER the agent home, so the purge removes the single agent-home tree
    //    (which the seed above materialized) in one rm, consulting no registry.
    const purge = (await adapter.sendCommand(
      rig.hostId,
      'agent_files_purge',
      { agent_id: agentId },
      { expectedConnectionId: conn, timeoutMs: 5_000 },
    )) as { ok: true; purged_count: number };
    expect(purge.ok).toBe(true);
    expect(purge.purged_count).toBeGreaterThanOrEqual(1);
    expect(existsSync(l2)).toBe(false);

    // ── 2) IDEMPOTENT re-purge: the daemon keeps the terminal fence and
    // returns its cached success. This is deliberately the same semantic ack,
    // rather than re-entering the filesystem leaf through the fence.
    const repurge = (await adapter.sendCommand(
      rig.hostId,
      'agent_files_purge',
      { agent_id: agentId },
      { expectedConnectionId: conn, timeoutMs: 5_000 },
    )) as { ok: true; purged_count: number };
    expect(repurge).toEqual(purge);
  }, 30_000);
}
