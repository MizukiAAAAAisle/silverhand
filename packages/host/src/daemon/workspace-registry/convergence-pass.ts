import { join } from 'node:path';
import {
  executeWorkspaceDataConvergence,
  planWorkspaceDataConvergence,
} from './flatten-layout.js';
import type { RegistryBinding } from './registry.js';
import {
  runSessionRenamePass,
  runSessionSlugRepairPass,
  type MigrationLogger,
  type SessionCwdPair,
  type SessionStoreEnv,
} from './session-migration.js';

/**
 * #task:1608 workspace-data convergence — the ONE in-place convergence
 * pass over a computer's workspace-data root: ONE strict plan first
 * (schema, full-binding provenance, case-fold, raw-id safety, directory
 * states — Cindy R4 P0-2), THEN the session cwd renames (old = slot-era
 * slug coordinate, new = flat raw-id coordinate), THEN the execute step
 * consuming that same plan. Desktop's marker catch-up and the connect
 * daemon's startup pass are two composition ENTRIES over this single
 * unit — neither owns a private state machine. Idempotent; every failure
 * is typed (`FlattenLayoutError` / `SessionMigrationError`) and fails
 * closed with bytes preserved — a plan failure means ZERO session
 * renames. Migration inventory: deletes with the required-upgrade floor
 * once no pre-flatten population exists.
 */
export function runWorkspaceDataConvergencePass(opts: {
  workspaceDataRoot: string;
  currentBinding: RegistryBinding;
  sessionStoreHome: string;
  env: SessionStoreEnv;
  logger: MigrationLogger;
}): { renamed: number; status: 'flattened' | 'already_flat' | 'no_namespace' } {
  const { workspaceDataRoot } = opts;
  const plan = planWorkspaceDataConvergence({
    workspaceDataRoot,
    currentBinding: opts.currentBinding,
  });
  const flatWorkspacesRoot = join(workspaceDataRoot, 'workspaces');
  const currentCwds =
    plan.flatFile === null
      ? []
      : Object.entries(plan.flatFile.workspaces).flatMap(([workspaceId, entry]) => {
          const cwd = join(flatWorkspacesRoot, workspaceId);
          return entry.path === cwd ? [cwd] : [];
        });
  let renamed = runSessionSlugRepairPass(currentCwds, {
    sessionStoreHome: opts.sessionStoreHome,
    env: opts.env,
    logger: opts.logger,
  }).renamed;
  if (plan.managed.length > 0) {
    const pairs: SessionCwdPair[] = plan.managed.map(entry => ({
      oldCwd: join(workspaceDataRoot, entry.namespaceName, 'workspaces', entry.legacySlugName),
      newCwd: join(flatWorkspacesRoot, entry.workspaceId),
    }));
    renamed += runSessionRenamePass(pairs, {
      sessionStoreHome: opts.sessionStoreHome,
      env: opts.env,
      logger: opts.logger,
    }).renamed;
  }
  const outcome = executeWorkspaceDataConvergence(plan, {
    workspaceDataRoot,
    logger: opts.logger,
  });
  if (outcome.status === 'flattened') {
    opts.logger.info(
      { action: 'workspace_data_convergence_completed', renamed },
      'workspace-data converged to the flat raw-id layout',
    );
  }
  return { renamed, status: outcome.status };
}
