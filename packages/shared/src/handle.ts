import { z } from 'zod';

/**
 * Handle input grammar for COMMAND / LOOKUP arguments — `member add --handle`,
 * the peer-profile lookup (#task:1823), and any future "name a participant"
 * argument — plus the `@`-normalization those inputs share.
 *
 * A handle names at most one participant: it is globally unique across
 * `users.name` ⊕ `agents.name` (migration v21's cross-namespace uniqueness
 * triggers), so resolvers never disambiguate by kind, they only decide which
 * kinds they are willing to answer for.
 *
 * SCOPE — this is NOT the grammar of an `@mention` in message text. That one
 * lives in `api/message.ts` (`MENTION_RE`) and is deliberately NARROWER: it
 * must survive being embedded in prose, so it is alpha-first with a boundary
 * check (rejecting `me@x`, `a/@b`, `@123`). Every mentionable name satisfies
 * the schema here, not the reverse: `CreateAgentInputSchema.name` admits
 * numeric-first agent names, which are legal lookup targets but are NOT
 * `@`-mentionable until that schema is tightened (a pre-existing gap, noted at
 * `MENTION_RE`, not this module's to close). Do not describe this file as the
 * one grammar for handles everywhere.
 *
 * Grammar and normalization DO belong together here, because they are two
 * halves of one rule for these inputs: the `@` is display sugar that every
 * command input tolerates and no resolver may see. A second copy of either
 * half would be a second authority on what a lookup argument may say.
 */
const HANDLE_PATTERN = /^@?[a-zA-Z0-9_-]{1,64}$/;

export const HandleSchema = z
  .string()
  .trim()
  .regex(HANDLE_PATTERN, {
    message: 'handle must be @optional alphanumeric / dash / underscore',
  });

/**
 * Strip the display `@` (and surrounding whitespace) to get the stored name.
 * Callers pass user/agent-supplied text — a pasted mention (`@alice`) and a
 * bare name (`alice`) must resolve to the same participant.
 */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, '');
}
