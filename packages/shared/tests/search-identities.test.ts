import { describe, expect, it } from 'vitest';
import { SearchQueryInputSchema, SearchWithIdentitiesDtoSchema } from '../src/api/message.js';
const empty = () => ({ results: [], total: 0, truncated: false });
const body = () => ({
  query: { q: 'alice', include_identities: true },
  results: [],
  total: 0,
  truncated: false,
  identities: { status: 'searched', humans: empty(), agents: empty() },
});
describe('identity search wire contract', () => {
  it('admits an explicit search scope without changing the inline default', () => {
    expect(SearchQueryInputSchema.parse({ include_identities: 'true' }).include_identities).toBe(
      true,
    );
    expect(SearchQueryInputSchema.parse({}).include_identities).toBeUndefined();
    expect(SearchQueryInputSchema.safeParse({ include_identities: 'wrong' }).success).toBe(false);
  });
  it('does not default a missing required category into zero matches', () => {
    const { identities, ...missing } = body();
    expect(SearchWithIdentitiesDtoSchema.safeParse(missing).success).toBe(false);
    expect(SearchWithIdentitiesDtoSchema.safeParse(body()).success).toBe(true);
  });
  it('rejects incorrect totals, flags and inactive nonempty results', () => {
    const row = {
      kind: 'human',
      id: 'id',
      name: 'alice',
      display_name: 'Alice',
      avatar_url: null,
      runtime: null,
    };
    const base = body();
    for (const category of [
      { results: [row], total: 0, truncated: false },
      { results: [row], total: 1, truncated: true },
      { results: [], total: 25, truncated: true },
    ]) {
      expect(
        SearchWithIdentitiesDtoSchema.safeParse({
          ...base,
          identities: { ...base.identities, humans: category },
        }).success,
      ).toBe(false);
    }
    expect(
      SearchWithIdentitiesDtoSchema.safeParse({
        ...base,
        identities: {
          ...base.identities,
          status: 'filtered',
          humans: { results: [row], total: 1, truncated: false },
        },
      }).success,
    ).toBe(false);
  });
  it('rejects a human in the agent category even for the same id', () => {
    const base = body();
    expect(
      SearchWithIdentitiesDtoSchema.safeParse({
        ...base,
        identities: {
          ...base.identities,
          agents: {
            results: [
              {
                kind: 'human',
                id: 'same',
                name: 'alice',
                display_name: 'Alice',
                runtime: null,
                avatar_url: null,
              },
            ],
            total: 1,
            truncated: false,
          },
        },
      }).success,
    ).toBe(false);
  });
});
