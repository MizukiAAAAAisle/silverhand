import { describe, expect, it } from 'vitest';
import { SearchQueryInputSchema } from '@silverhand/shared';
import fixture from '../fixtures/human-search-admission.json' with { type: 'json' };

describe('human search admission is signed by the production schema', () => {
  it('locks the nontrivial filter algebra without extracting production code', () => {
    let accepted = 0;
    let rejected = 0;
    for (const entry of fixture) {
      const input = Object.fromEntries(new URL(`http://search.test/${entry.query}`).searchParams.entries());
      const parsed = SearchQueryInputSchema.safeParse(input);
      expect(parsed.success, entry.name).toBe(entry.schema_accepted);
      if (parsed.success) {
        accepted += 1;
        expect(parsed.data, entry.name).toEqual(entry.parsed);
      } else {
        rejected += 1;
        expect({ error: parsed.error.flatten() }, entry.name).toEqual(entry.body);
      }
    }
    expect([accepted, rejected]).toEqual([4, 7]);
  });
});
