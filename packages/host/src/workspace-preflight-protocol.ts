/** Private one-shot child result discriminator. This is launcher IPC, not part
 * of the daemon/server wire protocol. */
export const WORKSPACE_PREFLIGHT_RESULT_EVENT =
  'workspace_startup_preflight_complete' as const;
