import { z } from 'zod';
import { ParticipantNameSchema } from './api/name.js';

/**
 * Handle input grammar for COMMAND / LOOKUP arguments — `member add --handle`,
 * the peer-profile lookup (#task:1823), and any future "name a participant"
 * argument. It wraps the stored {@link ParticipantNameSchema} with input-only
 * affordances: surrounding whitespace and one optional display `@`.
 *
 * A handle names at most one participant: it is globally unique across
 * `users.name` ⊕ `agents.name` (migration v21's cross-namespace uniqueness
 * triggers), so resolvers never disambiguate by kind, they only decide which
 * kinds they are willing to answer for.
 *
 * SCOPE — this is an ARGUMENT grammar, not a message-text one. Who a message
 * addresses is decided by `reference.ts` + `reference-markdown.ts` from a
 * canonical `<silverhand://<kind>/<name>>` autolink, and the display-only
 * `@name` alias is `PLAIN_MENTION_PATTERN` in `api/message.ts`. All three share
 * `PARTICIPANT_HANDLE_PATTERN`'s character grammar; none of them defines which
 * stored names are legal.
 *
 * Grammar and normalization DO belong together here, because they are two
 * halves of one rule for these inputs: the `@` is display sugar that every
 * command input tolerates and no resolver may see. A second copy of either
 * half would be a second authority on what a lookup argument may say.
 */
export const HandleSchema = z
  .string()
  .trim()
  .refine(
    handle => ParticipantNameSchema.safeParse(normalizeHandle(handle)).success,
    {
      message:
        'handle must start with a letter and contain only letters, numbers, dash, or underscore; one leading @ is allowed',
    },
  );

/**
 * Strip the display `@` (and surrounding whitespace) to get the stored name.
 * Callers pass user/agent-supplied text — a pasted mention (`@alice`) and a
 * bare name (`alice`) must resolve to the same participant.
 */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, '');
}
