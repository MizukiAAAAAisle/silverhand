import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decideTextCommit } from './InlineText';

describe('decideTextCommit — required non-null string', () => {
  it('rejects an empty edit (no clearing to null allowed)', () => {
    expect(decideTextCommit('   ', 'Alice')).toEqual({ commit: false });
  });
  it('rejects a no-op edit (trimmed draft equals current value)', () => {
    expect(decideTextCommit('  Alice  ', 'Alice')).toEqual({ commit: false });
  });
  it('commits a real change (trimmed and different)', () => {
    expect(decideTextCommit('  Alicia  ', 'Alice')).toEqual({
      commit: true,
      next: 'Alicia',
    });
  });
});

describe('InlineText component source — no-blur invariant', () => {
  // Structural regression lock: the edit-mode input must not attach an
  // onBlur handler. Focus loss must preserve the draft, not PATCH. Grepping
  // the source is coarse but load-bearing — the vitest env is `node` with
  // no jsdom, so a real event-path test would require test-only infra.
  it('the source file contains no onBlur handler', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./InlineText.tsx', import.meta.url)),
      'utf8',
    );
    // Strip comments so a docstring that mentions "onBlur" cannot pass
    // the check. Only real JSX `onBlur={` attributes should count.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(codeOnly).not.toMatch(/onBlur\s*=/);
  });
});
