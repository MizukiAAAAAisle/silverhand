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
});
