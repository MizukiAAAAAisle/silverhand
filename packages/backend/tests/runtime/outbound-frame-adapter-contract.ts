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
