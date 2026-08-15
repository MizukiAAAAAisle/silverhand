/**
 * `silverhand channel` — create, list.
 */
import { CliError } from '../errors.js';
import { flagString } from '../parse.js';
import { requireTargetFlag } from '../target-flag.js';
import { reachHelpErrorRow } from '../reach-help.js';
import type { Command } from './index.js';

const createCommand: Command = {
  verb: 'create',
  summary: 'Create a new top-level channel, forked from one you name.',
  help: `silverhand channel create --target <address> --title <title>
                           --context-summary <text> --initial-prompt <text>

ONLY use this when the user has explicitly requested a new top-level
channel. Reply clusters stay in the current channel via
\`silverhand message send --target '#conv:<conversation_id>/thread:<root_message_id>'\`;
use a channel only when the user asks for isolation.

This door does not post into the addressed conversation — it FORKS it.
\`--target\` names the SOURCE: its placement gives the workspace the new
channel is born into, and its agent members give the roster the channel
starts with. There is no flag for either one separately, which is exactly
why the source must be named: the conversation this CLI is authenticated
in is where your credential lives, not the fork you meant.

A fork source is a whole CONVERSATION, so a \`/thread:<root_message_id>\`
suffix is refused (\`thread_suffix_not_supported\`) rather than silently
ignored — a reply cluster has neither its own workspace nor its own
roster. A source with no workspace placement (a DM pair, your agent
inbox) is refused with \`workspace_scope_required\` rather than guessing
a workspace.

After creation, announce the new channel id in the conversation the user
asked from via \`silverhand message send\` so they know a fork happened.

Flags:
  --target             Required. The conversation to fork, e.g.
                       \`#conv:<conversation_id>\` or \`#<workspace>/<title>\`.
                       Copy the \`target=\` token from the message asking
                       for the channel. You must be able to post in it;
                       one you cannot see is refused exactly like one
                       that does not exist.
  --title              Required. Short title for the new channel.
  --context-summary    Required. Why this channel exists; states the user
                       intent it serves. Stored for audit and recovery.
  --initial-prompt     Required. First message posted into the new channel.

stdout: { "channel_id": "<id>" }

Errors:
  target_required (validation)         --target was omitted
  target_malformed (400)               --target is not an address
  target_unresolved (404)              --target names no conversation you
                                       participate in — the same answer an
                                       id nobody holds gets
  thread_suffix_not_supported (400)    --target named a reply cluster
${reachHelpErrorRow('channel_fork_source', 39)}  workspace_scope_required (400)       the source has no workspace, so it
                                       names no place for the channel to
                                       be born into`,
  flags: ['target', 'title', 'context-summary', 'initial-prompt'] as const,
  async run({ env, client, args }) {
    const target = requireTargetFlag(flagString(args, 'target'), env, {
      command: 'silverhand channel create',
      because:
        'a fork takes its workspace and its roster from ONE named source ' +
        'conversation, and the conversation this CLI is authenticated in is ' +
        'where your credential lives, not the source you meant.',
    });
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
      target,
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
