/**
 * `silverhand message` — send, history, search.
 */
import type { SendMessageTarget } from '@silverhand/shared';
import { CliError } from '../errors.js';
import {
  flagBool,
  flagNumber,
  flagString,
  flagStringArray,
} from '../parse.js';
import type { Command } from './index.js';

const sendCommand: Command = {
  verb: 'send',
  summary: 'Send a message to the current channel/thread.',
  help: `silverhand message send --content <text> [--target self|parent|<thread_id>]
                          [--attachment <id> ...]

Sends a message to the current conversation (channel or thread).

Flags:
  --content <text>      Required. The message body. Use quoting for spaces.
  --target self|parent  Optional. "self" (default) sends to the current
                        conversation. "parent" requires you to be inside a
                        Thread; sends to that Thread's parent channel.
                        Any other value is treated as a child Thread id
                        you opened from this channel.
  --attachment <id>     Optional, repeatable. Attachment ids returned by
                        \`silverhand file upload\`. All ids must belong to
                        the current channel.

stdout: { "message_id": "<id>" }`,
  async run({ client, args }) {
    const content = flagString(args, 'content');
    if (!content) {
      throw new CliError({
        code: 'validation_error',
        message: '--content is required',
        retriable: false,
      });
    }
    const target = parseTarget(flagString(args, 'target'));
    const attachmentIds = flagStringArray(args, 'attachment');
    return client.sendMessage({
      content,
      ...(target ? { target } : {}),
      ...(attachmentIds && attachmentIds.length > 0
        ? { attachment_ids: attachmentIds }
        : {}),
    });
  },
};

const historyCommand: Command = {
  verb: 'history',
  summary: 'Read an anchored window of message history.',
  help: `silverhand message history (--before-seq N | --after-seq N | --around <id>)
                             [--target self|parent|conversation:<id>|thread:<id>]
                             [--include-content] [--no-include-system]
                             [--limit N]

Read a window of messages anchored at a position. Exactly one of --before-seq,
--after-seq, or --around must be provided.

Flags:
  --before-seq N        Read messages with seq < N.
  --after-seq N         Read messages with seq > N.
  --around <message_id> Read a window centered on this message id.
  --target              Where to read.
                          self                    (default; current conv)
                          parent                  (only inside a Thread)
                          thread:<thread_id>      (a direct child Thread)
                          conversation:<conv_id>  (any conv you can reach)
  --include-content     Return full content. Default is snippets only.
  --no-include-system   Skip system messages. Default keeps them.
  --limit N             Max messages. Default 50, max 100.

stdout: full AgentReadHistoryDto JSON.`,
  booleanFlags: ['include-content', 'include-system'],
  async run({ client, args }) {
    const before = flagNumber(args, 'before-seq');
    const after = flagNumber(args, 'after-seq');
    const around = flagString(args, 'around');
    const anchorCount = [before, after, around].filter(v => v !== undefined).length;
    if (anchorCount !== 1) {
      throw new CliError({
        code: 'validation_error',
        message:
          'message history requires exactly one of --before-seq, --after-seq, or --around',
        retriable: false,
      });
    }
    const includeContent = flagBool(args, 'include-content') ?? false;
    const includeSystem = flagBool(args, 'include-system') ?? true;
    const limit = flagNumber(args, 'limit') ?? 50;
    const target = parseHistoryTarget(flagString(args, 'target'));
    return client.readHistory({
      ...(before !== undefined ? { before_seq: before } : {}),
      ...(after !== undefined ? { after_seq: after } : {}),
      ...(around !== undefined ? { around_message_id: around } : {}),
      ...(target ? { target } : {}),
      include_content: includeContent,
      include_system: includeSystem,
      limit,
    });
  },
};

const searchCommand: Command = {
  verb: 'search',
  summary: 'Search visible message text.',
  help: `silverhand message search --q <text> [--scope current|workspace|channel]
                            [--workspace-id <id>] [--channel-id <id>]
                            [--no-include-system] [--limit N]

Full-text search over messages this agent can see.

Flags:
  --q <text>           Required. Search query. 1..200 chars.
  --scope              Default "current". One of:
                         current   — only the current channel/thread
                         workspace — every conv in this workspace (or one
                                     given via --workspace-id) where you
                                     are a current member
                         channel   — a specific channel; requires --channel-id
  --workspace-id <id>  Only valid with --scope workspace.
  --channel-id <id>    Required with --scope channel; from "channel list".
  --no-include-system  Skip system messages.
  --limit N            Max hits. Default 50, max 100.

stdout: AgentSearchMessagesDto JSON.`,
  booleanFlags: ['include-system'],
  async run({ client, args }) {
    const q = flagString(args, 'q');
    if (!q) {
      throw new CliError({
        code: 'validation_error',
        message: '--q is required',
        retriable: false,
      });
    }
    const scope = (flagString(args, 'scope') ?? 'current') as
      | 'current'
      | 'workspace'
      | 'channel';
    if (!['current', 'workspace', 'channel'].includes(scope)) {
      throw new CliError({
        code: 'validation_error',
        message: `--scope must be current, workspace, or channel; got ${scope}`,
        retriable: false,
      });
    }
    const workspaceId = flagString(args, 'workspace-id');
    const channelId = flagString(args, 'channel-id');
    if ((scope === 'channel') !== !!channelId) {
      throw new CliError({
        code: 'validation_error',
        message: '--channel-id is required only when --scope is channel',
        retriable: false,
      });
    }
    if (workspaceId && scope !== 'workspace') {
      throw new CliError({
        code: 'validation_error',
        message: '--workspace-id is only valid with --scope workspace',
        retriable: false,
      });
    }
    const includeSystem = flagBool(args, 'include-system') ?? true;
    const limit = flagNumber(args, 'limit') ?? 50;
    return client.searchMessages({
      q,
      scope,
      include_system: includeSystem,
      limit,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      ...(channelId ? { channel_id: channelId } : {}),
    });
  },
};

export const messageCommands: readonly Command[] = [
  sendCommand,
  historyCommand,
  searchCommand,
];

function parseTarget(raw: string | undefined): SendMessageTarget | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'self' || raw === 'parent') return raw;
  return { thread_id: raw };
}

function parseHistoryTarget(
  raw: string | undefined,
):
  | 'self'
  | 'parent'
  | { thread_id: string }
  | { conversation_id: string }
  | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'self' || raw === 'parent') return raw;
  if (raw.startsWith('thread:')) return { thread_id: raw.slice('thread:'.length) };
  if (raw.startsWith('conversation:')) {
    return { conversation_id: raw.slice('conversation:'.length) };
  }
  throw new CliError({
    code: 'validation_error',
    message:
      '--target must be self | parent | thread:<id> | conversation:<id>',
    retriable: false,
  });
}
