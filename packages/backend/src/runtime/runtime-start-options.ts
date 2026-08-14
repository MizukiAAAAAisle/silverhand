import type { RuntimeActionTarget, RuntimeStartParams } from '@silverhand/host';
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
  workspace: WorkspaceDto | null;
  agent: AgentDto;
  sessionAgent: ConversationAgentDto | null;
  cliSessionId: string | null;
  members: MemberDto[];
  workspacesForAgent: WorkspaceDto[];
  silverhandCli: SilverhandCliLauncher | null;
  agentToken: string;
  modelOverride?: string | null;
}

/**
 * Build SEMANTIC `runtime_start` options (D4.e-6 / invariant I1): the
 * backend ships `agent`/`workspace`/`workspace_memory_index` as identity
 * refs only (`id`/`name`/`kind`). It does NOT compute, read, or transmit
 * any host-local path — the daemon is the sole authority and resolves every
 * absolute path itself (the deterministic bundle coordinate for `regular`,
 * `resolveAgentDir` for `agent_home`). No `node:path`/`node:fs` import lives here.
 */
export function buildRuntimeStartOptions(
  input: BuildRuntimeStartOptionsInput,
): RuntimeStartParams['options'] {
  const common = {
    agent: {
      id: input.agent.id,
      name: input.agent.name,
    },
    driver: {
      kind: input.agent.runtime,
      cli_session_id: input.cliSessionId,
      model: input.modelOverride ?? input.agent.model,
      reasoning_effort: input.agent.reasoning_effort,
      fast_mode: input.agent.fast_mode,
    },
    env_policy: {
      silverhand: {
        auth_token: input.agentToken,
      },
      ...(input.silverhandCli
        ? {
            silverhand_cli: {
              command: input.silverhandCli.command,
              args: input.silverhandCli.args,
              ...(input.silverhandCli.env
                ? { env_vars: input.silverhandCli.env }
                : {}),
            },
          }
        : {}),
    },
  };
  if (input.agent.session_scope === 'agent') {
    return {
      ...common,
      runtime_scope: {
        kind: 'agent',
        agent_id: input.agent.id,
      },
    };
  }
  const indexedWorkspaces: WorkspaceDto[] = input.workspace === null
    ? []
    : ensureCurrentWorkspaceIndexed(input.workspace, input.workspacesForAgent);
  return {
    ...common,
    runtime_scope: {
      kind: 'conversation',
      conversation_id: input.conversation.id,
      agent_id: input.agent.id,
    },
    workspace:
      input.workspace === null ? null : runtimeWorkspaceRef(input.workspace),
    workspace_memory_index: indexedWorkspaces.map(runtimeWorkspaceRef),
    session: {
      conversation_id: input.conversation.id,
      kind: input.conversation.kind,
      title: input.conversation.title,
      spawned_by_agent_id: input.conversation.spawned_by_agent_id,
      members: input.members,
    },
  };
}

/** Build the semantic per-delivery origin coordinate. Like runtime start
 * options, this never carries a host-local path; the daemon resolves the
 * action workdir from the target placement. */
export function buildRuntimeActionTarget(
  conversation: ConversationDto,
  workspace: WorkspaceDto | null,
): RuntimeActionTarget {
  return {
    conversation_id: conversation.id,
    workspace: workspace === null ? null : runtimeWorkspaceRef(workspace),
  };
}

function runtimeWorkspaceRef(
  workspace: WorkspaceDto,
): NonNullable<
  Extract<
    RuntimeStartParams['options'],
    { runtime_scope: { kind: 'conversation' } }
  >['workspace']
> {
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
