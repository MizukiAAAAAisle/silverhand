// The title canonicalizer, the key it derives, and the character domain
// (#task:2016).
//
// `conversations.title_key` carries a UNIQUE index, and that index proves only
// that STORED KEYS are unique — it knows nothing about `title`. The claim "two
// conversations in a workspace cannot show the same title" rests on this module
// being the single canonicalizer, so these tests are the evidence for that claim
// rather than a demonstration of the function:
//
//  - Titles a user would call THE SAME must produce the same key (case, NFC/NFD,
//    padding), and titles they would call DIFFERENT must not.
//  - Every key the canonicalizer can emit must satisfy the weak DB CHECK, so that
//    constraint only ever fires on a key some other code path folded itself.
//  - The validator's verdict is a whole-input accept or reject; it never strips a
//    character to make an input legal.
//
// Invisible code points are written as `\uXXXX` escapes — a test corpus that
// pastes a zero-width joiner raw is a corpus nobody can review, and the file
// would read as binary to half the tooling.
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_TITLE_MAX_CODE_POINTS,
  type CanonicalConversationTitle,
  canonicalizeStoredConversationTitle,
  describeConversationTitleIssue,
  parseConversationTitle,
} from '../src/index.js';

/** The stored key of a title, for comparing addresses. */
function key(title: string): string {
  return canonicalizeStoredConversationTitle(title).key;
}

function accepted(raw: string): string {
  const result = parseConversationTitle(raw);
  if (!result.ok) {
    throw new Error(
      `expected ${JSON.stringify(raw)} to be a legal title, got: ${describeConversationTitleIssue(result.issue)}`,
    );
  }
  return result.value.title;
}

describe('title key: same address (#task:2016)', () => {
  /** Pairs a user would call the same name. Each one is a way two rows could
   *  otherwise both exist and look identical in the sidebar. */
  const SAME: readonly (readonly [string, string, string])[] = [
    ['Design Review', 'design review', 'case'],
    ['DESIGN', 'design', 'case, all caps'],
    ['  design  ', 'design', 'padding'],
    ['\u3000design\u3000', 'design', 'ideographic space padding'],
    ['\u00A0design\u00A0', 'design', 'no-break space padding'],
    ['A\u030A', '\u00C5', 'NFD vs NFC: A + RING ABOVE'],
    ['\u00E5', '\u00C5', 'NFC pair, differing only by case'],
    ['straße', 'STRASSE', 'SHARP S expands to ss and reaches the caps form'],
    ['\u1E9E', 'ss', 'CAPITAL SHARP S'],
    ['\u212Aelvin', 'kelvin', 'KELVIN SIGN vs plain k'],
    ['\u03C3', '\u03C2', 'GREEK SIGMA vs FINAL SIGMA'],
    ['UI/UX 优化', 'ui/ux 优化', 'CJK is caseless, ASCII folds'],
  ];

  for (const [left, right, why] of SAME) {
    it(`treats ${JSON.stringify(left)} and ${JSON.stringify(right)} as one address — ${why}`, () => {
      expect(key(left)).toBe(key(right));
    });
  }
});

describe('title key: different addresses (#task:2016)', () => {
  /** Pairs that must stay two addresses. The last one is a KNOWN confusable that
   *  is deliberately not folded: NBSP inside a title is preserved, so two titles
   *  can look alike — the same class as Cyrillic `а` vs Latin `a`, ruled out of
   *  scope on this ticket. Only edge padding is trimmed. */
  const DIFFERENT: readonly (readonly [string, string, string])[] = [
    ['design', 'designs', 'plural'],
    ['design', 'de sign', 'interior space'],
    ['\u1E9B', 'ss', 'LONG S WITH DOT ABOVE folds to a letter, not to ss'],
    ['\u0131', 'i', 'DOTLESS I is not folded to i — that would be a Turkic rule'],
    ['design\u00A0review', 'design review', 'NBSP vs SPACE: not folded'],
  ];

  for (const [left, right, why] of DIFFERENT) {
    it(`keeps ${JSON.stringify(left)} and ${JSON.stringify(right)} apart — ${why}`, () => {
      expect(key(left)).not.toBe(key(right));
    });
  }
});

describe('canonicalizer contract (#task:2016)', () => {
  const CORPUS = [
    'Design Review',
    '  padded  ',
    'UI/UX 优化',
    'straße',
    '\u1E9E',
    'A\u030A',
    '\u212A',
    '100% 🚀',
    '#2016',
    'a'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS),
  ];

  it('leaves an already-normalized title BYTE-IDENTICAL', () => {
    // The migration's headline promise: with no folded collisions, no user's
    // `title` changes. Only un-normalized or padded input is rewritten.
    for (const title of ['Design Review', 'UI/UX 优化', '\u1E9E', '#2016']) {
      expect(canonicalizeStoredConversationTitle(title).title).toBe(title);
    }
  });

  it('emits keys the weak DB CHECK can never fire on', () => {
    // `CHECK (title_key <> '' AND title_key NOT GLOB '*[A-Z]*'
    //        AND title_key NOT GLOB ' *' AND title_key NOT GLOB '* ')`.
    // The CHECK exists to catch a write path that forgot to fold or to trim, so
    // it must be unreachable from this module's own output — otherwise a legal
    // title becomes an insert failure.
    for (const title of CORPUS) {
      const stored = key(title);
      expect(stored).not.toBe('');
      expect(stored).not.toMatch(/[A-Z]/);
      expect(stored.startsWith(' ')).toBe(false);
      expect(stored.endsWith(' ')).toBe(false);
    }
  });

  it('is idempotent: re-keying a stored title reproduces the stored key', () => {
    // What the integrity scan does on every row. If this were not stable, the
    // scan would report half-states that do not exist.
    for (const title of CORPUS) {
      const once = canonicalizeStoredConversationTitle(title);
      const twice = canonicalizeStoredConversationTitle(once.title);
      expect(twice.key).toBe(once.key);
      expect(twice.title).toBe(once.title);
    }
  });

  it('keys titles the VALIDATOR rejects, because stored rows predate it', () => {
    // Keying is total; validation gates new writes only. Rows written under the
    // old `trim().min(1).max(128)` rule can hold anything, and the backfill has
    // to key every one of them or the migration fails on legal existing data.
    const legacy = '👨\u200D👩\u200D👧'; // family, a ZWJ sequence
    expect(parseConversationTitle(legacy).ok).toBe(false);
    expect(canonicalizeStoredConversationTitle(legacy).key).not.toBe('');
  });
});

describe('title validator: admissible (#task:2016)', () => {
  const POSITIVE: readonly (readonly [string, string])[] = [
    ['优化', 'CJK'],
    ['café talk', 'accented Latin'],
    ['UI/UX 优化', 'a slash — escaping is the codec’s job, not a ban'],
    ['100% done', 'a percent sign'],
    ['design review', 'spaces'],
    ['#2016', 'a hash: a title may look like another syntax'],
    ['2026 roadmap', 'digits — `\\p{Emoji}` would have matched these'],
    ['*', 'an asterisk — same trap'],
    ['🚀', 'single-code-point pictograph: ROCKET'],
    ['✅', 'single-code-point pictograph: WHITE HEAVY CHECK MARK'],
    ['❤', 'HEAVY BLACK HEART with NO variation selector'],
    ['a'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS), 'exactly at the limit'],
    ['🚀'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS), 'astral: 128 code points, 256 UTF-16 units'],
  ];

  for (const [title, why] of POSITIVE) {
    it(`accepts ${JSON.stringify(title)} — ${why}`, () => {
      expect(accepted(title)).toBe(title.normalize('NFC').trim());
    });
  }
});

describe('title validator: refused (#task:2016)', () => {
  const NEGATIVE: readonly (readonly [string, string, string])[] = [
    ['', 'empty', 'nothing to address'],
    ['   ', 'empty', 'whitespace only, after trim'],
    ['\u3000', 'empty', 'ideographic space only'],
    ['a'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS + 1), 'too_long', 'one code point over'],
    ['👨\u200D👩', 'forbidden_code_point', 'ZWJ sequence'],
    ['👍\u{1F3FB}', 'forbidden_code_point', 'skin-tone modifier'],
    ['1\uFE0F\u20E3', 'forbidden_code_point', 'keycap sequence'],
    ['1\u20E3', 'forbidden_code_point', 'keycap without the variation selector'],
    ['\u{1F1E8}\u{1F1F3}', 'forbidden_code_point', 'flag: regional indicators'],
    ['❤\uFE0F', 'forbidden_code_point', 'heart WITH variation selector-16'],
    ['\u202Egnisaeler', 'forbidden_code_point', 'RIGHT-TO-LEFT OVERRIDE spoof'],
    ['de\u00ADsign', 'forbidden_code_point', 'SOFT HYPHEN'],
    ['de\u200Bsign', 'forbidden_code_point', 'ZERO WIDTH SPACE'],
    ['de\u200Csign', 'forbidden_code_point', 'ZERO WIDTH NON-JOINER (named cost)'],
    ['de\u0007sign', 'forbidden_code_point', 'a raw control byte'],
    ['de\uFEFFsign', 'forbidden_code_point', 'BYTE ORDER MARK'],
    ['de\uD800sign', 'forbidden_code_point', 'lone surrogate'],
    ['de\uE000sign', 'forbidden_code_point', 'private use'],
    ['de\uFDD0sign', 'forbidden_code_point', 'noncharacter'],
  ];

  for (const [title, kind, why] of NEGATIVE) {
    it(`refuses ${JSON.stringify(title)} as ${kind} — ${why}`, () => {
      const result = parseConversationTitle(title);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issue.kind).toBe(kind);
      // The message has to name the offender: "no invisible characters" is
      // unactionable when the user cannot see which one.
      if (result.issue.kind === 'forbidden_code_point') {
        expect(describeConversationTitleIssue(result.issue)).toContain(
          `U+${result.issue.codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
        );
      }
    });
  }

  it('rejects the WHOLE input instead of stripping the offender', () => {
    // `❤` + VS16 is refused; the bare `❤` is legal. Silently dropping the
    // selector would edit the user's display title and would be a third
    // normalization step nobody declared.
    expect(parseConversationTitle('❤\uFE0F').ok).toBe(false);
    expect(accepted('❤')).toBe('❤');
  });

  it('counts length in code points, not UTF-16 units', () => {
    const astral = '🚀'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS);
    expect(astral.length).toBe(CONVERSATION_TITLE_MAX_CODE_POINTS * 2);
    expect(parseConversationTitle(astral).ok).toBe(true);
    const overflow = parseConversationTitle(astral + '🚀');
    expect(overflow.ok).toBe(false);
    if (!overflow.ok && overflow.issue.kind === 'too_long') {
      expect(overflow.issue.codePoints).toBe(CONVERSATION_TITLE_MAX_CODE_POINTS + 1);
    }
  });

  it('measures length AFTER normalization, so padding is not charged', () => {
    const padded = `  ${'a'.repeat(CONVERSATION_TITLE_MAX_CODE_POINTS)}  `;
    expect(parseConversationTitle(padded).ok).toBe(true);
  });
});

// Property 2 of the conjunction, and exactly how much of it the COMPILER carries
// (#task:2016).
//
// `tsconfig.json` includes `tests`, so `@ts-expect-error` here is a real
// assertion: `pnpm --filter @silverhand/shared typecheck` fails if any of these
// lines starts compiling. What is pinned is that a terminal writer cannot be
// handed a pair that was never derived by this module — no hand-built object, no
// key belonging to another title, no bare string.
//
// THE ONE HOLE, stated rather than implied: the brand is a declared property, so
// spreading a pair you ALREADY HOLD copies it (`{ ...pair, key: 'ops' }`
// type-checks). Closing that needs a class with a `#private` field, which buys a
// nominal type and costs an unread member whose only reader would be a test. It is
// not worth it, because the consequence — not the construction — is what has
// coverage: a mismatched pair still has to reach SQL, and both write points are
// pinned by `packages/backend/tests/guard-conversation-title-paired-write.test.ts`
// while `auditConversationTitleAddresses` fails boot closed on any row that got
// through. A brand constrains arguments; it never had authority over raw SQL.
describe('CanonicalConversationTitle is unforgeable (#task:2016)', () => {
  /** Stands in for `ConversationRepo.updateTitle` — same parameter, no database. */
  function terminalWriter(_pair: CanonicalConversationTitle): void {}

  it('accepts only a pair the canonicalizer produced', () => {
    const pair = canonicalizeStoredConversationTitle('Design');
    terminalWriter(pair);

    // @ts-expect-error a hand-built object has no brand, however right it looks.
    terminalWriter({ title: 'Design', key: 'design' });
    // @ts-expect-error one title's text paired with another title's key.
    terminalWriter({ title: 'Design', key: 'ops' });
    // @ts-expect-error a title with no key at all.
    terminalWriter({ title: 'Design' });
    // @ts-expect-error the validator's ACCEPTED value is the pair, not a string.
    terminalWriter('Design');

    expect(pair.key).toBe('design');
  });
});
