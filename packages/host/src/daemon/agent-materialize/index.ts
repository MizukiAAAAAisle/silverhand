/**
 * D4.d D2: public barrel for the daemon-side `agent_materialize`
 * handler. Imports from this barrel are limited to daemon-owned
 * code (`packages/host/src/daemon/**`); the
 * `import-boundary.test.ts` tripwire forbids `packages/backend/**`
 * from reaching anywhere under this directory.
 */
export {
  AgentMaterializeError,
  computeAgentDir,
  materializeAgent,
  type MaterializeAgentDeps,
} from './handler.js';
export {
  AGENT_HOME_SENTINEL_FILENAME,
  AGENT_HOME_TEMPLATE_VERSION,
  getAgentHomeTemplate,
  type AgentHomeTemplate,
  type AgentHomeTemplateFile,
} from './template.js';
export {
  AgentHomeSentinelSchema,
  compareSentinel,
  readSentinel,
  sentinelPath,
  writeSentinelAtomic,
  type AgentHomeSentinel,
  type ReadSentinelResult,
  type SentinelMatchInput,
  type SentinelMatchResult,
} from './sentinel.js';
