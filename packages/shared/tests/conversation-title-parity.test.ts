import { describe, expect, it } from 'vitest';
import { parseConversationTitle } from '../src/index.js';
import fixture from './fixtures/conversation-title-parity.json' with { type: 'json' };

describe('conversation title cross-language authority', () => {
  it('signs canonical values and refusal details with the production parser', () => {
    for (const testCase of fixture.cases) {
      const parsed = parseConversationTitle(testCase.input);
      const actual = parsed.ok
        ? { ok: true as const, title: parsed.value.title, key: parsed.value.key }
        : { ok: false as const, ...parsed.issue };
      expect(actual, testCase.name).toEqual(testCase.expected);
    }
  });

  it('signs every ECMAScript TrimString member at both edges', () => {
    for (const codePoint of fixture.trimCodePoints) {
      const whitespace = String.fromCodePoint(codePoint);
      for (const input of [`${whitespace}title`, `title${whitespace}`]) {
        const parsed = parseConversationTitle(input);
        expect(parsed, `U+${codePoint.toString(16)} in ${JSON.stringify(input)}`).toMatchObject({
          ok: true,
          value: { title: 'title', key: 'title' },
        });
      }
    }
  });

  it('does not widen TrimString to adjacent NEL or zero-width space', () => {
    for (const codePoint of fixture.nonTrimCodePoints) {
      const nonmember = String.fromCodePoint(codePoint);
      for (const input of [`${nonmember}title`, `title${nonmember}`]) {
        const parsed = parseConversationTitle(input);
        expect(parsed, `U+${codePoint.toString(16)} in ${JSON.stringify(input)}`).toMatchObject({
          ok: false,
          issue: { kind: 'forbidden_code_point', codePoint },
        });
      }
    }
  });

  it('signs the astral title limit in code points rather than UTF-16 units', () => {
    const scalar = String.fromCodePoint(fixture.astralBoundary.codePoint);
    const accepted = parseConversationTitle(scalar.repeat(fixture.astralBoundary.accepted));
    expect(accepted).toMatchObject({ ok: true });
    if (!accepted.ok) throw new Error('astral boundary must be accepted');
    expect(Array.from(accepted.value.title)).toHaveLength(fixture.astralBoundary.accepted);

    expect(parseConversationTitle(scalar.repeat(fixture.astralBoundary.refused))).toEqual({
      ok: false,
      issue: { kind: 'too_long', codePoints: fixture.astralBoundary.refused },
    });
  });
});
