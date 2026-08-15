/**
 * The reach boundary as `--help` text, GENERATED from the ruling (#task:2021 P4-4).
 *
 * Every door that teaches the boundary interpolates one of these two renderers, so
 * the sentence exists exactly once in this package. That is the whole point: a
 * hand-written copy per door can be edited into its own opposite — "this door acts
 * on any conversation you participate in", with `slot_out_of_scope` still spelled
 * somewhere in the block — and no test that looks for VOCABULARY would notice. The
 * only defense that scales is for the command modules to not contain the words at
 * all.
 *
 * Both renderers answer `null` for a door the ruling leaves open, and the answer is
 * read from `DELIVERY_REACH` rather than from a list of door names. So flipping a
 * cell to `agent_participation` deletes the clause from the shipping help in the
 * same edit, and flipping one to `own_stream` makes the gate demand it.
 *
 * Two shapes because help blocks have two, and both are load-bearing where they
 * sit: prose for a door whose confinement is part of understanding what the door IS
 * (`message send`), and a row in the `Errors:` table for a door where the actor
 * arrives at the boundary as a refusal code to look up. Same datum, same claim; the
 * layout differs, the semantics cannot.
 */
import {
  DELIVERY_REACH,
  SLOT_REACH_REFUSAL_CODE,
  type AddressedOperation,
} from '@silverhand/shared';

/**
 * What an agent-scoped session does with the stream it reaches, per door.
 *
 * A `Record` and not a generic verb, because the alternative sentence reads
 * "an agent-scoped session may act on any conversation it participates in" for a
 * door named `member add` — vague exactly where the actor is deciding whether to
 * try. Exhaustive by type: a new addressed door cannot be ruled without saying
 * what reaching means for it. Base form; both renderings read `may <verb>`.
 */
const CROSS_STREAM_VERB: Record<AddressedOperation, string> = {
  message_send: 'send to',
  message_history: 'read',
  task_create: 'file tasks in',
  schedule_create: 'wake',
  channel_fork_source: 'fork',
  file_upload: 'upload to',
  member_add: 'add members to',
};

/** Is this door confined for the credential that can be confined? The AgentSlot
 *  column never is, so it is not consulted: help that named a boundary an
 *  agent-scoped session does not have would teach it to decline work it may do. */
function confined(operation: AddressedOperation): boolean {
  return DELIVERY_REACH[operation].conversation_slot === 'own_stream';
}

/**
 * The prose paragraph, wrapped for a help block. `null` when the door is open.
 *
 * It states three facts and no advice: the limit exists, membership does not lift it
 * (the mistake the 403 alone invites), and the other credential is not limited —
 * without which "refused" reads as "never" and the doors that ARE open go unused.
 * Manual voice, per @shiki 2026-08-15: conditions, action, error code; no
 * conversational suggestion about what to do instead.
 */
export function reachHelpParagraph(operation: AddressedOperation): string | null {
  if (!confined(operation)) return null;
  const verb = CROSS_STREAM_VERB[operation];
  return `Reach: from a conversation-scoped session this door acts only in the
stream your session is anchored to. Another conversation is refused
\`${SLOT_REACH_REFUSAL_CODE}\` (403), including one you are a member of and
can read. An agent-scoped session may ${verb} any conversation it
participates in.`;
}

/**
 * The same claim as one entry of an `Errors:` table. `null` when the door is open.
 *
 * `textColumn` is where the calling block's description column starts, because the
 * row has to line up with the neighbours it is filed between — a local layout fact,
 * and the only thing a door gets to decide about this clause. The gate compares on
 * whitespace-flattened text for that reason: alignment is not a claim.
 */
export function reachHelpErrorEntry(
  operation: AddressedOperation,
  textColumn: number,
): string | null {
  if (!confined(operation)) return null;
  const label = `  ${SLOT_REACH_REFUSAL_CODE} (403)`;
  const indent = ' '.repeat(textColumn);
  const sentence =
    '--target named another conversation and this door acts only where a ' +
    'conversation-scoped session is anchored; an agent-scoped session may ' +
    `${CROSS_STREAM_VERB[operation]} any conversation it participates in`;
  const width = 78 - textColumn;
  const lines: string[] = [];
  let current = '';
  for (const word of sentence.split(' ')) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines
    .map((line, index) =>
      index === 0 ? label.padEnd(textColumn) + line : indent + line,
    )
    .join('\n');
}

/**
 * The two renderers again, as something a template literal can hold: the clause
 * plus the separator that follows it, or nothing at all.
 *
 * Separate from the renderers above so that "what the clause SAYS" and "how it is
 * spliced into a block" stay different questions. The gate asserts the first; only
 * these two functions know that an absent clause must take its blank line with it,
 * which is why an open door leaves no ragged gap in shipping help.
 */
export function reachHelpParagraphSection(operation: AddressedOperation): string {
  const paragraph = reachHelpParagraph(operation);
  return paragraph === null ? '' : `${paragraph}\n\n`;
}

export function reachHelpErrorRow(
  operation: AddressedOperation,
  textColumn: number,
): string {
  const entry = reachHelpErrorEntry(operation, textColumn);
  return entry === null ? '' : `${entry}\n`;
}
