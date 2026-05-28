export type RuntimeHostPlacementErrorCode =
  | 'agent_missing'
  | 'host_mismatch'
  | 'host_missing'
  | 'host_not_owned'
  | 'host_runtime_disabled'
  | 'host_revoked'
  | 'local_host_unbound'
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
