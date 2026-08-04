/**
 * D4.d D6 commit 2 — `agent_materialize` real-wire e2e.
 *
 * Drives a real `POST /api/agents` from the standalone backend
 * through the **real outbound WS** to a **real in-process daemon**
 * that runs the **real `materializeAgent` handler** (the same
 * production-wired call out of `IntentDispatcher`'s
 * `agentMaterializeHandler` slot). The narrow test-only seam on
 * `RunDaemonOptions.testHooks` (Cindy D6-2 P1-1
 * `d4IID_Nnn1VShRa5`) lets the test:
 *
 *   - point `materializeAgent` at a tmp `homeDir` so the L1 tree
 *     lands outside the user's real `~/.silverhand/agents/`;
 *   - inject a deterministic typed `AgentMaterializeError` once
 *     to drive the §3.2 retry path through the dispatcher's
 *     typed-error narrowing branch.
 *
 * There is NO embedder-facing handler-replacement option — the
 * dispatcher slot always calls the real `materializeAgent`. The
 * `oneShotFault` flag below toggles a pre-handler fault hook;
 * everything else is the production code path.
 *
 * Test is Cindy `hkIP6tEkWJ2VcYfq` D6 review criterion #1
 * ("重点看 e2e 是否真走 wire path"). No `FakeHostWs`, no
 * `app.fetch(...)` shortcut, no hand-built outbound frames.
 *
 * Three phases in one test (so the second phase's retry verifies
 * the wire path is reusable, not just a one-shot):
 *
 *   1. **Happy create** — fresh POST → daemon ack ok → row reaches
 *      `materialization_status='active'`; dependent rows
 *      (agent_home workspace, DM channel, onboarding system
 *      message) exist on the SAME backend DB; daemon-side L1 dir
 *      contains the REAL template (`system_prompt.md`, `MEMORY.md`,
 *      `notes/onboarding-guide.md`, etc.) and the REAL
 *      `.materialized` sentinel schema (`{ version, agent_id,
 *      template_choice, runtime, materialized_at }`).
 *   2. **Typed-failure injection + same-row retry** — second fresh
 *      POST with a NEW key; the injected fault hook fires once
 *      and returns `AgentMaterializeError('agent_dir_collision',
 *      ...)` → row reaches `failed` with code
 *      `agent_dir_collision` AND HTTP 409 surfaces that code on
 *      the wire. Then `POST /api/agents?retry=true` with the same
 *      key: the fault hook is exhausted → real `materializeAgent`
 *      runs → row flips `failed → pending_materialization →
 *      active`, HTTP 201, the real template seeds in the L1 dir.
 *   3. **§3.2 echo over real wire** — third call with the SAME
 *      key + SAME body as phase 1 → 200 echo (no second daemon
 *      `agent_materialize` dispatch — idempotency dispatch
 *      short-circuits at the route layer). Locks the contract
 *      Cindy D3 round-1 P1 pinned: "same-key retry MUST return
 *      the same outcome it returned the first time without
 *      re-dispatching".
 *
 * R4 carveout (this commit): same boundary lock as every other
 * D4.d commit on the `agent_materialize` intent — this IS formal
 * server↔daemon semantics, the carve-out ("local supervisor/
 * control") does NOT apply. The whole point of the test is to
 * verify the formal-semantics wire stays correct end-to-end.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Driver } from '@silverhand/host/drivers';
import type { RuntimeKind } from '@silverhand/shared';
import {
  AgentMaterializeError,
  type AgentMaterializeParams,
} from '@silverhand/host';
import { AuthSessionService } from '../../src/auth/session.js';
import {
  bootDaemonWithSupervisor,
  bootG2Harness,
  waitForAttachment,
  type DaemonWithSupervisorHandle,
  type G2Harness,
} from './g2-harness.js';
import { CURRENT_DESKTOP_EPOCH_HEADERS } from '../utils/desktop-client-epoch.js';

/**
 * Stub driver — D6 e2e does NOT exercise any runtime intent
 * (the agent's L4 deliver + auto-start runs post-commit
 * best-effort, but the test does not assert on it). The
 * supervisor is only here because `bootDaemonWithSupervisor`
 * requires `driverFor`. If a runtime intent ever did reach the
 * supervisor the spawn would hit the thrown error below and
 * fail loud — exactly the right "fixture is being mis-used"
 * signal.
 */
function stubDriver(): (kind: RuntimeKind) => Driver {
  return () => {
    throw new Error(
      'D6 e2e: stub driver invoked — this fixture does not exercise runtime intents',
    );
  };
}

interface CreateAgentOk {
  agent: {
    id: string;
    name: string;
    materialization_status: string;
  };
  agent_home_workspace_id: string;
  dm_channel_id: string;
  onboarding_message_id: string;
}

interface CreateAgentErr {
  error: string;
  code: string;
  failed_code?: string;
}

async function postCreate(
  url: string,
  bearer: string,
  body: unknown,
  idempotencyKey: string,
  qs = '',
): Promise<{ status: number; json: CreateAgentOk | CreateAgentErr }> {
  const res = await fetch(`${url}/api/agents${qs}`, {
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
    json: text ? (JSON.parse(text) as CreateAgentOk | CreateAgentErr) : ({} as CreateAgentErr),
  };
}

/**
 * Daemon-side L1 dir for `agent_id` under the test's `homeDir`.
 * Mirrors `computeAgentDir`'s layout (`<homeDir>/.silverhand/
 * agents/<agentId>/`) without importing it (that path is behind
 * the agent-materialize tripwire for backend tests; the public
 * barrel does not re-export it).
 */
function agentL1Dir(homeDir: string, agentId: string): string {
  return join(homeDir, '.silverhand', 'agents', agentId);
}

describe('D4.d D6 — agent_materialize real-wire e2e', () => {
  let harness: G2Harness | null = null;
  let daemon: DaemonWithSupervisorHandle | null = null;
  let tmpHome: string | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined);
    daemon = null;
    await harness?.shutdown().catch(() => undefined);
    harness = null;
    if (tmpHome) {
      try {
        rmSync(tmpHome, { recursive: true, force: true });
      } catch {}
      tmpHome = null;
    }
  });

  it('POST → real WS → real materializeAgent → row active → typed-fault injection → ?retry=true succeeds → echo still 200', async () => {
    // Tmp dir that stands in for `homedir()` on the daemon side.
    // `materializeAgent` joins `<homeDir>/.silverhand/agents/<id>/`
    // onto this root, so passing the dir verbatim through
    // `testHooks.agentMaterializeHomeDir` keeps the real handler
    // off the user's `~/.silverhand/agents/`.
    tmpHome = mkdtempSync(join(tmpdir(), 'silverhand-d6-home-'));

    harness = await bootG2Harness();

    // One-shot typed-error fault for phase 2's typed-failure leg.
    // The injector is fired BEFORE `materializeAgent` on every
    // `agent_materialize` dispatch; returning a non-undefined
    // value causes the dispatcher to throw the typed error
    // (narrowed to the wire `error.code` by `dispatcher.ts`
    // line 328), returning undefined lets the real handler run.
    let oneShotFault = false;
    const faultInjector = (
      _params: AgentMaterializeParams,
    ): AgentMaterializeError | undefined => {
      if (!oneShotFault) return undefined;
      oneShotFault = false;
      return new AgentMaterializeError(
        'agent_dir_collision',
        'D6 e2e injected typed failure',
      );
    };

    daemon = await bootDaemonWithSupervisor(harness, {
      driverFor: stubDriver(),
      testHooks: {
        agentMaterializeHomeDir: tmpHome,
        agentMaterializeFaultInjector: faultInjector,
      },
    });

    // Wait for the daemon's outbound WS to attach (the route's
    // L0.7 online check needs a live `connectionId` — without it
    // the POST would 503 host_attach_pending before reserve).
    const attachment = await waitForAttachment(
      harness.backend.context.hostWsController!()!,
      harness.hostId,
    );
    expect(attachment.connectionId).toBeTruthy();

    // Need a session bearer for the public POST route. The
    // harness already inserted a user row at boot.
    const { userToken: bearer } = new AuthSessionService(
      harness.backend.context.db,
    ).issueSession({ userId: harness.userId });

    const baseUrl = harness.serverUrl;

    // ────────────────────────────────────────────────────────────
    // PHASE 1 — Happy create (real wire + real materializeAgent).
    // ────────────────────────────────────────────────────────────
    const happyKey = `d6-happy-${Date.now()}`;
    const happyBody = { name: `d6-happy-${Date.now()}`, runtime: 'claude' };
    const happy = await postCreate(baseUrl, bearer, happyBody, happyKey);
    expect(happy.status, JSON.stringify(happy.json)).toBe(201);
    const happyJson = happy.json as CreateAgentOk;
    expect(happyJson.agent.materialization_status).toBe('active');

    // Verify the REAL template seeded on the daemon side
    // (proves the sendCommand → daemon `materializeAgent` →
    // sentinel write round-trip really fired — and that what
    // ran was production code, not a test-replaced fake).
    const happyL1 = agentL1Dir(tmpHome, happyJson.agent.id);
    expect(existsSync(join(happyL1, 'system_prompt.md'))).toBe(true);
    expect(existsSync(join(happyL1, 'MEMORY.md'))).toBe(true);
    expect(existsSync(join(happyL1, 'notes', 'onboarding-guide.md'))).toBe(true);
    expect(existsSync(join(happyL1, 'notes', 'project.md'))).toBe(true);
    expect(existsSync(join(happyL1, '.materialized'))).toBe(true);
    // Sentinel must match the real schema —
    // `{ version, agent_id, template_choice, runtime,
    // materialized_at }`. A test-replaced fake would write any
    // shape; the production schema is what the §4.6 idempotency
    // decision tree validates on re-call.
    const sentinel = JSON.parse(
      readFileSync(join(happyL1, '.materialized'), 'utf8'),
    ) as Record<string, unknown>;
    expect(sentinel.version).toBe(1); // AGENT_HOME_TEMPLATE_VERSION
    expect(sentinel.agent_id).toBe(happyJson.agent.id);
    expect(sentinel.template_choice).toBe('default');
    expect(sentinel.runtime).toBe('claude');
    expect(typeof sentinel.materialized_at).toBe('number');
    expect(sentinel.materialized_at as number).toBeGreaterThan(0);

    // Verify backend-side dependent rows exist (L3a tx).
    const homeRow = harness.backend.context.db
      .prepare(`SELECT * FROM workspaces WHERE id = ?`)
      .get(happyJson.agent_home_workspace_id) as
      | { id: string; owner_agent_id: string }
      | undefined;
    expect(homeRow).toBeTruthy();
    expect(homeRow!.owner_agent_id).toBe(happyJson.agent.id);
    const dmRow = harness.backend.context.db
      .prepare(`SELECT id, kind FROM conversations WHERE id = ?`)
      .get(happyJson.dm_channel_id) as { id: string; kind: string } | undefined;
    expect(dmRow?.kind).toBe('dm_channel');

    // ────────────────────────────────────────────────────────────
    // PHASE 2 — Typed-failure injection + same-row ?retry=true.
    // ────────────────────────────────────────────────────────────
    oneShotFault = true; // next dispatch throws AgentMaterializeError
    const retryKey = `d6-retry-${Date.now()}`;
    const retryBody = {
      name: `d6-retry-${Date.now()}`,
      runtime: 'claude',
      description: 'd6 retry probe',
    };

    // Fresh POST — typed failure mapped to wire 409 via the
    // dispatcher's typed-error narrowing branch (Cindy D2
    // pre-gate #3).
    const failed = await postCreate(baseUrl, bearer, retryBody, retryKey);
    expect(failed.status, JSON.stringify(failed.json)).toBe(409);
    const failedJson = failed.json as CreateAgentErr;
    expect(failedJson.code).toBe('agent_dir_collision');

    // Row should be in `failed` with the wire-mapped code.
    const failedRow = harness.backend.context.db
      .prepare(
        `SELECT id, materialization_status, materialization_failed_code
           FROM agents WHERE idempotency_key = ?`,
      )
      .get(retryKey) as
      | {
          id: string;
          materialization_status: string;
          materialization_failed_code: string | null;
        }
      | undefined;
    expect(failedRow?.materialization_status).toBe('failed');
    expect(failedRow?.materialization_failed_code).toBe('agent_dir_collision');
    // The injected fault hook short-circuits BEFORE
    // `materializeAgent` runs, so no L1 dir for the failed
    // agent_id should exist.
    expect(existsSync(agentL1Dir(tmpHome, failedRow!.id))).toBe(false);

    // Same-row retry — fault hook is exhausted (`oneShotFault`
    // back to false after the first throw). Row should flip
    // `failed → pending_materialization → active` over the SAME
    // wire path; real `materializeAgent` seeds the real template
    // for the SAME agent_id.
    const retried = await postCreate(
      baseUrl,
      bearer,
      retryBody,
      retryKey,
      '?retry=true',
    );
    expect(retried.status, JSON.stringify(retried.json)).toBe(201);
    const retriedJson = retried.json as CreateAgentOk;
    expect(retriedJson.agent.id).toBe(failedRow!.id); // same-row
    expect(retriedJson.agent.materialization_status).toBe('active');
    const retriedL1 = agentL1Dir(tmpHome, retriedJson.agent.id);
    expect(existsSync(join(retriedL1, '.materialized'))).toBe(true);
    expect(existsSync(join(retriedL1, 'MEMORY.md'))).toBe(true);
    expect(existsSync(join(retriedL1, 'notes', 'onboarding-faq.md'))).toBe(true);

    // ────────────────────────────────────────────────────────────
    // PHASE 3 — §3.2 echo over real wire (same key + same body).
    // ────────────────────────────────────────────────────────────
    const echo = await postCreate(baseUrl, bearer, happyBody, happyKey);
    expect(echo.status, JSON.stringify(echo.json)).toBe(200);
    const echoJson = echo.json as CreateAgentOk;
    expect(echoJson.agent.id).toBe(happyJson.agent.id);
    expect(echoJson.dm_channel_id).toBe(happyJson.dm_channel_id);
    expect(echoJson.onboarding_message_id).toBe(
      happyJson.onboarding_message_id,
    );

    // Sanity: phase-3 echo must NOT have dispatched a second
    // `agent_materialize` for the happy row — we verify by
    // counting on-disk dirs (one per real dispatch). Three
    // POSTs total: happy + retry-fail (fault hook short-circuits
    // before any FS touch) + retry-ok = 2 real on-disk dirs
    // (happy + retry). Phase-3 echo short-circuits at the route
    // layer (200 echo) without crossing the wire.
    const agentsRoot = join(tmpHome, '.silverhand', 'agents');
    const agentsDir = readdirSync(agentsRoot);
    expect(agentsDir.sort()).toEqual(
      [happyJson.agent.id, retriedJson.agent.id].sort(),
    );
  }, 30_000);
});
