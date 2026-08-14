// Conversation NAME grammar and derivation (#task:2016).
//
// The name is the addressable half of a conversation's identity, so the tests
// that matter are the ones that pin the DOMAIN: what is admissible, that the
// deriver's own entrances are closed, and that a derived name is spellable as a
// CHANNEL in chat. A deriver that can emit a name the schema rejects would fail
// the v72 backfill halfway through, on somebody's data, with no way to tell in
// advance.
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_NAME_FALLBACK,
  CONVERSATION_NAME_STEM_MAX_LENGTH,
  ConversationNameSchema,
  ENTITY_NAME_MAX_LENGTH,
  disambiguateConversationName,
  slugifyConversationTitle,
} from '../src/index.js';

/** Titles chosen to attack the deriver, not to demonstrate it: every one of
 *  them exists in some form in the live database or is one keystroke away. */
const ADVERSARIAL_TITLES = [
  'design',
  'Design Review',
  '  Design   Review!!  ',
  'UI/UX 优化',
  '优化',
  '🎨',
  '---',
  '___',
  '#conv:QVI9x6vU_K1a9oN9',
  '@Alice',
  '2026-08-14',
  '2026 roadmap',
  '42',
  '2',
  '0',
  'a',
  '',
  ' ',
  'agent dm agent',
  'ünïcödé',
  'a'.repeat(200),
  `${'a'.repeat(CONVERSATION_NAME_STEM_MAX_LENGTH)}-tail`,
  `${'a'.repeat(CONVERSATION_NAME_STEM_MAX_LENGTH - 1)}-tail`,
  '2'.repeat(200),
  'naïve café',
  'C:\\Users\\shiki',
];

describe('ConversationNameSchema (#task:2016)', () => {
  it('admits lowercase addressable names', () => {
    for (const name of [
      'a',
      'design',
      'ui-ux',
      'ui_ux',
      'design-review-2',
      'a'.repeat(ENTITY_NAME_MAX_LENGTH),
    ]) {
      expect(ConversationNameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it('refuses everything that would make two names look alike or unspellable', () => {
    for (const name of [
      '', // no empty address
      'Design', // uppercase: binary equality must mean visual equality
      '-design', // leading separator is invisible in a chip
      'design-', // as is a trailing one
      '_design',
      'design_',
      'design review', // not capturable by the `#` tokenizer
      '#design',
      'design!',
      '优化', // outside the tokenizer's character class
      'a'.repeat(ENTITY_NAME_MAX_LENGTH + 1),
      // Digit-leading names are the B4 case: `#2` is inert and `#42` is TASK 42,
      // so admitting them would mint addresses that point elsewhere.
      '2',
      '42',
      '2026-roadmap',
    ]) {
      expect(ConversationNameSchema.safeParse(name).success, name).toBe(false);
    }
  });
});

describe('slugifyConversationTitle (#task:2016)', () => {
  it('derives the obvious name for an ASCII title', () => {
    expect(slugifyConversationTitle('design')).toBe('design');
    expect(slugifyConversationTitle('Design Review')).toBe('design-review');
    expect(slugifyConversationTitle('  Design   Review!!  ')).toBe(
      'design-review',
    );
    expect(slugifyConversationTitle('agent dm agent')).toBe('agent-dm-agent');
  });

  it('keeps the ASCII words of a mixed title instead of discarding it', () => {
    // The live channel `UI/UX 优化` is the case that decides this: dropping the
    // whole title because part of it is CJK would name it `channel`.
    expect(slugifyConversationTitle('UI/UX 优化')).toBe('ui-ux');
  });

  it('prefixes a digit-leading slug instead of minting a task-shaped address', () => {
    expect(slugifyConversationTitle('2026 roadmap')).toBe(
      'channel-2026-roadmap',
    );
    expect(slugifyConversationTitle('42')).toBe('channel-42');
    expect(slugifyConversationTitle('2026-08-14')).toBe('channel-2026-08-14');
  });

  it('falls back to a predictable word when nothing admissible survives', () => {
    for (const title of ['优化', '🎨', '---', '', ' ']) {
      expect(slugifyConversationTitle(title), title).toBe(
        CONVERSATION_NAME_FALLBACK,
      );
    }
  });

  it('truncates to the stem budget and never ends on the cut separator', () => {
    const long = slugifyConversationTitle('a'.repeat(200));
    expect(long).toHaveLength(CONVERSATION_NAME_STEM_MAX_LENGTH);
    // A cut landing exactly on a separator must not leave it dangling.
    const cutOnSeparator = slugifyConversationTitle(
      `${'a'.repeat(CONVERSATION_NAME_STEM_MAX_LENGTH)} tail`,
    );
    expect(cutOnSeparator).toBe('a'.repeat(CONVERSATION_NAME_STEM_MAX_LENGTH));
    // The digit prefix is added BEFORE the cut, so it cannot push the result
    // past the budget the disambiguating suffix depends on.
    const prefixed = slugifyConversationTitle('2'.repeat(200));
    expect(prefixed).toHaveLength(CONVERSATION_NAME_STEM_MAX_LENGTH);
    expect(prefixed.startsWith(`${CONVERSATION_NAME_FALLBACK}-2`)).toBe(true);
  });

  it('is deterministic: same title, same name (the two paths depend on it)', () => {
    for (const title of ADVERSARIAL_TITLES) {
      expect(slugifyConversationTitle(title)).toBe(
        slugifyConversationTitle(title),
      );
    }
  });

  it('representative falsifiers: no adversarial title derives an inadmissible name', () => {
    // A finite table cannot PROVE the range is inside the domain — that comes
    // from the deriver's construction (documented step by step in the module)
    // plus the boundary checks in `disambiguateConversationName`. What this
    // table is good for is refutation: each entry is a shape that has broken a
    // slug rule in some system, so a regression on any of them shows up here.
    for (const title of ADVERSARIAL_TITLES) {
      const derived = slugifyConversationTitle(title);
      expect(ConversationNameSchema.safeParse(derived).success, title).toBe(
        true,
      );
    }
  });

  it('spells every derived name as a CHANNEL in the chat tokenizer', () => {
    // The renderer's `REF_RE` (`Markdown.tsx`) cannot be imported here, so its
    // two competing alternatives are restated literally — and BOTH directions
    // are checked, because it is their overlap that mints a wrong address:
    // channel = `#[a-zA-Z][a-zA-Z0-9_-]*`, bare task = `#(1[1-9]|[2-9]\d|[1-9]\d{2,})`.
    // Restating only the character class (`[a-zA-Z0-9_-]+`) is what let
    // digit-leading names look fine (@Cindy, B4).
    const channelForm = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
    const bareTaskForm = /^(?:1[1-9]|[2-9]\d|[1-9]\d{2,})$/;
    for (const title of [...ADVERSARIAL_TITLES, '2026 roadmap', '42']) {
      const derived = slugifyConversationTitle(title);
      expect(channelForm.test(derived), title).toBe(true);
      expect(bareTaskForm.test(derived), title).toBe(false);
    }
  });
});

describe('disambiguateConversationName (#task:2016)', () => {
  it('spells the nth allocation of a stem', () => {
    expect(disambiguateConversationName('design', 2)).toBe('design-2');
    expect(disambiguateConversationName('design', 10)).toBe('design-10');
    expect(disambiguateConversationName(CONVERSATION_NAME_FALLBACK, 3)).toBe(
      'channel-3',
    );
  });

  it('stays inside the length domain for any admissible stem and ordinal', () => {
    const stem = 'a'.repeat(CONVERSATION_NAME_STEM_MAX_LENGTH);
    for (const ordinal of [2, 99, 1000, 123456, Number.MAX_SAFE_INTEGER]) {
      const name = disambiguateConversationName(stem, ordinal);
      expect(name.length, name).toBeLessThanOrEqual(ENTITY_NAME_MAX_LENGTH);
      expect(ConversationNameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it('does not leave a separator against the suffix when the head is cut', () => {
    // `…-` + `-2` would read as `--2`; the head is trimmed first.
    const stem = `${'a'.repeat(ENTITY_NAME_MAX_LENGTH - 4)}-bcd`;
    const name = disambiguateConversationName(stem, 2);
    expect(name).not.toContain('--');
    expect(ConversationNameSchema.safeParse(name).success, name).toBe(true);
  });

  it('refuses an ordinal that is not a safe integer >= 2', () => {
    // The v72 backfill's only deriver must not have an out-of-domain entrance
    // of its own: every one of these formats into a string the name schema
    // rejects, and a silent one would surface as a failed INSERT mid-migration.
    for (const ordinal of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2.5,
      -3,
      0,
      1,
      1e21,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      expect(
        () => disambiguateConversationName('design', ordinal),
        String(ordinal),
      ).toThrow(/safe integer/);
    }
  });

  it('refuses a stem that is not already an admissible name', () => {
    for (const stem of ['', 'Design', '-design', 'design-', '2026', '优化']) {
      expect(
        () => disambiguateConversationName(stem, 2),
        stem,
      ).toThrow(/admissible conversation name/);
    }
  });

  it('representative falsifiers: any derived stem survives disambiguation', () => {
    for (const title of ADVERSARIAL_TITLES) {
      const name = disambiguateConversationName(
        slugifyConversationTitle(title),
        7,
      );
      expect(ConversationNameSchema.safeParse(name).success, title).toBe(true);
    }
  });
});
