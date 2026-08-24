import { describe, expect, it } from 'vitest';
import { DirectPairListResponseSchema } from '../src/api/conversation.js';
import fixture from './fixtures/direct-pair-list.json' with { type: 'json' };

describe('DirectPairListResponse shared Rust migration fixture', () => {
  it('signs every published active/deleted/empty shape with the real Zod authority', () => {
    const cases = [fixture.authority_case.response, ...fixture.additional_wire_cases];
    for (const value of cases) {
      expect(DirectPairListResponseSchema.parse(value)).toEqual(value);
    }
  });

  it('keeps the complete face closed to pagination metadata', () => {
    expect(Object.keys(fixture.authority_case.response)).toEqual(['direct_pairs']);
  });
});
