/**
 * D3.b Commit 1 fix (Cindy `#task:627` P1) — generation-aware
 * HostClient readiness gate for the daemon-respawn re-attach path.
 *
 * Why this is its own module: the spawned-daemon supervisor in
 * `@silverhand/host` reports "a new daemon generation just handshook"
 * via `onDaemonGenerationChanged({ instanceId, ... })`. Before main
 * fires `host_outbound_attach` against that new daemon, the local
 * `HostClient`'s underlying transport must actually be talking TO
 * that same generation — not still draining writes to the dead old
 * socket and not racing into yet another reconnect.
 *
 * `HostClient.connect()` alone does NOT give us that guarantee:
 *   - It is idempotent on `connectAttempted` and returns the prior
 *     readyPromise if a connect attempt has ever succeeded, even when
 *     the live transport is currently between reconnect cycles.
 *   - It has no view of the daemon-side `instance_id`; only
 *     `client.negotiated.instanceId` (set when the hello handshake
 *     lands on a transport) gives that.
 *
 * Without this gate, `host_outbound_attach` can be fired into a
 * write that the supervisor logs as a "warning, no auto-retry"
 * (Cindy `#task:627` P1-A), or accept a wrong-generation transport
 * whose freshness window doesn't match the daemon we meant to attach.
 *
 * The contract is narrow on purpose:
 *   - Inputs: a HostClient, an expected `instanceId`, a timeout.
 *   - Output: resolves once `client.negotiated?.instanceId` matches;
 *     rejects on `timeout` or a client `close()`.
 *   - Does NOT trigger any reconnect itself — it observes the
 *     client's own reconnect loop via `onReconnect`. The supervisor
 *     adapter (R1/R4) framing applies: this is local-supervisor
 *     glue, not a server↔daemon protocol step.
 */
import type { HostClient } from '@silverhand/host';

export interface WaitForDaemonGenerationOptions {
  /** Hard deadline for the wait, in ms. Default 5000. The supervisor's
   *  attach-watchdog has its own freshness budget (5s by default); this
   *  gate is upstream of that, so it should resolve well within. */
  timeoutMs?: number;
  /** Test seam — defaults to `setTimeout` + `clearTimeout`. Tests use
   *  a fake clock so the timeout case is deterministic. */
  setTimer?: (cb: () => void, ms: number) => { clear(): void };
}

export type WaitForDaemonGenerationResult =
  | { ok: true }
  | { ok: false; reason: 'timeout' | 'client_closed' | 'connect_failed'; error?: Error };

export async function waitForDaemonGeneration(
  client: HostClient,
  expectedInstanceId: string,
  opts: WaitForDaemonGenerationOptions = {},
): Promise<WaitForDaemonGenerationResult> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const setTimer = opts.setTimer ?? defaultSetTimer;

  // Step 1: make sure the client has at least *tried* to connect. This
  // is idempotent — after the initial main-bootstrap connect, this is
  // a no-op that returns the prior readyPromise.
  try {
    await client.connect();
  } catch (err) {
    return { ok: false, reason: 'connect_failed', error: err as Error };
  }

  // Step 2: if we're already talking to the expected generation, done.
  if (client.negotiated?.instanceId === expectedInstanceId) {
    return { ok: true };
  }

  // Step 3: subscribe to reconnect events and re-check on each. The
  // supervisor's own reconnect loop drives the actual transport
  // recovery; we just gate the attach trigger on it.
  return new Promise<WaitForDaemonGenerationResult>(resolve => {
    let settled = false;
    const settle = (result: WaitForDaemonGenerationResult): void => {
      if (settled) return;
      settled = true;
      timer.clear();
      unsubscribe();
      resolve(result);
    };
    const timer = setTimer(() => {
      settle({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    const unsubscribe = client.onReconnect(() => {
      // `onReconnect` fires AFTER the transport's hello handshake
      // succeeds, so `client.negotiated` is populated.
      if (client.negotiated?.instanceId === expectedInstanceId) {
        settle({ ok: true });
      }
      // Mismatch (a transient old-generation reconnect, or a third
      // generation jumped in front) → keep waiting until either
      // expected generation arrives or timer fires.
    });
  });
}

function defaultSetTimer(cb: () => void, ms: number): { clear(): void } {
  const t = setTimeout(cb, ms);
  t.unref?.();
  return { clear: () => clearTimeout(t) };
}
