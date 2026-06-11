/**
 * `silverhand thread` — reply-cluster subscription controls.
 */
import { CliError } from '../errors.js';
import { flagString } from '../parse.js';
import type { Command } from './index.js';

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
  followCommand,
  unfollowCommand,
];
