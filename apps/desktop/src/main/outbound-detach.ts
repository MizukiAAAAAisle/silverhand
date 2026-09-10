import type { HostClient, HostClientError } from "@silverhand/host";

/**
 * Domain outcome of one `gracefullyDetachOutbound` call. All fields
 * are non-optional so callers can serialise the whole struct into
 * structured logs without conditional checks.
 */
export interface GracefulDetachOutcome {
  /**
   * IPC outcome. `ok: true` means the daemon answered with a
   * domain result (the `action` arm tells us whether there was a
   * client to stop). `ok: false` means the underlying `call()`
   * threw — typically `HostClientError` with codes like `closed`,
   * `shutting_down`, `timeout`, or `internal_error`. Either way
   * the caller continues.
   */
  rpc: { ok: true; action: "detached" | "noop" } | { ok: false; error: string; code?: string };
  /**
   * Registry-cleared verification step.
   *  - `true`  — the backend's `getAttachment(hostId)` returned
   *              `null` within the remaining budget.
   *  - `false` — the budget elapsed before the registry cleared.
   *              The hint may still have landed; main just couldn't
   *              prove it within 1.5s.
   *  - `'skipped'` — no `hostId` provided or no `getAttachment`
   *              accessor available. The degradation path.
   *  - `'error'`   — the `getAttachment` accessor threw (sync probe
   *              or poll tick). Helper stops polling and resolves;
   *              the error message is captured in `registryError`
   *              for the structured-log line. Distinct from
   *              `'skipped'` so main can surface this as a real
   *              "registry observation failure" signal rather than
   *              a benign degradation. (Cindy #task:630 P1-B.)
   */
  registryCleared: boolean | "skipped" | "error";
  /** Populated only when `registryCleared === 'error'`. Plain
   *  string message extracted from whatever the accessor threw;
   *  the helper never propagates the thrown value itself, in
   *  keeping with the never-throws contract. */
  registryError?: string;
  /** Total wall-clock cost of the helper. Always ≤ `budgetMs`. */
  elapsedMs: number;
  /** True iff the helper hit the budget without a terminal poll
   *  observation. Useful as a structured-log "did the optimization
   *  actually pay off" signal. False on both `cleared=true` and
   *  `skipped` paths. */
  budgetExhausted: boolean;
}

/**
 * Inputs to the helper. Dependencies are injectable so tests can
 * drive the full state machine (RPC settle, registry poll, budget
 * exhaustion) without a real daemon, backend, or wall clock.
 */
export interface GracefulDetachDeps {
  /** `HostClient` instance whose `hostOutboundDetach()` we drive. */
  client: Pick<HostClient, "hostOutboundDetach">;
  /**
   * `hostId` of the currently-claimed local host whose attachment
   * we want to observe go null. `null` triggers the degradation
   * path (poll step is skipped, helper resolves on IPC settle).
   *
   * Source of truth: `localHostClaim.hostId` when
   * `localHostClaim.status === 'claimed'`. Any other status (and
   * any `null` hostId) means there is no claimed host to verify
   * cleanup for; the hint is still sent.
   */
  hostId: string | null;
  /**
   * Read accessor over the backend's `HostWsServerController`
   * registry. `undefined` triggers the degradation path. Production
   * wiring: `hostId => backend.context.hostWsController?.()?.getAttachment(hostId) ?? null`.
   * Tests pass a fake that returns successive snapshots.
   *
   * Return-shape contract: the helper only checks `=== null` — it
   * doesn't read any field of the attachment. The accessor signature
   * is therefore intentionally `unknown` rather than the concrete
   * backend attachment shape. Desktop has no import dependency on the backend. Callers should
   * still pass the real attachment row — never abuse the loose
   * return type to fabricate a different sentinel.
   */
  getAttachment?: (hostId: string) => unknown;
  /** Total budget for RPC + poll combined. Default 1500ms — the
   *  Cindy-locked Commit 3 constraint. */
  budgetMs?: number;
  /** Registry poll interval. Default 100ms — small enough that
   *  the verification feels instant, large enough to keep the
   *  poll cost negligible. */
  pollIntervalMs?: number;
  /** Wall-clock supplier. Defaults to `Date.now`. */
  now?: () => number;
  /** Test seam for the budget + poll timers. Defaults to global
   *  `setTimeout` / `clearTimeout`. */
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

/**
 * Send the detach hint and (best-effort) wait for the backend's
 * attachment row to clear, all within `budgetMs`. Never throws.
 * Never rejects. See module header for the strict invariants.
 */
export async function gracefullyDetachOutbound(
  deps: GracefulDetachDeps,
): Promise<GracefulDetachOutcome> {
  const budget = deps.budgetMs ?? 1500;
  const pollInterval = deps.pollIntervalMs ?? 100;
  const now = deps.now ?? (() => Date.now());
  const setT = deps.setTimeoutImpl ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearT =
    deps.clearTimeoutImpl ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const startedAt = now();
  const deadline = startedAt + budget;
  const remaining = (): number => Math.max(0, deadline - now());

  // ── Step 1: RPC bounded by the shared budget ────────────────────
  //
  // The IPC may hang (daemon crashed mid-quit, socket already
  // closed but error pending). Race it against the budget so a
  // pathological RPC can't eat all 1.5s and starve the poll step.
  // On budget-side win the caller still continues — we just report
  // `rpc.ok: false` with a synthetic error.
  const rpcOutcome = await raceRpc(deps.client, remaining, setT, clearT);

  // ── Step 2: optional registry-cleared verification ──────────────
  //
  // Degradation gates: no hostId (unclaimed/revoked/etc — nothing to
  // verify), or no getAttachment accessor (registry not reachable
  // — e.g. embedded backend already torn down). In either case the
  // outcome's `registryCleared` is `'skipped'`, the helper resolves
  // immediately, and the caller continues. The IPC hint alone is
  // still useful: the daemon's WS close will eventually drop the
  // attachment server-side via the normal close-detection path.
  const canPoll = deps.hostId !== null && deps.getAttachment !== undefined;
  if (!canPoll) {
    return finish(rpcOutcome, "skipped", now() - startedAt, false);
  }

  // ── Poll loop ────────────────────────────────────────────────────
  //
  // Synchronous initial probe: the daemon almost always closes the
  // WS before its IPC ack returns. By the time we get here the
  // registry has often already cleared, and an extra `pollInterval`
  // of wait would just bloat shutdown latency for no gain.
  //
  // Every `getAttachment` call goes through `safeProbe` so an
  // accessor that throws (registry implementation bug, partial
  // teardown race) is captured as `registryCleared: 'error'` data
  // rather than rejecting the helper promise. The never-throws
  // contract in this module's header is load-bearing — the caller
  // is `shutdown()` and a reject would terminate the shutdown
  // sequence partway through (Cindy #task:630 P1-B).
  const hostId = deps.hostId!;
  const getAttachment = deps.getAttachment!;
  const safeProbe = (): { ok: true; value: unknown } | { ok: false; error: string } => {
    try {
      return { ok: true, value: getAttachment(hostId) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  const initial = safeProbe();
  if (!initial.ok) {
    return finishWithRegistryError(rpcOutcome, initial.error, now() - startedAt);
  }
  if (initial.value === null) {
    return finish(rpcOutcome, true, now() - startedAt, false);
  }
  if (remaining() === 0) {
    // Budget already gone (RPC took everything). Skip the poll;
    // report budgetExhausted.
    return finish(rpcOutcome, false, now() - startedAt, true);
  }

  return new Promise<GracefulDetachOutcome>((resolve) => {
    let timer: unknown = null;
    const tick = (): void => {
      const probe = safeProbe();
      if (!probe.ok) {
        if (timer !== null) clearT(timer);
        resolve(finishWithRegistryError(rpcOutcome, probe.error, now() - startedAt));
        return;
      }
      if (probe.value === null) {
        if (timer !== null) clearT(timer);
        resolve(finish(rpcOutcome, true, now() - startedAt, false));
        return;
      }
      const left = remaining();
      if (left === 0) {
        if (timer !== null) clearT(timer);
        resolve(finish(rpcOutcome, false, now() - startedAt, true));
        return;
      }
      // Don't overshoot the budget on the last poll — if the
      // remaining time is less than one poll interval, schedule the
      // last tick at the deadline exactly.
      const delay = Math.min(pollInterval, left);
      timer = setT(tick, delay);
    };
    // Schedule first poll one interval out — the synchronous probe
    // above already covered the "already cleared" fast path.
    timer = setT(tick, Math.min(pollInterval, remaining()));
  });
}

/** Internal: race `client.hostOutboundDetach()` against the shared
 *  budget. On timer-side win returns a synthetic `rpc.ok: false`
 *  with a `synthetic_timeout` marker so logs distinguish it from
 *  a real `HostClientError('timeout')`.
 *
 *  Also defends against a synchronous throw from
 *  `client.hostOutboundDetach()` itself: while the production
 *  `HostClient.hostOutboundDetach` always returns a Promise, the
 *  helper accepts any `Pick<HostClient, ...>`-shaped object (test
 *  seams, future remote-client adapters) where a sync throw is
 *  possible. A reject here would break the helper's
 *  never-throws contract (Cindy #task:630 P1-B). */
async function raceRpc(
  client: Pick<HostClient, "hostOutboundDetach">,
  remaining: () => number,
  setT: (cb: () => void, ms: number) => unknown,
  clearT: (h: unknown) => void,
): Promise<GracefulDetachOutcome["rpc"]> {
  const budget = remaining();
  if (budget === 0) {
    // Pathological: budget gone before the RPC even fired. Don't
    // bother dispatching — go straight to a synthetic timeout.
    return { ok: false, error: "budget exhausted before RPC dispatch", code: "synthetic_timeout" };
  }
  // Wrap the sync call so an implementation that throws synchronously
  // (rather than returning a rejecting Promise) maps to the same
  // `rpc.ok: false` data path as an async rejection.
  let rpcThenable: Promise<{ detached: true; action: "detached" | "noop" }>;
  try {
    rpcThenable = client.hostOutboundDetach();
  } catch (err) {
    return rpcErrorFromUnknown(err);
  }
  let timerHandle: unknown = null;
  const rpcPromise = rpcThenable.then(
    (res) => ({ kind: "ok" as const, action: res.action }),
    (err: unknown) => ({ kind: "err" as const, err }),
  );
  const timerPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timerHandle = setT(() => resolve({ kind: "timeout" }), budget);
  });
  const winner = await Promise.race([rpcPromise, timerPromise]);
  if (timerHandle !== null) clearT(timerHandle);
  if (winner.kind === "ok") {
    return { ok: true, action: winner.action };
  }
  if (winner.kind === "timeout") {
    return {
      ok: false,
      error: "RPC did not settle within shutdown budget",
      code: "synthetic_timeout",
    };
  }
  return rpcErrorFromUnknown(winner.err);
}

function rpcErrorFromUnknown(err: unknown): GracefulDetachOutcome["rpc"] {
  if (err instanceof Error) {
    const code =
      typeof (err as HostClientError).code === "string" ? (err as HostClientError).code : undefined;
    return { ok: false, error: err.message, code };
  }
  return { ok: false, error: String(err) };
}

function finishWithRegistryError(
  rpc: GracefulDetachOutcome["rpc"],
  registryError: string,
  elapsedMs: number,
): GracefulDetachOutcome {
  return { rpc, registryCleared: "error", registryError, elapsedMs, budgetExhausted: false };
}

function finish(
  rpc: GracefulDetachOutcome["rpc"],
  registryCleared: GracefulDetachOutcome["registryCleared"],
  elapsedMs: number,
  budgetExhausted: boolean,
): GracefulDetachOutcome {
  return { rpc, registryCleared, elapsedMs, budgetExhausted };
}
