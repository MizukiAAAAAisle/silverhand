import type { RuntimeStartParams } from '@silverhand/host';
import type {
  AgentDto,
  ConversationAgentDto,
  ConversationDto,
  MemberDto,
  WorkspaceDto,
} from '@silverhand/shared';
import type { SilverhandCliLauncher } from '../context.js';

export interface BuildRuntimeStartOptionsInput {
  conversation: ConversationDto;
  parentConversation: ConversationDto | null;
  workspace: WorkspaceDto;
  agent: AgentDto;
  sessionAgent: ConversationAgentDto;
  members: MemberDto[];
  workspacesForAgent: WorkspaceDto[];
  silverhandCli: SilverhandCliLauncher;
  serverUrl: string;
  agentToken: string;
  modelOverride?: string | null;
}

/**
 * Build SEMANTIC `runtime_start` options (D4.e-6 / invariant I1): the
 * backend ships `agent`/`workspace`/`workspace_memory_index` as identity
 * refs only (`id`/`name`/`kind`). It does NOT compute, read, or transmit
 * any host-local path — the daemon is the sole authority and resolves every
 * absolute path itself (registry for `regular`, `computeAgentDir` for
 * `agent_home`). No `node:path`/`node:fs` import lives here.
 */
export function buildRuntimeStartOptions(
  input: BuildRuntimeStartOptionsInput,
): RuntimeStartParams['options'] {
  const indexedWorkspaces = ensureCurrentWorkspaceIndexed(
    input.workspace,
    input.workspacesForAgent,
  );
  return {
    agent: {
      id: input.agent.id,
      name: input.agent.name,
    },
    workspace: runtimeWorkspaceRef(input.workspace),
    workspace_memory_index: indexedWorkspaces.map(runtimeWorkspaceRef),
    session: {
      conversation_id: input.conversation.id,
      kind: input.conversation.kind,
      title: input.conversation.title,
      parent_conversation_id: input.conversation.parent_conversation_id,
      parent_title: input.parentConversation?.title ?? null,
      spawned_by_agent_id: input.conversation.spawned_by_agent_id,
      members: input.members,
    },
    driver: {
      kind: input.agent.runtime,
      cli_session_id: input.sessionAgent.cli_session_id,
      model: input.modelOverride ?? input.agent.model,
      reasoning_effort: input.agent.reasoning_effort,
      fast_mode: input.agent.fast_mode,
    },
    env_policy: {
      silverhand: {
        server_url: input.serverUrl,
        auth_token: input.agentToken,
      },
      silverhand_cli: {
        command: input.silverhandCli.command,
        args: input.silverhandCli.args,
        ...(input.silverhandCli.env
          ? { env_vars: input.silverhandCli.env }
          : {}),
      },
    },
  };
}

function runtimeWorkspaceRef(
  workspace: WorkspaceDto,
): RuntimeStartParams['options']['workspace'] {
  return {
    id: workspace.id,
    name: workspace.name,
    kind: workspace.workspace_kind,
  };
}

function ensureCurrentWorkspaceIndexed(
  current: WorkspaceDto,
  workspaces: readonly WorkspaceDto[],
): WorkspaceDto[] {
  if (workspaces.some(w => w.id === current.id)) return [...workspaces];
  return [current, ...workspaces];
}
