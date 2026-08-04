/**
 * relocation-v1 §7 task 4 (#task:1808 B1) — pins the backend test double
 * (`FakeHostWsServerController`) to the TERMINAL deterministic-coordinate
 * topology.
 *
 * Before this, the fake modelled the RETIRED registry: a regular workspace
 * with no `boundWorkspacePaths` entry threw `workspace_not_provisioned` from
 * `agentWorkspaceBaseDir` / `agent_l2_seed`, and `agent_workspace_index`
 * reported it forever `unresolved`. That DEFAULT was OPPOSITE to production —
 * which resolves the deterministic agent-centric bundle coordinate
 * (`<agent home>/workspaces/<wid>`) and treats an un-materialized bundle as an
 * ordinary filesystem absence, never a provisioning refusal. Green tests only
 * survived by overriding the acks, so the U1/U2/U4 happy path was never
 * actually exercised and the rejected legacy branch stayed alive.
 *
 * This drives the DEFAULT fake (NO ack override) through the full lifecycle.
 * (The retired `workspace_not_provisioned` code stays out of these intents by a
 * one-time grep audit; the durable gate is U5's schema narrowing, which makes
 * the compiler reject the code — not a fragile self-scanning meta-test.)
 */
import { join as joinPath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './app.js';

describe('FakeHostWsServerController default topology (relocation-v1 §7 task 4 — #task:1808 B1 falsifier)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const AGENT = 'aid-bundle-falsifier';
  const WS = 'ws-bundle-falsifier';

  it('un-materialized regular bundle → index unresolved / tree empty / read not_found; agent_l2_seed makes it available — never workspace_not_provisioned, no registry map', async () => {
    t = buildTestApp();
    const fake = t.fakeHostWs!;
    const HOST = t.ctx.coLocatedHostId!;
    const bundleDir = joinPath(
      t.silverhandDir,
      'agents',
      AGENT,
      'workspaces',
      WS,
    );

    // ── Before any spawn/seed: the coordinate is a valid, computable path but
    //    its dir does not exist yet — the legal lazy window after a pure-DB
    //    membership add. No registry map is consulted; nothing throws. ──────
    const idx0 = await fake.sendCommand(HOST, 'agent_workspace_index', {
      agent_id: AGENT,
      workspace_ids: [WS],
    });
    expect(idx0).toEqual({ ok: true, entries: [], unresolved: [WS] });

    const tree0 = await fake.sendCommand(HOST, 'agent_workspace_tree', {
      agent_id: AGENT,
      workspace_id: WS,
    });
    expect(tree0).toEqual({ ok: true, tree: { nodes: [] } });

    await expect(
      fake.sendCommand(HOST, 'agent_workspace_file_read', {
        agent_id: AGENT,
        workspace_id: WS,
        path: 'MEMORY.md',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // ── Seed: the write half materializes the deterministic coordinate. ────
    const seed = await fake.sendCommand(HOST, 'agent_l2_seed', {
      agent_id: AGENT,
      workspace_id: WS,
      template_choice: 'default',
    });
    expect(seed).toMatchObject({ ok: true, seeded: true, l2_present: true });

    // ── After seed: the SAME coordinate is now available end-to-end. ───────
    const idx1 = await fake.sendCommand(HOST, 'agent_workspace_index', {
      agent_id: AGENT,
      workspace_ids: [WS],
    });
    expect(idx1).toEqual({
      ok: true,
      entries: [{ workspace_id: WS, agent_dir: bundleDir }],
      unresolved: [],
    });

    const tree1 = (await fake.sendCommand(HOST, 'agent_workspace_tree', {
      agent_id: AGENT,
      workspace_id: WS,
    })) as { ok: true; tree: { nodes: { path: string }[] } };
    expect(tree1.tree.nodes.map(n => n.path)).toContain('MEMORY.md');

    const read1 = (await fake.sendCommand(HOST, 'agent_workspace_file_read', {
      agent_id: AGENT,
      workspace_id: WS,
      path: 'MEMORY.md',
    })) as { ok: true };
    expect(read1.ok).toBe(true);
  });
});
