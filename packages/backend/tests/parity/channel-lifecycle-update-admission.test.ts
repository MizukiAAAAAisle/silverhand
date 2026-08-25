import { describe, expect, it } from 'vitest';
import { UpdateChannelInputSchema } from '@silverhand/shared';
import fixture from '../fixtures/channel-lifecycle-update-admission.json' with { type: 'json' };

describe('channel lifecycle PATCH admission is signed by the production schema', () => {
  it('locks only the title-XOR-visibility wrapper boundary', () => {
    let accepted = 0;
    let rejected = 0;
    for (const entry of fixture) {
      const parsed = UpdateChannelInputSchema.safeParse(entry.request);
      expect(parsed.success, entry.name).toBe(entry.schema_accepted);
      if (!parsed.success) {
        rejected += 1;
        expect({ error: 'invalid input', issues: parsed.error.issues }, entry.name)
          .toEqual(entry.body);
        continue;
      }
      accepted += 1;
      if (entry.operation === 'rename') {
        expect(parsed.data.title?.title, entry.name).toBe(entry.canonical_title);
        expect(parsed.data.visibility, entry.name).toBeUndefined();
      } else {
        expect(parsed.data.visibility, entry.name).toBe(entry.request.visibility);
        expect(parsed.data.title, entry.name).toBeUndefined();
      }
    }
    expect([accepted, rejected]).toEqual([3, 6]);
  });
});
