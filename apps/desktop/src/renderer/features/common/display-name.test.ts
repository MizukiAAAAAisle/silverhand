import { describe, expect, it } from 'vitest';
import { DISPLAY_NAME_MAX_LENGTH } from '@silverhand/shared';
import { readDisplayNameDraft, rejectDisplayName } from './display-name';

/**
 * Behaviour of the shared display-name gate, the one thing standing
 * between a `display_name` editor and a doomed request (#task:1846).
 * Two things must hold: the boundary is the schema's boundary, and the
 * characters an `<input>` cannot filter are caught here rather than
 * server-side.
 *
 * Invisible code points are written as `\uXXXX` escapes throughout —
 * pasted verbatim they are invisible in this file too, and a reader
 * cannot tell one sample from another.
 */

const atMax = 'a'.repeat(DISPLAY_NAME_MAX_LENGTH);
const overMax = 'a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1);

/** Every class of character the schema's refinement rejects. */
const INVISIBLE_SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['LINE SEPARATOR', 'Ada\u2028Lovelace'],
  ['PARAGRAPH SEPARATOR', 'Ada\u2029Lovelace'],
  ['NEL', 'Ada\u0085L'],
  ['DEL', 'Ada\u007fL'],
  ['C0 control', 'Ada\u0001L'],
];

describe('readDisplayNameDraft — what Save would do', () => {
  it('treats an untouched field as nothing to save', () => {
    expect(readDisplayNameDraft(null, 'Ada')).toEqual({ kind: 'pristine' });
  });

  it('submits a name of exactly the maximum length', () => {
    expect(readDisplayNameDraft(atMax, 'Ada')).toEqual({
      kind: 'ready',
      value: atMax,
    });
  });

  it('refuses one character past the maximum, naming the limit', () => {
    const state = readDisplayNameDraft(overMax, 'Ada');
    expect(state.kind).toBe('rejected');
    expect(state.kind === 'rejected' && state.message).toContain(
      String(DISPLAY_NAME_MAX_LENGTH),
    );
  });

  it('submits the trimmed value, not what was typed', () => {
    expect(readDisplayNameDraft('  Ada Lovelace  ', 'Ada')).toEqual({
      kind: 'ready',
      value: 'Ada Lovelace',
    });
  });

  it('counts the length after trimming, so padding does not push it over', () => {
    // Otherwise a value the server would accept looks too long here.
    expect(readDisplayNameDraft(`  ${atMax}  `, 'Ada')).toEqual({
      kind: 'ready',
      value: atMax,
    });
  });

  it('says nothing about a blank field, and does not offer to save it', () => {
    for (const blank of ['', '   ', '\t']) {
      expect(readDisplayNameDraft(blank, 'Ada')).toEqual({ kind: 'empty' });
    }
  });

  it('does not save a draft that trims back to the persisted value', () => {
    expect(readDisplayNameDraft(' Ada ', 'Ada')).toEqual({ kind: 'unchanged' });
  });

  it('refuses invisible characters a single-line input keeps', () => {
    // CR/LF never reach a draft — the browser drops them. These do, by
    // paste, and only the schema's refinement rejects them.
    for (const [label, raw] of INVISIBLE_SAMPLES) {
      const state = readDisplayNameDraft(raw, 'Ada');
      expect(state.kind, label).toBe('rejected');
      // The viewer cannot see the character, so the editor must show a
      // message rather than silently disabling its Save.
      expect(state.kind === 'rejected' && state.message.length).toBeGreaterThan(0);
    }
  });
});

describe('rejectDisplayName — validity half, for editors with their own empty check', () => {
  it('accepts a name at the maximum and refuses one past it', () => {
    expect(rejectDisplayName(atMax)).toBeNull();
    expect(rejectDisplayName(overMax)).not.toBeNull();
  });

  it('refuses every invisible sample', () => {
    for (const [label, raw] of INVISIBLE_SAMPLES) {
      expect(rejectDisplayName(raw), label).not.toBeNull();
    }
  });

  it('accepts punctuation humans put in names', () => {
    expect(rejectDisplayName('Bob, the bot')).toBeNull();
    expect(rejectDisplayName('Alice (lead)')).toBeNull();
  });
});
