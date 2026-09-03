import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { TASK_TITLE_MAX_LEN, TaskTitleSchema } from '@silverhand/shared';

/**
 * TS oracle for the Rust `TaskTitle` port (task Wave 2B2).
 *
 * The production `TaskTitleSchema` is the ONE authority for the title's
 * canonical form, and Rust re-implements its two halves — the ECMAScript
 * whitespace classifier and the UTF-16 length cap measured on the canonical
 * form. Rust must not author its own expected values for either: this file
 * signs a fixture from the real schema, and the Rust `TaskTitle::parse` tests
 * read the same bytes.
 *
 * Two things are signed, because Rust can get either wrong independently:
 *
 * 1. `ecmascript_whitespace_code_points` — the COMPLETE set, discovered by
 *    sweeping every code point through `/^\s$/u` rather than transcribed from
 *    the spec by hand. Rust sweeps the same space against its own classifier,
 *    so a member it misses AND a non-member it wrongly includes both go red.
 *    This is where U+FEFF (ECMAScript whitespace but NOT Unicode
 *    `White_Space`) and U+0085 NEL (the reverse) are settled — Rust may use
 *    neither `char::is_whitespace` nor `str::trim`.
 * 2. `titles` — end-to-end cases, since a correct classifier is not enough:
 *    `.trim()` and `/\s+/g` must both act on that same set, and the
 *    `.min(1).max(200)` cap must be measured after normalization.
 *
 * Regenerate with `UPDATE_TASK_TITLE_FIXTURE=1`; by default the checked-in
 * fixture is asserted against the live schema, so TS drift goes red here.
 */

const FIXTURE_URL = new URL(
  '../../../../rust/crates/backend-core/src/conversation_messaging/messaging/task/fixtures/task_title_parity.json',
  import.meta.url,
);

/** U+0085 NEL: Unicode `White_Space` but NOT ECMAScript whitespace. */
const NEL = '\u0085';
/** U+180E: Zs in older Unicode, `Cf` today, and never ECMAScript whitespace. */
const MVS = '\u180e';
/** One astral scalar — two UTF-16 code units, which is what `.max()` counts. */
const ASTRAL = '\u{1f600}';

interface TitleCase {
  name: string;
  raw: string;
  /** The schema's canonical output, or `null` when the schema refuses. */
  canonical: string | null;
  /** Which refusal, for the arm Rust must return. `null` on success. */
  refusal: 'empty' | 'too_long' | null;
}

function discoverEcmascriptWhitespace(): number[] {
  const members: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    // Lone surrogates are not scalar values; Rust `char` cannot hold them.
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (/^\s$/u.test(String.fromCodePoint(cp))) members.push(cp);
  }
  return members;
}

function titleInputs(members: number[]): { name: string; raw: string }[] {
  const inputs: { name: string; raw: string }[] = [
    { name: 'plain', raw: 'hello world' },
    { name: 'trim_and_collapse', raw: '  hello   world  ' },
    // A run of two distinct members collapses to ONE space, not two.
    { name: 'crlf_run_is_one_space', raw: 'a\r\nb' },
    { name: 'empty', raw: '' },
    { name: 'all_whitespace_mixed', raw: ' \t\r\n\u3000\ufeff' },
    // Non-members are content: they neither collapse nor trim, and a title
    // made only of them is NOT empty.
    { name: 'nel_is_preserved_at_both_ends', raw: `${NEL}a${NEL}${NEL}b${NEL}` },
    { name: 'nel_only_is_a_valid_title', raw: NEL },
    { name: 'mvs_is_preserved_at_both_ends', raw: `${MVS}a${MVS}${MVS}b${MVS}` },
    { name: 'non_member_adjacent_to_member', raw: `a${NEL} ${NEL}b` },
    // Length cap: measured on the canonical form, in UTF-16 code units.
    { name: 'cap_exactly_at_limit', raw: 'a'.repeat(TASK_TITLE_MAX_LEN) },
    { name: 'cap_one_over_limit', raw: 'a'.repeat(TASK_TITLE_MAX_LEN + 1) },
    { name: 'raw_huge_but_canonical_tiny', raw: `a${' '.repeat(1000)}b` },
    {
      name: 'raw_over_limit_but_canonical_exactly_at_limit',
      raw: `${'a'.repeat(TASK_TITLE_MAX_LEN - 2)}   b`,
    },
    { name: 'astral_exactly_at_limit', raw: ASTRAL.repeat(TASK_TITLE_MAX_LEN / 2) },
    { name: 'astral_one_scalar_over_limit', raw: ASTRAL.repeat(TASK_TITLE_MAX_LEN / 2 + 1) },
    {
      name: 'astral_tips_a_mixed_title_over',
      raw: `${'a'.repeat(TASK_TITLE_MAX_LEN - 1)}${ASTRAL}`,
    },
    {
      name: 'astral_lands_a_mixed_title_exactly_at_limit',
      raw: `${'a'.repeat(TASK_TITLE_MAX_LEN - 2)}${ASTRAL}`,
    },
  ];
  // One case per whitespace member, each covering BOTH ends (trim) and an
  // interior run of that member repeated (collapse) in a single input.
  for (const cp of members) {
    const c = String.fromCodePoint(cp);
    inputs.push({
      name: `member_u${cp.toString(16).padStart(4, '0')}_trims_and_collapses`,
      raw: `${c}a${c}${c}b${c}`,
    });
  }
  return inputs;
}

/** Run the production schema; the result is the signature. */
function sign({ name, raw }: { name: string; raw: string }): TitleCase {
  const parsed = TaskTitleSchema.safeParse(raw);
  if (parsed.success) {
    return { name, raw, canonical: parsed.data, refusal: null };
  }
  const codes = new Set(parsed.error.issues.map((issue) => issue.code));
  const refusal = codes.has('too_small')
    ? 'empty'
    : codes.has('too_big')
      ? 'too_long'
      : (() => {
          throw new Error(`unexpected issue codes for ${name}: ${[...codes].join(',')}`);
        })();
  return { name, raw, canonical: null, refusal };
}

const members = discoverEcmascriptWhitespace();
const live = {
  ecmascript_whitespace_code_points: members,
  titles: titleInputs(members).map(sign),
};

if (process.env.UPDATE_TASK_TITLE_FIXTURE === '1') {
  writeFileSync(FIXTURE_URL, `${JSON.stringify(live, null, 2)}\n`, 'utf8');
}

const checkedIn = JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as typeof live;

describe('task title TS oracle for the Rust port', () => {
  it('signs the complete ECMAScript whitespace set', () => {
    // Guards the fixture against TS-side drift AND against a hand-edited
    // fixture: the checked-in set must be exactly what the live sweep found.
    expect(checkedIn.ecmascript_whitespace_code_points).toEqual(members);
    // The two characters the Unicode `White_Space` set disagrees on, pinned
    // by name so the intent survives a future regeneration.
    expect(members).toContain(0xfeff);
    expect(members).not.toContain(0x85);
    expect(members).not.toContain(0x180e);
  });

  it('signs every title case with the production schema', () => {
    expect(checkedIn.titles).toEqual(live.titles);
  });

  it.each(live.titles)('$name', ({ raw, canonical, refusal }) => {
    const parsed = TaskTitleSchema.safeParse(raw);
    expect(parsed.success).toBe(canonical !== null);
    if (parsed.success) {
      expect(parsed.data).toBe(canonical);
      expect(refusal).toBeNull();
    } else {
      expect(refusal).not.toBeNull();
    }
  });
});
