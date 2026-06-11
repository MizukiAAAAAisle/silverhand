/**
 * `silverhand thread` — create, close.
 */
import { CliError } from '../errors.js';
import { flagBool, flagString, flagStringArray } from '../parse.js';
import type { Command } from './index.js';

const createCommand: Command = {
  verb: 'create',
  summary: 'Open a Thread off the current channel.',
  help: `silverhand thread create --title <title> --context-summary <text>
                          --initial-prompt <text> [--member <agent_id> ...]

Open an isolated Thread for a focused sub-discussion. Use only when a
side-topic is large enough that mixing it with the main channel would
obscure context, or when delegating a sub-task to a subset of members.
Threads cannot be opened from inside a Thread.

Flags:
  --title              Required. Short title.
  --context-summary    Required. What the Thread needs to know from this
                       channel. Forces you to decide if the Thread is
                       actually warranted.
  --initial-prompt     Required. First message posted into the Thread.
  --member <agent_id>  Optional, repeatable. Subset of channel members to
                       pull in. Omit to use all current channel members;
                       the caller is always included.

stdout: { "thread_id": "<id>" }`,
  flags: ['title', 'context-summary', 'initial-prompt', 'member'] as const,
  async run({ client, args }) {
    const title = flagString(args, 'title');
    const contextSummary = flagString(args, 'context-summary');
    const initialPrompt = flagString(args, 'initial-prompt');
    if (!title || !contextSummary || !initialPrompt) {
      throw new CliError({
        code: 'validation_error',
        message:
          'thread create requires --title, --context-summary, and --initial-prompt',
        retriable: false,
      });
    }
    const members = flagStringArray(args, 'member');
    return client.createThread({
      title,
      context_summary: contextSummary,
      initial_prompt: initialPrompt,
      ...(members && members.length > 0 ? { members } : {}),
    });
  },
};

const closeCommand: Command = {
  verb: 'close',
  summary: 'Close the current Thread.',
  help: `silverhand thread close --summary <text> [--posted-to-parent]
                         [--allow-open-tasks]

Mark the current Thread as closed and (unless --posted-to-parent is set)
auto-post the summary to the parent channel.

Flags:
  --summary             Required. Final summary of the Thread outcome.
  --posted-to-parent    Pass when you have already sent the conclusion
                        to the parent via
                        \`silverhand message send --target parent\`.
                        Avoids duplicate posting.
  --allow-open-tasks    Escape hatch (user-approved use only). By
                        default the server refuses to close a Thread
                        that still has tasks in
                        todo / in_progress / in_review and lists them
                        in the error so you can move them to done or
                        re-claim them. Pass this flag ONLY when the
                        human has consciously decided to leave that
                        residue. Do NOT add it as a habit to make
                        close go through — that's exactly the
                        bookkeeping rot this guard exists to prevent.

stdout: { "thread": ... }`,
  flags: ['summary'] as const,
  booleanFlags: ['posted-to-parent', 'allow-open-tasks'],
  async run({ client, args }) {
    const summary = flagString(args, 'summary');
    if (!summary) {
      throw new CliError({
        code: 'validation_error',
        message: '--summary is required',
        retriable: false,
      });
    }
    const postedToParent = flagBool(args, 'posted-to-parent') ?? false;
    const allowOpenTasks = flagBool(args, 'allow-open-tasks') ?? false;
    return client.closeThread({
      summary,
      ...(postedToParent ? { posted_to_parent: true } : {}),
      ...(allowOpenTasks ? { allow_open_tasks: true } : {}),
    });
  },
};

const followCommand: Command = {
  verb: 'follow',
  summary: 'Follow a reply cluster to receive its replies in your inbox.',
  help: `silverhand thread follow --root <message_id>

Voluntarily follow a reply cluster (the thread under a message). A
cluster is identified by its root message id — you may pass the root
itself or any reply in it; the server normalizes to the canonical root.

Following is a delivery SUBSCRIPTION, not a permission: it presupposes
you can already see the parent channel, and it makes future replies in
that cluster land in your inbox (and backfills the cluster's prior
replies once, now). Use it to watch a thread you were neither @mentioned
in nor replied to — those make you a follower automatically.

Flags:
  --root <message_id>  Required. The cluster root, or any reply in it.

stdout: { "thread_root_id": "<root_id>", "changed": <bool> }
        changed=false means you were already following (no re-backfill).`,
  flags: ['root'] as const,
  async run({ client, args }) {
    const root = flagString(args, 'root');
    if (!root) {
      throw new CliError({
        code: 'validation_error',
        message: 'thread follow requires --root <message_id>',
        retriable: false,
      });
    }
    return client.followThread({ root_message_id: root });
  },
};

const unfollowCommand: Command = {
  verb: 'unfollow',
  summary: 'Stop following a reply cluster.',
  help: `silverhand thread unfollow --root <message_id>

Stop following a reply cluster (the thread under a message). Identified
by the cluster root or any reply in it (normalized server-side).

Unfollow is idempotent and only stops delivery — it is not a block: a
later @mention or reply in the cluster re-follows you automatically.

Flags:
  --root <message_id>  Required. The cluster root, or any reply in it.

stdout: { "thread_root_id": "<root_id>", "changed": <bool> }
        changed=false means you were not following.`,
  flags: ['root'] as const,
  async run({ client, args }) {
    const root = flagString(args, 'root');
    if (!root) {
      throw new CliError({
        code: 'validation_error',
        message: 'thread unfollow requires --root <message_id>',
        retriable: false,
      });
    }
    return client.unfollowThread({ root_message_id: root });
  },
};

export const threadCommands: readonly Command[] = [
  createCommand,
  closeCommand,
  followCommand,
  unfollowCommand,
];
