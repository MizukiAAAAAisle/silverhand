/**
 * Command catalogue. The CLI is a fixed two-level dispatch:
 *
 *   silverhand <noun> <verb> [flags...]
 *
 * Each leaf is a `Command` with a short usage string (printed in
 * `--help`) and a `run` function that takes the already-loaded env,
 * the BackendClient, and parsed argv. `run` returns a value to write
 * to stdout (as JSON) or `null` for "no body" (e.g. simple ack).
 *
 * Adding a new subcommand: declare a `Command`, register it under
 * the right noun in `COMMANDS`. Help text is generated from the
 * declarations — there is no separate doc to keep in sync.
 */
import type { ParsedArgs } from '../parse.js';
import type { BackendClient } from '../client.js';
import type { CliEnv } from '../env.js';
import { messageCommands } from './message.js';
import { taskCommands } from './task.js';
import { threadCommands } from './thread.js';
import { channelCommands } from './channel.js';
import { workspaceCommands } from './workspace.js';
import { scheduleCommands } from './schedule.js';
import { fileCommands } from './file.js';

export interface Command {
  /** "send", "create", "list" — the verb part. */
  verb: string;
  /** One-line summary (printed in `silverhand <noun> --help`). */
  summary: string;
  /** Multi-line usage block, including flag descriptions. Printed by
   *  `silverhand <noun> <verb> --help`. */
  help: string;
  /** Boolean flag names used by this command, so the parser doesn't
   *  consume the next token as a value. */
  booleanFlags?: readonly string[];
  /** Run the command. Return value (or null) is written to stdout
   *  as a JSON line. Throw `CliError` (or anything else — fromUnknown
   *  will normalize) on failure. */
  run(ctx: { env: CliEnv; client: BackendClient; args: ParsedArgs }): Promise<unknown>;
}

export interface NounGroup {
  noun: string;
  summary: string;
  commands: readonly Command[];
}

export const COMMAND_GROUPS: readonly NounGroup[] = [
  {
    noun: 'message',
    summary: 'Send messages, read history, search visible text.',
    commands: messageCommands,
  },
  {
    noun: 'task',
    summary: 'View, create, claim, release, and update task board entries.',
    commands: taskCommands,
  },
  {
    noun: 'thread',
    summary: 'Open or close a sub-discussion under a channel.',
    commands: threadCommands,
  },
  {
    noun: 'channel',
    summary: 'Create or list top-level channels in a workspace.',
    commands: channelCommands,
  },
  {
    noun: 'workspace',
    summary: 'List the workspaces this agent can reach.',
    commands: workspaceCommands,
  },
  {
    noun: 'schedule',
    summary: 'Create, list, or cancel self-wake schedules.',
    commands: scheduleCommands,
  },
  {
    noun: 'file',
    summary: 'Upload a local file or resolve an attachment id.',
    commands: fileCommands,
  },
];

export function findGroup(noun: string): NounGroup | undefined {
  return COMMAND_GROUPS.find(g => g.noun === noun);
}

export function findCommand(noun: string, verb: string): Command | undefined {
  return findGroup(noun)?.commands.find(c => c.verb === verb);
}
