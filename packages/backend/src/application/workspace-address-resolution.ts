import {
  parseWorkspaceAddressSegment,
  type CanonicalWorkspaceName,
  type WorkspaceDto,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import { logWorkspaceAddressResolution } from '../observability/workspace-address-log.js';
import type {
  DeliveryTargetRootResolution,
  DeliveryTargetWorkspacesPort,
} from './delivery-target-resolution.js';

export type WorkspaceAddressResolution =
  | { readonly kind: 'found'; readonly workspace: WorkspaceDto }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'ambiguous' };

/** Auth-independent workspace root lookup. Authorization is intentionally a
 * later resolver layer: this function resolves only the current REGULAR name
 * namespace and never considers agent_home. */
export function resolveRegularWorkspaceAddress(
  deps: { workspaces: WorkspaceRepo; logger: BackendLogger },
  segment: string,
): WorkspaceAddressResolution {
  const name = parseWorkspaceAddressSegment(segment);
  if (name === null) {
    logWorkspaceAddressResolution(deps.logger, { outcome: 'unresolved', key: null, matches: 0 });
    return { kind: 'unresolved' };
  }
  return resolveRegularWorkspaceName(deps, name);
}

/**
 * The same lookup for a caller that ALREADY parsed the segment — a whole address
 * token, for instance, where the root segment cannot be parsed independently of
 * the rest (#task:2021 P4-4).
 *
 * Split out rather than made the only entry point so the segment-taking form keeps
 * owning its own "not a segment at all" log line, and so neither caller can end up
 * looking a key up that a different parse produced.
 */
export function resolveRegularWorkspaceName(
  deps: { workspaces: WorkspaceRepo; logger: BackendLogger },
  name: CanonicalWorkspaceName,
): WorkspaceAddressResolution {
  const matches = deps.workspaces.listRegularByNameKey(name.key);
  if (matches.length === 1) return { kind: 'found', workspace: matches[0]! };
  const kind = matches.length === 0 ? 'unresolved' : 'ambiguous';
  logWorkspaceAddressResolution(deps.logger, { outcome: kind, key: name.key, matches: matches.length });
  return { kind };
}

/**
 * How THIS authority satisfies the delivery-target root port — the adapter lives
 * with the authority, so a surface assembling `DeliveryTargetPorts` cannot bring
 * its own workspace lookup instead (#task:2021 P4-4).
 *
 * Narrows the DTO to the id on purpose: an address resolver has no business with
 * a workspace's description, kind or timestamps, and passing the DTO through would
 * let a later rule there start reading them.
 */
export function deliveryTargetWorkspacesPort(deps: {
  workspaces: WorkspaceRepo;
  logger: BackendLogger;
}): DeliveryTargetWorkspacesPort {
  return {
    resolveRegularRoot: (name): DeliveryTargetRootResolution => {
      const resolved = resolveRegularWorkspaceName(deps, name);
      return resolved.kind === 'found'
        ? { kind: 'found', workspaceId: resolved.workspace.id }
        : { kind: resolved.kind };
    },
  };
}
