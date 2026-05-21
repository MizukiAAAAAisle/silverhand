/**
 * Backend-side driver facade.
 *
 * PR-2 step 2 commit 2 (Cindy `vqDWkLFF6pAeIE5t`): runtime Driver
 * implementations moved to `@silverhand/host`; this module keeps the
 * prompt assembly side that depends on backend types and adds a
 * `buildSystemPromptFor(kind, ctx)` helper so backend code can build
 * the system prompt text without depending on the per-driver class.
 *
 * The split rule:
 *  - Host owns: `Driver` interface, per-kind classes, `getDriver`,
 *    `hasDriver`, `DriverSpawnContext`, `DriverIO`. See
 *    `packages/host/src/drivers/index.ts`.
 *  - Backend owns: `buildPlatformPrompt`, `DriverPromptContext`,
 *    `InjectedFileContent`, `SessionContextInput`,
 *    `WorkspaceMemoryIndexEntry`. Lives in `platform-prompt.ts`.
 *
 * Re-exports of the host types live here as a transitional surface so
 * existing imports (`from './drivers/index.js'`) keep working through
 * the migration. Commit 5 cleanup may collapse this once call sites
 * settle.
 */
import type { RuntimeKind } from '@silverhand/shared';

import {
  buildPlatformPrompt,
  type InjectedFileContent,
  type SessionContextInput,
  type WorkspaceMemoryIndexEntry,
} from './platform-prompt.js';

// ── Host re-exports (execution plane) ──────────────────────────────
export type {
  Driver,
  DriverIO,
  DriverSpawnContext,
  ParsedEvent,
} from '@silverhand/host/drivers';
export { getDriver, hasDriver } from '@silverhand/host/drivers';

// ── Backend-owned prompt types ─────────────────────────────────────
export type { InjectedFileContent, SessionContextInput, WorkspaceMemoryIndexEntry };
export { buildPlatformPrompt };

/**
 * Inputs to `buildSystemPromptFor`. Lives in backend because every
 * field is supplied by backend services (active profile dir from
 * workspace seed, memory content from disk reads, session context
 * from conversation manager). Drivers themselves never construct
 * one — they only consume the resulting string written to
 * `DriverSpawnContext.systemPromptPath`.
 */
export interface DriverPromptContext {
  agentId: string;
  agentName: string;
  activeProfileDir: string;
  roleSystemPrompt: string;
  currentMemory: InjectedFileContent;
  currentConsensus: InjectedFileContent | null;
  workspaceMemoryIndex: WorkspaceMemoryIndexEntry[];
  sessionContext: SessionContextInput;
}

/**
 * Per-kind system prompt builder. Centralises the "stamp `runtime:
 * <kind>` into the platform prompt" line that used to live in each
 * driver's `buildSystemPrompt` shim, so the driver itself no longer
 * needs to import `buildPlatformPrompt` (which would drag backend
 * deps into the host package).
 */
export function buildSystemPromptFor(
  kind: RuntimeKind,
  ctx: DriverPromptContext,
): string {
  return buildPlatformPrompt({
    agentId: ctx.agentId,
    agentName: ctx.agentName,
    runtime: kind,
    activeProfileDir: ctx.activeProfileDir,
    roleSystemPrompt: ctx.roleSystemPrompt,
    currentMemory: ctx.currentMemory,
    currentConsensus: ctx.currentConsensus,
    workspaceMemoryIndex: ctx.workspaceMemoryIndex,
    sessionContext: ctx.sessionContext,
  });
}
