import { HostClientError, type HostClient } from "@silverhand/host";

export type WaitForDaemonGenerationResult =
  | { ok: true }
  | { ok: false; reason: "timeout" | "client_closed" | "connect_failed"; error?: Error };

export function waitForDaemonGeneration(
  client: HostClient,
  expectedInstanceId: string,
): Promise<WaitForDaemonGenerationResult> {
  return new Promise<WaitForDaemonGenerationResult>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;

    const settle = (result: WaitForDaemonGenerationResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(result);
    };

    // Arm deadline FIRST so a stuck `client.connect()` (HostClient's
    // own reconnect loop wedged on, say, EAGAIN-forever) cannot bypass
    // the hard deadline. Pre-this-fix the timer only armed after
    // connect() resolved, defeating the helper's own contract.
    const timer = setTimeout(() => {
      settle({ ok: false, reason: "timeout" });
    }, 5_000);
    timer.unref?.();

    // Subscribe to reconnect BEFORE kicking connect() so any
    // reconnect event that fires during the connect path itself is
    // observed. `onReconnect` fires AFTER the hello handshake lands,
    // so `negotiated` is populated when our callback runs.
    unsubscribe = client.onReconnect(() => {
      if (settled) return;
      if (client.negotiated?.instanceId === expectedInstanceId) {
        settle({ ok: true });
      }
      // Mismatch (transient old-generation reconnect, or a third
      // generation jumped in front) → keep waiting until either the
      // expected generation arrives or the timer fires.
    });

    // Fast path: already on the target generation. Check AFTER
    // subscribing + arming the timer so we never resolve through a
    // path that leaves cleanup work pending.
    if (client.negotiated?.instanceId === expectedInstanceId) {
      settle({ ok: true });
      return;
    }

    // Kick connect() in the background. We do NOT await it here —
    // settle decisions come from (a) the timer, (b) the reconnect
    // handler observing a matching negotiated identity, or (c) an
    // immediate connect failure (network missing / client closed).
    // A connect() that simply never resolves (stuck reconnect loop)
    // is correctly handled by the timer.
    client.connect().then(
      () => {
        // After connect resolves, re-check the negotiated identity:
        // the handshake may have landed on the expected generation
        // before `onReconnect` had a chance to fire (initial-connect
        // path doesn't go through `onReconnect`).
        if (settled) return;
        if (client.negotiated?.instanceId === expectedInstanceId) {
          settle({ ok: true });
        }
        // Otherwise keep waiting on reconnect / timer.
      },
      (err) => {
        if (settled) return;
        const reason =
          err instanceof HostClientError && err.code === "closed"
            ? "client_closed"
            : "connect_failed";
        settle({ ok: false, reason, error: err as Error });
      },
    );
  });
}
