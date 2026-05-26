export type RuntimeHostPlacementErrorCode =
  | 'agent_missing'
  | 'host_mismatch'
  | 'host_missing'
  | 'host_not_owned'
  | 'host_runtime_disabled'
  | 'host_revoked'
  | 'local_host_unbound'
  | 'workspace_missing';

export class RuntimeHostPlacementError extends Error {
  constructor(
    readonly code: RuntimeHostPlacementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeHostPlacementError';
  }
}
