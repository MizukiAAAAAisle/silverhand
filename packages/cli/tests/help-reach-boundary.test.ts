/**
 * #task:2021 P4-4 — the reach clause in shipping `--help` IS the ruling, not a copy
 * of it (@Cindy B2, 2026-08-15).
 *
 * The earlier version of this gate asserted VOCABULARY: that a confined door's help
 * mentions `slot_out_of_scope` and the words "agent-scoped session" somewhere. That
 * passes against a sentence rewritten into its own opposite — "a conversation-scoped
 * session reaches any conversation; an agent-scoped session is refused
 * `slot_out_of_scope`" keeps both tokens and inverts the product ruling. Token
 * presence cannot distinguish a claim from its negation, so it is not a gate on the
 * claim.
 *
 * What is asserted now, in the only two directions that can go wrong:
 *
 *   1. THE WHOLE SENTENCE, generated from `DELIVERY_REACH` by
 *      `src/reach-help.ts`, appears verbatim in the door's help. Not a substring of
 *      it, not its keywords — the text a renderer that reads the table produces. An
 *      inverted sentence fails because it is a different sentence.
 *   2. NOWHERE ELSE. Strip the generated clause and the reach vocabulary is gone
 *      from that help block entirely. This is what keeps (1) honest: a hand-written
 *      second copy could otherwise sit beside the generated one, drift from it, and
 *      still leave (1) green — the copy being the sentence agents actually read.
 *
 * Together they make the shipping sentence exist in exactly one place, which is the
 * claim the task body and the source docblocks make. Alignment is excluded on
 * purpose: matching runs on whitespace-flattened text, because which column a table
 * row starts in is a local layout fact of the block it is filed in and carries no
 * part of the ruling.
 *
 * Direction 3, unchanged from before: a door the ruling leaves OPEN must not claim
 * confinement. That failure teaches an agent to decline work it may do, which no
 * runtime error would ever correct.
 *
 * The door → help mapping is a `Record<AddressedOperation, …>`, so a new addressed
 * door cannot be added to the ruling without deciding which help block teaches it.
 */
import { describe, expect, it } from 'vitest';
import {
  ADDRESSED_OPERATIONS,
  DELIVERY_REACH,
  SLOT_REACH_REFUSAL_CODE,
  reachTaughtCommands,
  type AddressedOperation,
} from '@silverhand/shared';
import { verbHelp } from '../src/help.js';
import { reachHelpErrorEntry, reachHelpParagraph } from '../src/reach-help.js';

/** Which `--help` block an agent reads before using each addressed door. */
const HELP_FOR_DOOR: Record<AddressedOperation, readonly [string, string]> = {
  message_send: ['message', 'send'],
  message_history: ['message', 'history'],
  task_create: ['task', 'create'],
  schedule_create: ['schedule', 'create'],
  channel_fork_source: ['channel', 'create'],
  file_upload: ['file', 'upload'],
  member_add: ['member', 'add'],
};

/**
 * Which of the two renderings each confined door uses.
 *
 * The gate has to know, because the two produce different text from the same datum
 * and "the clause is present" is only checkable against the one that shipped. It is
 * NOT a second source of truth for the boundary: whether a door has a clause at all
 * still comes from the table, and a door listed here whose cell is open renders
 * `null` and is skipped.
 */
const RENDERING: Partial<Record<AddressedOperation, () => string | null>> = {
  message_send: () => reachHelpParagraph('message_send'),
  // The column is the calling block's, so the row is generated at the same width
  // it ships at. Comparison flattens anyway; this keeps the two texts identical
  // before flattening too, so a failure diff reads as prose.
  file_upload: () => reachHelpErrorEntry('file_upload', 37),
  member_add: () => reachHelpErrorEntry('member_add', 39),
  channel_fork_source: () => reachHelpErrorEntry('channel_fork_source', 39),
};

function helpFor(operation: AddressedOperation): string {
  const [noun, verb] = HELP_FOR_DOOR[operation];
  return verbHelp(noun, verb) ?? '';
}

/** Help is hand-wrapped into aligned columns, so any phrase long enough to be
 *  worth asserting is split across lines. Matching runs on the flattened text. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The words a reader recognises the boundary by. Direction 2 asserts these live
 *  only inside the generated clause — they are the material a drifting hand-written
 *  copy would necessarily be made of. */
const REACH_VOCABULARY = [
  SLOT_REACH_REFUSAL_CODE,
  'agent-scoped session',
  'session is anchored',
  'anchored to',
] as const;

const isConfined = (operation: AddressedOperation): boolean =>
  DELIVERY_REACH[operation].conversation_slot === 'own_stream';

describe('CLI help teaches the reach boundary it will be refused by', () => {
  it('renders a real help block for every addressed door', () => {
    // Otherwise every assertion below passes against the empty string.
    for (const operation of ADDRESSED_OPERATIONS) {
      expect(helpFor(operation).length, operation).toBeGreaterThan(200);
    }
  });

  it('every confined door has a rendering, and no open door has one', () => {
    // The join between table and help blocks, checked in both directions so a
    // newly-confined cell cannot be silently unrepresented here.
    for (const operation of ADDRESSED_OPERATIONS) {
      expect(RENDERING[operation]?.() != null, operation).toBe(isConfined(operation));
    }
  });

  for (const operation of ADDRESSED_OPERATIONS) {
    if (!isConfined(operation)) continue;

    it(`${operation}: help contains the generated clause, whole`, () => {
      const clause = RENDERING[operation]!()!;
      expect(flat(helpFor(operation)), operation).toContain(flat(clause));
    });

    it(`${operation}: and says it nowhere else — one sentence, one source`, () => {
      const clause = RENDERING[operation]!()!;
      const help = flat(helpFor(operation));
      const pieces = help.split(flat(clause));
      expect(pieces, `${operation}: exactly one reach clause`).toHaveLength(2);
      const remainder = pieces.join(' ');
      for (const token of REACH_VOCABULARY) {
        expect(remainder, `${operation} / ${token}`).not.toContain(token);
      }
    });
  }

  for (const operation of ADDRESSED_OPERATIONS) {
    if (isConfined(operation)) continue;
    it(`${operation}: help does not claim a confinement it does not have`, () => {
      expect(helpFor(operation)).not.toContain(SLOT_REACH_REFUSAL_CODE);
    });
  }

  it('the ruling still confines something (the gate is not vacuous)', () => {
    // An all-open table would leave every loop above with nothing to check, which
    // is exactly the edit this whole shard exists to make impossible to land
    // quietly.
    const { confined, participation } = reachTaughtCommands('conversation_slot');
    expect(confined.length).toBeGreaterThan(0);
    expect(participation.length).toBeGreaterThan(0);
  });

  it('the clause states the boundary in the ruled direction, not its inverse', () => {
    // Direction (1) compares generated text to shipped text, so it cannot catch an
    // inversion made in the RENDERER — both sides would move together. This pins
    // the renderer's own semantics: it is the conversation-scoped credential that
    // is confined and the agent-scoped one that is not, per the table.
    const clause = flat(reachHelpParagraph('message_send')!);
    const confinedAt = clause.indexOf('conversation-scoped session');
    const freeAt = clause.indexOf('An agent-scoped session may');
    expect(confinedAt).toBeGreaterThanOrEqual(0);
    expect(freeAt).toBeGreaterThanOrEqual(0);
    expect(clause.slice(confinedAt, freeAt)).toContain('acts only in the stream');
    expect(clause.slice(freeAt)).toContain('any conversation it participates in');
    expect(clause.slice(freeAt)).not.toContain(SLOT_REACH_REFUSAL_CODE);
  });
});
