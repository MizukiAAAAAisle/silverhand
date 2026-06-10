/**
 * #task:811 — daemon handlers for the agent home workspace tree+read
 * pair. Generic two-protocol surface (tree + per-file read by virtual
 * path); see `packages/shared/src/api/agent.ts` for the wire contract.
 *
 * Boundary mirrors the rest of the daemon-owned file modules: only
 * code under `packages/host/src/daemon/**` may import from this barrel
 * (the `import-boundary.test.ts` tripwire enforces it).
 */
export { AgentWorkspaceFsError } from './error.js';
export {
  listAgentWorkspaceTree,
  type ListAgentWorkspaceTreeDeps,
} from './tree.js';
export {
  readAgentWorkspaceFile,
  type ReadAgentWorkspaceFileDeps,
} from './read-file.js';
export {
  parseAndResolveVirtualPath,
  resolveAgentHomeBase,
  resolveValidatedSegments,
  validateVirtualPathShape,
  isAllowedSegmentName,
  type ParseAndResolveVirtualPathResult,
  type ResolveAgentHomeBaseResult,
} from './parse-virtual-path.js';
