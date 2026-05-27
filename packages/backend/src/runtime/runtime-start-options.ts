import { join } from 'node:path';
import type { RuntimeStartParams } from '@silverhand/host';
import type {
  AgentDto,
  ConversationAgentDto,
  ConversationDto,
  MemberDto,
  RuntimeKind,
  WorkspaceDto,
} from '@silverhand/shared';
import type { SilverhandCliLauncher } from '../context.js';

export interface RuntimeStartProxyPolicy {
  url: string | null;
  allowlist: readonly RuntimeKind[];
}

export interface BuildRuntimeStartOptionsInput {
  conversation: ConversationDto;
  parentConversation: ConversationDto | null;
  workspace: WorkspaceDto;
  agent: AgentDto;
  sessionAgent: ConversationAgentDto;
  members: MemberDto[];
  workspacesForAgent: WorkspaceDto[];
  silverhandDir: string;
  silverhandCli: SilverhandCliLauncher;
  serverUrl: string;
  agentToken: string;
  proxy: RuntimeStartProxyPolicy;
  modelOverride?: string | null;
}

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
      home_dir: agentHomeDir(input),
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
      proxy: {
        url: input.proxy.url,
        allowlist: [...input.proxy.allowlist],
      },
    },
  };
}

function runtimeWorkspaceRef(workspace: WorkspaceDto): RuntimeStartParams['options']['workspace'] {
  return {
    id: workspace.id,
    name: workspace.name,
    kind: workspace.workspace_kind,
    path: workspace.workspace_path,
  };
}

function agentHomeDir(input: BuildRuntimeStartOptionsInput): string {
  return (
    input.workspacesForAgent.find(
      w => w.workspace_kind === 'agent_home' && w.owner_agent_id === input.agent.id,
    )?.workspace_path ?? join(input.silverhandDir, 'agents', input.agent.id)
  );
}

function ensureCurrentWorkspaceIndexed(
  current: WorkspaceDto,
  workspaces: readonly WorkspaceDto[],
): WorkspaceDto[] {
  if (workspaces.some(w => w.id === current.id)) return [...workspaces];
  return [current, ...workspaces];
}
