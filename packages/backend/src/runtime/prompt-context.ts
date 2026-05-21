/**
 * `prompt-context.ts` — pure helpers that assemble a `DriverPromptContext`
 * for a given (conversation, agent) about to be spawned.
 *
 * Lifted out of `conversation-manager.ts` so both the legacy in-process
 * path (CM.start) and the daemon shim (`DaemonAgentRuntimeHost.start`)
 * call the same function and produce byte-identical system prompts.
 * Without sharing, agents would see different membership ordering,
 * cap behavior, or workspace-memory-index labels across the two
 * runtime hosts — a class of bug we explicitly designed against in
 * Cindy's `5Yrv3roymWkCPxo1` watchlist (item 1: DaemonHost stays thin
 * by reusing every formatter that CM uses).
 *
 * # Surface
 *
 * - `MEMORY_INJECT_CAP_BYTES` / `CONSENSUS_INJECT_CAP_BYTES` —
 *   per-file injection caps. Anything beyond is hard-truncated with
 *   a `…(truncated)` marker so the renderer's contract holds.
 * - `readFileWithCap(path, capBytes)` — UTF-8-safe cap reader that
 *   returns a discriminated `InjectedFileContent` so the renderer can
 *   distinguish present / missing / unreadable.
 * - `buildPromptContext(input)` — composes the full
 *   `DriverPromptContext` consumed by `buildSystemPromptFor`.
 * - `buildWorkspaceMemoryIndex(input)` — exported helper used inside
 *   `buildPromptContext` and reused by `agent_home` cross-workspace
 *   bookkeeping paths.
 *
 * All inputs are passed explicitly — there is no hidden ctx. That lets
 * each caller wire its own repos / paths (CM uses `this.ctx.silverhandDir`,
 * DaemonHost uses its constructor dep) without coupling this module to
 * either lifecycle.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentDto,
  ConversationDto,
  MemberDto,
  WorkspaceDto,
} from '@silverhand/shared';
import type {
  DriverPromptContext,
  InjectedFileContent,
  SessionContextInput,
  WorkspaceMemoryIndexEntry,
} from '../drivers/index.js';
import {
  activeAgentProfileDir,
  agentL1ProfileDir,
  agentMemoryDirFor,
} from '../agent-profile.js';

export const MEMORY_INJECT_CAP_BYTES = 16 * 1024;
export const CONSENSUS_INJECT_CAP_BYTES = 4 * 1024;

/**
 * Read a UTF-8 text file but cap the returned size to `capBytes`. The
 * result is a discriminated union so the system-prompt assembler can
 * render the right thing per case:
 *
 *   - `present`: file existed and read OK; body is the (possibly
 *     truncated) UTF-8 text. Truncation is signalled with a trailing
 *     `\n…(truncated)` marker so the agent knows the content was
 *     clipped.
 *   - `missing`: ENOENT — file simply does not exist. Renderer shows
 *     the "create one when…" hint.
 *   - `unreadable`: any other error (EACCES, EISDIR, IO, …). Renderer
 *     shows an explicit `[unable to read …: <reason>]` so the agent
 *     does not falsely conclude the file is missing and create a
 *     duplicate.
 *
 * The cap is measured in bytes (Buffer.byteLength) — multi-byte runes
 * near the boundary are dropped together rather than producing a
 * malformed code unit.
 */
export async function readFileWithCap(
  path: string,
  capBytes: number,
): Promise<InjectedFileContent> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { kind: 'missing' };
    const reason = code ?? (err as Error | undefined)?.message ?? 'unknown error';
    return { kind: 'unreadable', reason };
  }
  if (buf.byteLength <= capBytes) {
    return { kind: 'present', body: buf.toString('utf-8') };
  }
  // UTF-8-safe truncation: walk back from `capBytes` until the byte at
  // the boundary is not a continuation byte (0b10xxxxxx). Treat
  // out-of-bounds reads as "not a continuation byte" so the loop
  // terminates cleanly.
  let cut = capBytes;
  while (cut > 0 && buf[cut] !== undefined && (buf[cut]! & 0xc0) === 0x80) cut -= 1;
  return {
    kind: 'present',
    body: `${buf.subarray(0, cut).toString('utf-8')}\n…(truncated)`,
  };
}

/** Inputs to `buildPromptContext`. Explicit deps — no hidden ctx —
 *  so CM and DaemonHost wire from their own state cleanly. */
export interface BuildPromptContextInput {
  conversation: ConversationDto;
  workspace: WorkspaceDto;
  agent: AgentDto;
  silverhandDir: string;
  /** `MembershipService.listMembers` projection. */
  listMembers(conversationId: string): MemberDto[];
  /** `WorkspaceRepo.listForAgent` — every workspace this agent is in. */
  listWorkspacesForAgent(agentId: string): WorkspaceDto[];
  /** `ConversationRepo.get` — used to look up parent conversation's
   *  title for thread context. */
  getConversation(id: string): ConversationDto | null;
}

/**
 * Compose the `DriverPromptContext` consumed by `buildSystemPromptFor`.
 * Reads:
 *   - L1 `system_prompt.md` (identity, shared across workspaces)
 *   - current-workspace L2 `MEMORY.md` (capped + truncation-marked)
 *   - current-workspace `.silverhand/CONSENSUS.md` (skipped on
 *     `agent_home` because there is exactly one member and thus no
 *     consensus to project)
 *   - cross-workspace memory index for this agent
 *   - parent-conversation title when this conversation is a thread
 */
export async function buildPromptContext(
  input: BuildPromptContextInput,
): Promise<DriverPromptContext> {
  const { conversation, workspace, agent, silverhandDir } = input;
  const members = input.listMembers(conversation.id);

  let parentSessionTitle: string | null = null;
  let parentChannelConversationId: string | null = null;
  if (conversation.parent_conversation_id) {
    const parent = input.getConversation(conversation.parent_conversation_id);
    parentSessionTitle = parent?.title ?? null;
    parentChannelConversationId =
      parent?.id ?? conversation.parent_conversation_id;
  }

  const profile = activeAgentProfileDir(conversation, workspace, agent.id);

  // Role contract: L1-only. The agent's identity is shared across
  // every workspace and lives at `~/.silverhand/agents/<id>/system_prompt.md`.
  // This redirect is the heart of the L1/L2 split — we no longer copy
  // system_prompt.md into the L2 directory, so reading from `profile`
  // here would be wrong for non-DM workspaces.
  const l1Dir = agentL1ProfileDir(silverhandDir, agent.id);
  const roleSystemPrompt = await readFile(
    join(l1Dir, 'system_prompt.md'),
    'utf-8',
  ).catch(() => '');

  // Auto-injected current-workspace MEMORY.md. Capped + truncation-marked
  // so the platform prompt has an upper-bound on the rendered block.
  const currentMemory = await readFileWithCap(
    join(profile.absoluteDir, 'MEMORY.md'),
    MEMORY_INJECT_CAP_BYTES,
  );

  // Workspace-wide consensus, scoped to this workspace's `.silverhand/`.
  // For agent_home (DM workspace), there is exactly one member and no
  // notion of "consensus", so we omit the section entirely. Otherwise,
  // we read CONSENSUS.md with the same discriminated semantics as
  // MEMORY.md — missing renders a create hint, unreadable renders an
  // explicit error.
  const currentConsensus =
    workspace.workspace_kind === 'agent_home'
      ? null
      : await readFileWithCap(
          join(workspace.workspace_path, '.silverhand', 'CONSENSUS.md'),
          CONSENSUS_INJECT_CAP_BYTES,
        );

  // Cross-workspace memory index. Same-host trust model: every workspace
  // returned by `listForAgent` is a workspace this agent already has
  // membership in, and host-equality between agent and workspace is
  // enforced at `addAgentToWorkspace` time as a membership precondition,
  // not filtered here at runtime.
  const workspaceMemoryIndex = buildWorkspaceMemoryIndex({
    agentId: agent.id,
    currentWorkspaceId: workspace.id,
    listWorkspacesForAgent: input.listWorkspacesForAgent,
  });

  const isThread = conversation.kind === 'thread';

  const sessionContext: SessionContextInput = {
    conversationId: conversation.id,
    channelName:
      conversation.kind === 'dm_channel' ? conversation.title : workspace.name,
    channelKind: conversation.kind === 'dm_channel' ? 'dm' : 'regular',
    sessionTitle: conversation.title,
    members,
    selfAgentId: agent.id,
    isChildSession: isThread,
    parentSessionTitle,
    parentChannelConversationId,
    isAgentSpawnedChild: conversation.spawned_by_agent_id !== null,
  };

  return {
    agentId: agent.id,
    agentName: agent.name,
    activeProfileDir: profile.promptDir,
    roleSystemPrompt,
    currentMemory,
    currentConsensus,
    workspaceMemoryIndex,
    sessionContext,
  };
}

export interface BuildWorkspaceMemoryIndexInput {
  agentId: string;
  currentWorkspaceId: string;
  listWorkspacesForAgent(agentId: string): WorkspaceDto[];
}

/**
 * Index every workspace this agent is a member of, with the agent's
 * MEMORY.md path inside it. The current workspace's entry is suffixed
 * with " (current)" so the prompt renderer can call out the auto-loaded
 * one without duplicating its name.
 *
 * For agent_home workspaces, the workspace path coincides with the L1
 * agent directory and the agent's MEMORY.md sits at the workspace root.
 * For regular workspaces it lives at
 * `<workspace>/.silverhand/agents/<agentId>/MEMORY.md`.
 */
export function buildWorkspaceMemoryIndex(
  input: BuildWorkspaceMemoryIndexInput,
): WorkspaceMemoryIndexEntry[] {
  const ws = input.listWorkspacesForAgent(input.agentId);
  return ws.map(w => {
    const dir = agentMemoryDirFor(w, input.agentId);
    const isCurrent = w.id === input.currentWorkspaceId;
    const baseLabel =
      w.workspace_kind === 'agent_home' ? `${w.name} (DM)` : w.name;
    return {
      label: isCurrent ? `${baseLabel} (current)` : baseLabel,
      memoryPath: join(dir, 'MEMORY.md'),
    };
  });
}
