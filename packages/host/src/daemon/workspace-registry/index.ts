export {
  WorkspaceRegistry,
  WorkspaceRegistryError,
  REGISTRY_SCHEMA_VERSION,
  bindingSlug,
  managedWorkspaceSlug,
  type RegistryBinding,
  type WorkspaceRegistryErrorCode,
  type WorkspaceRegistryEntry,
  type WorkspaceRegistryOptions,
  type ProvisionResult,
} from './registry.js';
export {
  WorkspaceProvisionError,
  provisionWorkspace,
  type ProvisionWorkspaceDeps,
} from './provision-handler.js';
export {
  AgentWorkspaceIndexError,
  indexAgentWorkspaces,
  type IndexAgentWorkspacesDeps,
} from './index-handler.js';
export {
  AgentL2SeedError,
  seedAgentL2,
  type SeedAgentL2Deps,
} from './l2-seed-handler.js';
export { mapFsErrno, type FsErrnoCode } from './fs-errno.js';
export {
  WORKSPACE_CONSENSUS_DEFAULT,
  initWorkspaceSkeleton,
} from './workspace-skeleton.js';
