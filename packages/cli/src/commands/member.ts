/**
 * `silverhand member` — add.
 *
 * Adds an existing workspace member (agent or human) to the current
 * conversation (channel or thread). The handle is resolved
 * server-side against the conversation's workspace member set, so
 * the CLI never enumerates users or workspace members itself —
 * that keeps agent-CLI's read surface bounded.
 *
 * The agent contract (per `docs/architecture-principles.md` §0/§9):
 * agents talk to silverhand via this CLI, NOT by calling internal
 * routes directly with curl. The internal route this command backs
 * (`POST /internal/conversations/:cid/agents/:aid/members`) accepts
 * only `{ handle }` for that reason.
 */
import { CliError } from '../errors.js';
import { flagString } from '../parse.js';
import type { Command } from './index.js';

const addCommand: Command = {
  verb: 'add',
  summary: 'Add an existing workspace member to the current conversation.',
  help: `silverhand member add --handle <handle>

Adds an existing workspace member (agent or human) to the current
conversation (channel or thread). The handle is resolved server-side
against the conversation's workspace member set; the candidate must
already be a member of the workspace this conversation belongs to.

Use this when you want to bring another participant into the
conversation you are running in. The current conversation must be a
channel or a thread — running this command from a DM fails with
\`conversation_member_add_unsupported\`. v1 does not allow cross-
conversation member adds (agent tokens are scoped per (conversation,
agent)) and there is no \`--target\` flag; to add to a thread, run
this command from inside that thread.

Flags:
  --handle    Required. Agent or human handle, with or without the
              leading \`@\` (\`alice\` and \`@alice\` are both accepted).
              The same handle namespace as \`@\`-mentions in chat.

stdout: ConversationMembersResponse JSON with the updated members
list (kind/name/display_name etc. for every current member).

Errors:
  workspace_membership_required (422)  candidate is not a member of
                                       this conversation's workspace;
                                       add them at the workspace level
                                       first
  candidate_not_found (404)            no agent or human with that
                                       handle
  handle_ambiguous (422)               handle matches both an agent
                                       and a human in the workspace
                                       — disambiguate at the workspace
                                       level
  conversation_member_add_unsupported  target conversation is a DM
    (422)                              (channel + thread are both OK)
  conversation_closed (409)            conversation is archived/closed
  duplicate                            200 no-op, returns current
                                       members unchanged`,
  flags: ['handle'] as const,
  async run({ client, args }) {
    const handle = flagString(args, 'handle');
    if (!handle) {
      throw new CliError({
        code: 'validation_error',
        message: 'member add requires --handle <handle>',
        retriable: false,
      });
    }
    return client.addConversationMember({ handle });
  },
};

export const memberCommands: readonly Command[] = [addCommand];
