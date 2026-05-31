import { afterEach, describe, expect, it } from 'vitest';
import type { OutboundFrameAdapter } from '../../src/runtime/outbound-frame-adapter.js';

/**
 * D5.a — transport-agnostic contract for {@link OutboundFrameAdapter}.
 *
 * The whole point of D5.a is that embedded and standalone carry the SAME
 * outbound frame envelope over different transports. This harness encodes
 * that "same" as an executable contract: every adapter implementation
 * runs the identical cases, against its OWN real transport — no faked
 * adapter, no stubbed dispatch.
 *
 * - D5.a-1 runs it against {@link StandaloneOutboundFrameAdapter} wired
 *   over a real `HostWsServerController` + a real (raw-WS) fake daemon.
 * - D5.a-2 runs it against the embedded local-Unix adapter wired over a
 *   real `LocalOutboundFrameServer`.
 *
 * The fixture abstracts only the *topology* difference (who connects to
 * whom): both expose "send a command from the backend; the daemon side
 * receives it and answers / drops". The assertions never mention the
 * transport.
 */

/** One command frame as the daemon side observes it. */
export interface FakeDaemonCommand {
  id: string;
  kind: string;
  params: unknown;
}

/** The daemon end of one live connection, scripted by the test. */
export interface FakeDaemonConnection {
  /** Connection id the backend minted for this attachment. */
  readonly connectionId: string;
  /** Resolve with the next command frame the backend dispatched. */
  nextCommand(): Promise<FakeDaemonCommand>;
  /** Answer a pending command with a success result. */
  respondResult(id: string, kind: string, result: unknown): void;
  /** Answer a pending command with a per-command wire error. */
  respondError(
    id: string,
    kind: string,
    error: { code: string; message: string },
  ): void;
  /** Drop the connection (simulates the daemon going away mid-command). */
  disconnect(): Promise<void>;
}

export interface OutboundFrameAdapterFixture {
  readonly adapter: OutboundFrameAdapter;
  /** The local host id the adapter routes to. */
  readonly hostId: string;
  /** A host id with no live connection — used for negative cases. */
  readonly unconnectedHostId: string;
  /** Establish one live daemon connection over the fixture's transport. */
  connectDaemon(): Promise<FakeDaemonConnection>;
  cleanup(): Promise<void>;
}

/**
 * Run the shared adapter contract. `makeFixture` must return a fixture
 * backed by a REAL transport for the implementation under test.
 */
export function runOutboundFrameAdapterContract(
  label: string,
  makeFixture: () => Promise<OutboundFrameAdapterFixture>,
): void {
  describe(`OutboundFrameAdapter contract — ${label}`, () => {
    let fx: OutboundFrameAdapterFixture | null = null;

    afterEach(async () => {
      await fx?.cleanup();
      fx = null;
    });

    it('round-trips runtime_status command → correlated response', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'runtime_status',
        { conversation_id: 'c1', agent_id: 'a1' },
        { timeoutMs: 500 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('runtime_status');
      expect(cmd.params).toMatchObject({ conversation_id: 'c1', agent_id: 'a1' });

      daemon.respondResult(cmd.id, 'runtime_status', {
        runtimes: [
          {
            conversation_id: 'c1',
            agent_id: 'a1',
            pid: null,
            phase: 'idle',
            run_state: null,
            started_at: null,
          },
        ],
      });

      await expect(pending).resolves.toMatchObject({
        runtimes: [{ agent_id: 'a1' }],
      });
    });

    it('rejects an unconnected host with transport_no_connection before any frame leaves', async () => {
      fx = await makeFixture();
      // No daemon connected yet for this host.
      await expect(
        fx.adapter.sendCommand(fx.unconnectedHostId, 'runtime_status', {
          conversation_id: 'c1',
          agent_id: 'a1',
        }),
      ).rejects.toMatchObject({ code: 'transport_no_connection' });
    });

    it('rejects malformed runtime_start params with transport_invalid_command before send', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      // `runtime_start` requires a fully-formed `options` object; an empty
      // payload must be caught by the schema gate BEFORE bytes hit the
      // wire — the daemon must never observe a command frame.
      await expect(
        fx.adapter.sendCommand(
          fx.hostId,
          'runtime_start',
          { conversation_id: 'c1', agent_id: 'a1' } as never,
          { timeoutMs: 500 },
        ),
      ).rejects.toMatchObject({ code: 'transport_invalid_command' });

      await expect(daemon.nextCommand()).rejects.toThrow(/no command/i);
    });

    it('surfaces an agent_materialize typed wire error with its code intact', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'agent_materialize',
        agentMaterializeParams(),
        { timeoutMs: 500 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('agent_materialize');

      daemon.respondError(cmd.id, 'agent_materialize', {
        code: 'agent_dir_collision',
        message: 'agent home already exists',
      });

      // The typed daemon-business code rides the same envelope end to end
      // and is NOT collapsed into a transport_* error.
      await expect(pending).rejects.toMatchObject({
        code: 'agent_dir_collision',
      });
    });

    // ── D4.e-1 ④/A3 — registry intents over the SAME envelope ────────────
    // `workspace_provision` and `agent_workspace_index` are the D4.e-1
    // additions. Both transports must round-trip their params/result AND
    // honour per-command error scoping exactly like agent_materialize: a
    // legal typed code rides through; a foreign code (one another command
    // declares) is refused at the schema boundary, never surfaced.

    it('round-trips workspace_provision command → bound-path result', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'workspace_provision',
        { workspace_id: 'ws-1', kind: 'regular', requested_path: '/tmp/ws-1' },
        { timeoutMs: 500 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('workspace_provision');
      expect(cmd.params).toMatchObject({
        workspace_id: 'ws-1',
        kind: 'regular',
        requested_path: '/tmp/ws-1',
      });

      daemon.respondResult(cmd.id, 'workspace_provision', {
        ok: true,
        provisioned: true,
        bound_workspace_path: '/tmp/ws-1',
      });

      await expect(pending).resolves.toMatchObject({
        provisioned: true,
        bound_workspace_path: '/tmp/ws-1',
      });
    });

    it('passes through a legal workspace_provision typed error (path_conflict) with its code intact', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'workspace_provision',
        { workspace_id: 'ws-1', kind: 'regular', requested_path: '/tmp/other' },
        { timeoutMs: 500 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('workspace_provision');

      // `path_conflict` is declared by `workspace_provision`'s error arm — it
      // rides the envelope and is NOT collapsed into a transport_* error.
      daemon.respondError(cmd.id, 'workspace_provision', {
        code: 'path_conflict',
        message: 'workspace already bound to a different path',
      });

      await expect(pending).rejects.toMatchObject({ code: 'path_conflict' });
    });

    it('refuses a foreign typed error code on workspace_provision', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'workspace_provision',
        { workspace_id: 'ws-1', kind: 'regular', requested_path: '/tmp/ws-1' },
        { timeoutMs: 1000 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('workspace_provision');

      // `agent_dir_collision` belongs to `agent_materialize`, not
      // `workspace_provision`. A response carrying it is an INVALID frame for
      // this command: reject at the schema boundary, drop, surface a
      // transport error — never the foreign code.
      daemon.respondError(cmd.id, 'workspace_provision', {
        code: 'agent_dir_collision',
        message: 'foreign code must not be accepted on workspace_provision',
      });

      let err: { code?: string } | null = null;
      try {
        await pending;
      } catch (e) {
        err = e as { code?: string };
      }
      expect(err).not.toBeNull();
      expect(err!.code).not.toBe('agent_dir_collision');
      expect(err!.code).toBe('transport_disconnected');
    });

    it('round-trips agent_workspace_index command → entries + unresolved result', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'agent_workspace_index',
        { agent_id: 'a1', workspace_ids: ['ws-1', 'ws-2'] },
        { timeoutMs: 500 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('agent_workspace_index');
      expect(cmd.params).toMatchObject({
        agent_id: 'a1',
        workspace_ids: ['ws-1', 'ws-2'],
      });

      daemon.respondResult(cmd.id, 'agent_workspace_index', {
        ok: true,
        entries: [
          { workspace_id: 'ws-1', agent_dir: '/tmp/ws-1/.silverhand/agents/a1' },
        ],
        unresolved: ['ws-2'],
      });

      await expect(pending).resolves.toMatchObject({
        entries: [
          { workspace_id: 'ws-1', agent_dir: '/tmp/ws-1/.silverhand/agents/a1' },
        ],
        unresolved: ['ws-2'],
      });
    });

    it('passes through a legal agent_workspace_index typed error (registry_unavailable) with its code intact', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'agent_workspace_index',
        { agent_id: 'a1', workspace_ids: ['ws-1'] },
        { timeoutMs: 500 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('agent_workspace_index');

      // `registry_unavailable` is a whole-registry failure declared by
      // `agent_workspace_index` — rides the envelope, code intact.
      daemon.respondError(cmd.id, 'agent_workspace_index', {
        code: 'registry_unavailable',
        message: 'registry temporarily unavailable',
      });

      await expect(pending).rejects.toMatchObject({
        code: 'registry_unavailable',
      });
    });

    it('refuses a foreign typed error code on agent_workspace_index', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'agent_workspace_index',
        { agent_id: 'a1', workspace_ids: ['ws-1'] },
        { timeoutMs: 1000 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('agent_workspace_index');

      // `path_conflict` is a `workspace_provision` code, not declared by
      // `agent_workspace_index` (which scopes only whole-registry failures +
      // generic transport codes). It must be refused, not surfaced.
      daemon.respondError(cmd.id, 'agent_workspace_index', {
        code: 'path_conflict',
        message: 'foreign code must not be accepted on agent_workspace_index',
      });

      let err: { code?: string } | null = null;
      try {
        await pending;
      } catch (e) {
        err = e as { code?: string };
      }
      expect(err).not.toBeNull();
      expect(err!.code).not.toBe('path_conflict');
      expect(err!.code).toBe('transport_disconnected');
    });

    // ── D4.e-2 / A3 — read proxy over the SAME envelope ──────────────────
    // `agent_workspace_read` is the D4.e-2 host-local L1 read. It must
    // round-trip its `{ agent_id }` param + `AgentWorkspaceDto` result and
    // honour per-command error scoping: its own `fs_unavailable` rides the
    // envelope; a foreign code (another command's) is refused at the schema
    // boundary, never surfaced.

    it('round-trips agent_workspace_read command → workspace DTO result', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'agent_workspace_read',
        { agent_id: 'a1' },
        { timeoutMs: 500 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('agent_workspace_read');
      // The backend forwards a semantic id ONLY — no path crosses the wire.
      expect(cmd.params).toEqual({ agent_id: 'a1' });

      daemon.respondResult(cmd.id, 'agent_workspace_read', {
        ok: true,
        workspace: {
          l1_path: '/home/u/.silverhand/agents/a1',
          system_prompt: {
            path: '/home/u/.silverhand/agents/a1/system_prompt.md',
            size: 5,
            mtime: 1000,
            content: 'hello',
            truncated: false,
          },
          memory: null,
          notes: [],
        },
      });

      await expect(pending).resolves.toMatchObject({
        workspace: { l1_path: '/home/u/.silverhand/agents/a1' },
      });
    });

    it('passes through a legal agent_workspace_read typed error (fs_unavailable) with its code intact', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'agent_workspace_read',
        { agent_id: 'a1' },
        { timeoutMs: 500 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('agent_workspace_read');

      // `fs_unavailable` is declared by `agent_workspace_read`'s error arm —
      // it rides the envelope and is NOT collapsed into a transport_* error.
      daemon.respondError(cmd.id, 'agent_workspace_read', {
        code: 'fs_unavailable',
        message: 'host-local read failed: EACCES',
      });

      await expect(pending).rejects.toMatchObject({ code: 'fs_unavailable' });
    });

    it('refuses a foreign typed error code on agent_workspace_read', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'agent_workspace_read',
        { agent_id: 'a1' },
        { timeoutMs: 1000 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('agent_workspace_read');

      // `path_conflict` is a `workspace_provision` code, not declared by
      // `agent_workspace_read` (which scopes only `fs_unavailable` /
      // `internal_error` + generic transport codes). It must be refused.
      daemon.respondError(cmd.id, 'agent_workspace_read', {
        code: 'path_conflict',
        message: 'foreign code must not be accepted on agent_workspace_read',
      });

      let err: { code?: string } | null = null;
      try {
        await pending;
      } catch (e) {
        err = e as { code?: string };
      }
      expect(err).not.toBeNull();
      expect(err!.code).not.toBe('path_conflict');
      expect(err!.code).toBe('transport_disconnected');
    });

    // ── D4.e-3 / A3 — L2 seed over the SAME envelope ─────────────────────
    // `agent_l2_seed` is the D4.e-3 member-add L2 seeder. It must round-trip
    // its `{ agent_id, workspace_id, template_choice }` param + `{ seeded,
    // l2_present }` result, and honour per-command error scoping: its own
    // `workspace_not_provisioned` rides the envelope; a foreign code is refused.

    it('round-trips agent_l2_seed command → seeded result', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'agent_l2_seed',
        { agent_id: 'a1', workspace_id: 'ws_1', template_choice: 'default' },
        { timeoutMs: 500 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('agent_l2_seed');
      // The backend forwards semantic ids ONLY — no path crosses the wire.
      expect(cmd.params).toEqual({
        agent_id: 'a1',
        workspace_id: 'ws_1',
        template_choice: 'default',
      });

      daemon.respondResult(cmd.id, 'agent_l2_seed', {
        ok: true,
        seeded: true,
        l2_present: true,
      });

      await expect(pending).resolves.toMatchObject({
        seeded: true,
        l2_present: true,
      });
    });

    it('passes through a legal agent_l2_seed typed error (workspace_not_provisioned) with its code intact', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'agent_l2_seed',
        { agent_id: 'a1', workspace_id: 'ws_unbound', template_choice: 'default' },
        { timeoutMs: 500 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('agent_l2_seed');

      // `workspace_not_provisioned` is declared by `agent_l2_seed`'s error arm —
      // it rides the envelope and is NOT collapsed into a transport_* error.
      daemon.respondError(cmd.id, 'agent_l2_seed', {
        code: 'workspace_not_provisioned',
        message: 'workspace ws_unbound is not provisioned',
      });

      await expect(pending).rejects.toMatchObject({
        code: 'workspace_not_provisioned',
      });
    });

    it('refuses a foreign typed error code on agent_l2_seed', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'agent_l2_seed',
        { agent_id: 'a1', workspace_id: 'ws_1', template_choice: 'default' },
        { timeoutMs: 1000 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('agent_l2_seed');

      // `path_conflict` is a `workspace_provision` code, not declared by
      // `agent_l2_seed`. It must be refused at the schema boundary.
      daemon.respondError(cmd.id, 'agent_l2_seed', {
        code: 'path_conflict',
        message: 'foreign code must not be accepted on agent_l2_seed',
      });

      let err: { code?: string } | null = null;
      try {
        await pending;
      } catch (e) {
        err = e as { code?: string };
      }
      expect(err).not.toBeNull();
      expect(err!.code).not.toBe('path_conflict');
      expect(err!.code).toBe('transport_disconnected');
    });

    // `agent_files_purge` is the D4.e-4 delete-path purger. It must round-trip
    // its `{ agent_id, scope, workspace_ids }` param + `{ purged_count,
    // skipped_unprovisioned }` result, and honour per-command error scoping:
    // its own `partial_purge` rides the envelope; a foreign code is refused.

    it('round-trips agent_files_purge command → purged result', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'agent_files_purge',
        { agent_id: 'a1', scope: 'all', workspace_ids: ['ws_1', 'ws_2'] },
        { timeoutMs: 500 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('agent_files_purge');
      // The backend forwards semantic ids + scope ONLY — no path crosses the wire.
      expect(cmd.params).toEqual({
        agent_id: 'a1',
        scope: 'all',
        workspace_ids: ['ws_1', 'ws_2'],
      });

      daemon.respondResult(cmd.id, 'agent_files_purge', {
        ok: true,
        purged_count: 3,
        skipped_unprovisioned: 0,
      });

      await expect(pending).resolves.toMatchObject({
        purged_count: 3,
        skipped_unprovisioned: 0,
      });
    });

    it('passes through a legal agent_files_purge typed error (partial_purge) with its code intact', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'agent_files_purge',
        { agent_id: 'a1', scope: 'all', workspace_ids: ['ws_1'] },
        { timeoutMs: 500 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('agent_files_purge');

      // `partial_purge` is declared by `agent_files_purge`'s error arm — it
      // rides the envelope and is NOT collapsed into a transport_* error.
      daemon.respondError(cmd.id, 'agent_files_purge', {
        code: 'partial_purge',
        message: 'failed to remove 1 target(s)',
      });

      await expect(pending).rejects.toMatchObject({
        code: 'partial_purge',
      });
    });

    it('refuses a foreign typed error code on agent_files_purge', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'agent_files_purge',
        { agent_id: 'a1', scope: 'all', workspace_ids: ['ws_1'] },
        { timeoutMs: 1000 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('agent_files_purge');

      // `unsupported_template` is an `agent_l2_seed` code, not declared by
      // `agent_files_purge`. It must be refused at the schema boundary.
      daemon.respondError(cmd.id, 'agent_files_purge', {
        code: 'unsupported_template',
        message: 'foreign code must not be accepted on agent_files_purge',
      });

      let err: { code?: string } | null = null;
      try {
        await pending;
      } catch (e) {
        err = e as { code?: string };
      }
      expect(err).not.toBeNull();
      expect(err!.code).not.toBe('unsupported_template');
      expect(err!.code).toBe('transport_disconnected');
    });

    it('refuses a foreign typed error code on a command that does not declare it', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'runtime_status',
        { conversation_id: 'c1', agent_id: 'a1' },
        { timeoutMs: 1000 },
      );
      const cmd = await daemon.nextCommand();
      expect(cmd.kind).toBe('runtime_status');

      // `agent_dir_collision` is scoped to `agent_materialize`'s error
      // arm; `runtime_status` declares only the 5 generic transport
      // codes. A response carrying the foreign code is an INVALID frame
      // for this command. The adapter must reject the response at the
      // schema boundary — never surface the foreign code as if it were a
      // valid runtime_status error. That is the exact "globally widened
      // error union" failure mode hardened in D4.d D1/D2: an embedded
      // adapter (D5.a-2) that parses errors with a loose `z.string()`
      // would PASS the positive case above yet FAIL here, which is why
      // this pin lives in the shared contract, not a standalone-only test.
      daemon.respondError(cmd.id, 'runtime_status', {
        code: 'agent_dir_collision',
        message: 'foreign code must not be accepted on runtime_status',
      });

      let err: { code?: string } | null = null;
      try {
        await pending;
      } catch (e) {
        err = e as { code?: string };
      }
      expect(err).not.toBeNull();
      // Core invariant: the foreign typed code is rejected, not surfaced.
      expect(err!.code).not.toBe('agent_dir_collision');
      // Same-shape across transports: an invalid response frame is a
      // protocol violation; the connection drops and the pending command
      // fails as a transport error (WSS protocol-closes → the in-flight
      // command rejects `transport_disconnected`). D5.a-2's embedded
      // adapter must reproduce this exact code.
      expect(err!.code).toBe('transport_disconnected');
    });

    it('rejects a pending command with transport_disconnected when the daemon drops', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();

      const pending = fx.adapter.sendCommand(
        fx.hostId,
        'runtime_status',
        { conversation_id: 'c1', agent_id: 'a1' },
        { timeoutMs: 1000 },
      );
      // Attach the rejection expectation BEFORE dropping the connection.
      // A local Unix transport tears down synchronously, so the pending
      // command can reject inside `disconnect()` — before a
      // post-disconnect assertion would attach — surfacing a transient
      // unhandled rejection. Capturing the assertion first makes the
      // contract robust across fast and slow transports.
      const settled = expect(pending).rejects.toMatchObject({
        code: 'transport_disconnected',
      });
      await daemon.nextCommand();
      await daemon.disconnect();
      await settled;
    });

    it('fails fast when expectedConnectionId no longer matches the live connection', async () => {
      fx = await makeFixture();
      const daemon = await fx.connectDaemon();
      expect(daemon.connectionId).toBe(
        fx.adapter.connectionIdForHost(fx.hostId),
      );

      await expect(
        fx.adapter.sendCommand(
          fx.hostId,
          'runtime_status',
          { conversation_id: 'c1', agent_id: 'a1' },
          {
            timeoutMs: 500,
            expectedConnectionId: `${daemon.connectionId}-stale`,
          },
        ),
      ).rejects.toMatchObject({ code: 'transport_disconnected' });
    });
  });
}

/** Minimal well-formed `agent_materialize` params for the typed-error case.
 * Must satisfy the `.strict()` schema so it clears the transport's
 * invalid-command gate and actually reaches the daemon to be answered. */
function agentMaterializeParams(): never {
  return {
    agent_id: 'a-new',
    agent_home_workspace_id: 'wsah_a-new',
    name: 'new-agent',
    runtime: 'claude',
    template_choice: 'default',
  } as never;
}
