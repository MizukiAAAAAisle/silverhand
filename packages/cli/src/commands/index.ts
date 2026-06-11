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
import type { RemovedFlagSpec } from '../strict-flags.js';
import { messageCommands } from './message.js';
import { taskCommands } from './task.js';
import { threadCommands } from './thread.js';
import { channelCommands } from './channel.js';
import { memberCommands } from './member.js';
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
  /** Value-bearing flag names this command accepts (e.g. `--task-number`,
   *  `--status`). The dispatcher rejects any flag not listed here or in
   *  `booleanFlags` with a `validation_error` so silent typos never
   *  silently widen the request. Including `--help` is unnecessary —
   *  the dispatcher handles it before it reaches `parseArgs`. */
  flags?: readonly string[];
  /** Boolean flag names used by this command. Listed here so:
   *  (1) the parser doesn't consume the next token as a value;
   *  (2) the dispatcher can include them in the known-flag set used
   *      by strict validation. */
  booleanFlags?: readonly string[];
  /** Flags this command USED to accept but no longer does. When the
   *  agent supplies one, the dispatcher throws `validation_error` with
   *  `subkind: 'flag_removed'` and the supplied migration `hint`,
   *  BEFORE the unknown-flag / positional-rest guards run. Use this
   *  when removing a flag in a backwards-incompatible way. */
  removedFlags?: Readonly<Record<string, RemovedFlagSpec>>;
  /** Run the command. Return value (or null) is written to stdout
   *  as a JSON line. Throw `CliError` (or anything else — fromUnknown
   *  will normalize) on failure. */
  run(ctx: { env: CliEnv; client: BackendClient; args: ParsedArgs }): Promise<unknown>;
}

export interface NounGroup {
  noun: string;
  summary: string;
  commands: readonly Command[];
  /** Verbs this noun USED to accept (or that agents commonly reach for
   *  by mistake). When the agent types one, the dispatcher throws
   *  `validation_error` with `subkind: 'verb_removed'` and the supplied
   *  migration hint pointing at the canonical verb — far more useful
   *  than the generic `unknown verb` line, since agents seeing the
   *  generic line tend to retry with another guess instead of reading
   *  the help. */
  removedVerbs?: Readonly<Record<string, RemovedVerbSpec>>;
}

export interface RemovedVerbSpec {
  /** Canonical verb the agent should switch to. Surfaced in the error
   *  message and `details.replacement`. */
  replacement: string;
  /** One-sentence actionable hint. Should name the canonical verb and
   *  any cross-cutting consequence (e.g. flag changes). */
  hint: string;
}

export const COMMAND_GROUPS: readonly NounGroup[] = [
  {
    noun: 'message',
    summary: 'Send messages, read history, search visible text.',
    commands: messageCommands,
    // Agents reach for `silverhand message read` because every IM-style
    // CLI uses `read` for "show me messages" — but our verb is
    // `history` (anchored window read). 5/14 daily report logged one
    // `unknown verb message read` failure. Pointing the typo at the
    // right verb saves a retry round and keeps the agent in the
    // command surface they intended.
    removedVerbs: {
      read: {
        replacement: 'history',
        // The dispatcher prefixes the stderr line with
        // `silverhand <noun> <verb> is not a verb; ` already, so the
        // hint must start straight at the actionable redirect — leading
        // with another "is not a verb" sentence reads as a stutter
        // (`Cindy review nit on #task:349`).
        hint:
          'use `silverhand message history` to read an anchored window ' +
          '(--before-seq | --after-seq | --around). For full-text ' +
          'lookup across the workspace use `silverhand message search`.',
      },
    },
  },
  {
    noun: 'task',
    summary: 'View, create, claim, release, and update task board entries.',
    commands: taskCommands,
  },
  {
    noun: 'thread',
    summary: 'Follow or unfollow reply clusters under messages.',
    commands: threadCommands,
    removedVerbs: {
      create: {
        replacement: 'follow',
        hint:
          'isolated thread creation has been removed. Reply to a message with ' +
          '`silverhand message send --reply-to <message_id>`; use ' +
          '`silverhand channel create` only when the user explicitly asks for ' +
          'an isolated channel.',
      },
      close: {
        replacement: 'unfollow',
        hint:
          'reply clusters have no close operation. Use ' +
          '`silverhand thread unfollow --root <message_id>` to stop ' +
          'receiving a cluster, or read a legacy isolated thread via ' +
          '`message history --target conversation:<conversation_id>`.',
      },
    },
  },
  {
    noun: 'channel',
    summary: 'Create or list top-level channels in a workspace.',
    commands: channelCommands,
  },
  {
    noun: 'member',
    summary:
      'Add an existing workspace member to the current conversation (channel or thread).',
    commands: memberCommands,
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
