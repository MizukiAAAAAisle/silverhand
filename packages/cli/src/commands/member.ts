/**
 * `silverhand member` — add.
 *
 * Adds an existing workspace member (agent or human) to an ADDRESSED
 * conversation. The handle is resolved server-side against that
 * conversation's workspace member set, so the CLI never enumerates
 * users or workspace members itself — that keeps agent-CLI's read
 * surface bounded.
 *
 * The agent contract (per `docs/architecture-principles.md` §0/§9):
 * agents talk to silverhand via this CLI, NOT by calling internal
 * routes directly with curl. The internal route this command backs
 * (`POST /internal/agents/:aid/members`) accepts
 * only `{ handle, target }` for that reason.
 */
import { CliError } from '../errors.js';
import { flagString } from '../parse.js';
import { requireTargetFlag } from '../target-flag.js';
import { reachHelpErrorRow } from '../reach-help.js';
import type { Command } from './index.js';

const addCommand: Command = {
  verb: 'add',
  summary: 'Add an existing workspace member to an addressed conversation.',
  help: `silverhand member add --target <address> --handle <handle>

Adds an existing workspace member (agent or human) to the conversation
--target names. The handle is resolved server-side against that
conversation's workspace member set; the candidate must already be a
member of the workspace the conversation belongs to.

A membership is a fact about a CONVERSATION, so --target must name one:
a \`/thread:<root_message_id>\` suffix is refused
(\`thread_suffix_not_supported\`) rather than silently ignored. Someone
joins a reply cluster by being referenced in it or by replying — not by
being added to it. Adding to a DM fails with
\`conversation_member_add_unsupported\`: its two endpoints are its
membership.

Flags:
  --target    Required. The conversation to add the member to, e.g.
              \`#conv:<conversation_id>\` or
              \`#<workspace>/<title>\`. Copy the \`target=\` token from a
              message header when it is the stream you mean. You must be a participant of it; one you
              cannot see is refused exactly like one that does not exist.
  --handle    Required. Agent or human handle, with or without the
              leading \`@\` (\`alice\` and \`@alice\` are both accepted).
              The same handle namespace chat references use.

stdout: ConversationMembersResponse JSON with the updated members
list (kind/name/display_name etc. for every current member).

Errors:
  target_required (validation)         --target was omitted
  target_malformed (400)               --target is not an address; the
                                       resolver answers this, so the
                                       message names the accepted forms
  target_unresolved (404)              --target names no conversation you
                                       participate in — the same answer an
                                       id nobody holds gets
  thread_suffix_not_supported (400)    --target named a reply cluster
${reachHelpErrorRow('member_add', 39)}  workspace_membership_required (422)  candidate is not a member of
                                       the destination's workspace;
                                       add them at the workspace level
                                       first
  candidate_not_found (404)            no agent or human with that
                                       handle
  handle_ambiguous (422)               handle matches both an agent
                                       and a human in the workspace
                                       — disambiguate at the workspace
                                       level
  conversation_member_add_unsupported  the addressed conversation is a
    (422)                              DM — its two endpoints ARE its
                                       membership
  conversation_closed (409)            conversation is archived/closed
  duplicate                            200 no-op, returns current
                                       members unchanged`,
  flags: ['handle', 'target'] as const,
  async run({ env, client, args }) {
    const target = requireTargetFlag(flagString(args, 'target'), env, {
      command: 'silverhand member add',
      because:
        'a roster change belongs to ONE conversation, and the conversation ' +
        'this CLI is authenticated in is where your credential lives, not a ' +
        'default destination.',
    });
    const handle = flagString(args, 'handle');
    if (!handle) {
      throw new CliError({
        code: 'validation_error',
        subkind: 'missing_required_flag',
        message: 'member add requires --handle <handle>',
        retriable: false,
        details: { command: 'member add', flag: 'handle' },
      });
    }
    return client.addConversationMember({ handle, target });
  },
};

export const memberCommands: readonly Command[] = [addCommand];
