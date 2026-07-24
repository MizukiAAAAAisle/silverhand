/**
 * `silverhand workspace` — list.
 */
import type { Command } from './index.js';

const listCommand: Command = {
  verb: 'list',
  summary: 'List workspaces this agent can reach.',
  help: `silverhand workspace list

Lists every workspace this agent currently has member access to:
regular workspaces it has been added to, plus its own personal home
workspace. Each entry includes \`agent_dir\`, the absolute path to
the agent's working directory inside that workspace; \`agent_dir:
null\` means the workspace is unavailable on this computer (its local
root is not provisioned here yet) — do not guess a path for it.

Use the returned ids with --workspace-id on \`silverhand channel list\`
or \`silverhand message search --scope workspace\`.

stdout: AgentListWorkspacesDto JSON.`,
  flags: [] as const,
  async run({ client }) {
    return client.listWorkspaces();
  },
};

export const workspaceCommands: readonly Command[] = [listCommand];
