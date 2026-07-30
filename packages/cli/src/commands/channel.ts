/**
 * `silverhand channel` — create, list.
 */
import { CliError } from '../errors.js';
import { flagString } from '../parse.js';
import type { Command } from './index.js';

const createCommand: Command = {
  verb: 'create',
  summary: 'Create a new top-level channel in the current workspace.',
  help: `silverhand channel create --title <title> --context-summary <text>
                           --initial-prompt <text>

ONLY use this when the user has explicitly requested a new top-level
channel. Reply clusters stay in the current channel via
\`silverhand message send --target thread:<message_id>\`; use a channel only
when the user asks for isolation.

After creation, you should announce the new channel id in the current
channel via \`silverhand message send\` so the user knows a fork happened.

Flags:
  --title              Required. Short title for the new channel.
  --context-summary    Required. Why this channel exists; states the user
                       intent it serves. Stored for audit and recovery.
  --initial-prompt     Required. First message posted into the new channel.

stdout: { "channel_id": "<id>" }`,
  flags: ['title', 'context-summary', 'initial-prompt'] as const,
  async run({ client, args }) {
    const title = flagString(args, 'title');
    const contextSummary = flagString(args, 'context-summary');
    const initialPrompt = flagString(args, 'initial-prompt');
    if (!title || !contextSummary || !initialPrompt) {
      throw new CliError({
        code: 'validation_error',
        message:
          'channel create requires --title, --context-summary, and --initial-prompt',
        retriable: false,
      });
    }
    return client.createChannel({
      title,
      context_summary: contextSummary,
      initial_prompt: initialPrompt,
    });
  },
};

const listCommand: Command = {
  verb: 'list',
  summary:
    "List the agent's channels and DMs, plus public channels it has not joined.",
  help: `silverhand channel list [--workspace-id <id>]

Lists two sets of conversations in one result: the channels and
direct-message conversations in which the agent is a member (\`kind\`:
'channel' | 'dm_channel', any visibility, archived conversations included and
sorted last), and the active public channels in the workspace that the agent
has not joined. Non-member private channels, non-member direct messages, and
non-member archived public channels are excluded.

Each entry carries \`is_member\` and \`visibility\`. An entry with
\`visibility: 'public'\` and \`is_member: false\` is a public channel the agent
has not joined. Membership must be read from \`is_member\`, not inferred from
\`kind\` or position. Listing a non-member public channel grants discovery
only; it conveys no access to messages, roster, or delivery, and does not join
the channel. Defaults to the current workspace.

Flags:
  --workspace-id   Optional. From \`silverhand workspace list\`.

stdout: AgentListChannelsDto JSON.`,
  flags: ['workspace-id'] as const,
  async run({ client, args }) {
    const workspaceId = flagString(args, 'workspace-id');
    return client.listChannels({
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    });
  },
};

export const channelCommands: readonly Command[] = [createCommand, listCommand];
