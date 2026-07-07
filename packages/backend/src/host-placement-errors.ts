export type RuntimeHostPlacementErrorCode =
  | 'agent_missing'
  | 'host_mismatch'
  | 'host_missing'
  | 'host_not_owned'
  | 'host_pending_attach'
  | 'host_runtime_disabled'
  | 'host_revoked'
  | 'local_host_unbound'
  // D4.c C1 — typed-fail for the multi-host placement case in
  // standalone mode: user has more than one active local host
  // (e.g. local daemon + sandbox daemon co-resident, or two
  // desktop machines attached to the same remote backend), so the
  // pre-D4.c "most-recently-seen wins" silent-pick is no longer
  // safe. Routes that need a single default placement (e.g. host
  // creation without explicit `host_id`) must surface this so the
  // caller can pick explicitly. Differs from `local_host_unbound`
  // (= zero hosts, user has no daemon) by carrying "you have
  // multiple — pick one" semantics rather than "you have none".
  | 'local_host_ambiguous'
  | 'workspace_missing'
  // D4.a Commit 6 (3) — typed-fail for the narrow case where host
  // placement RESOLVED (a live host record exists, owned, not
  // revoked, runtime not disabled) but the daemon's outbound WS is
  // currently absent / disconnected. Pre-D4.a Commit 6 this fell
  // through `routes.ts` as a generic `c.json({ error: msg }, 400)`
  // with no `code` field, so the renderer couldn't branch on it.
  // The mapping is narrow on purpose (`transport_no_connection` /
  // `transport_disconnected` only); other `HostWsCommandTransportError`
  // codes (`transport_timeout` / `transport_send_failed` /
  // `transport_invalid_command` / `transport_response_mismatch`)
  // are NOT collapsed into this — they have different recovery
  // semantics and stay on the generic 400 fallback. See
  // `mapTransportErrorToPlacement` in `routes.ts` for the gate.
  | 'host_attach_pending';

export class RuntimeHostPlacementError extends Error {
  constructor(
    readonly code: RuntimeHostPlacementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeHostPlacementError';
  }
}
