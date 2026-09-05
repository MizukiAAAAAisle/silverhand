import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// The SIGNER for the Rust `CoercedNumber` parity fixture (Cindy #26). It runs the
// EXACT shared `z.preprocess('' -> undefined, z.coerce.number().int()
// .refine(isSafeInteger))` schema — the same one `ReadHistoryOptionalSeqSchema` uses
// — over every cell and regenerates the committed fixture the Rust test replays. So
// the Rust `Number()` reimplementation (radix literals, ECMAScript trim, empty-vs-
// whitespace string, and the singleton-array-goes-via-String NaN cases) can never
// silently drift from real ECMAScript `Number()` / Zod coercion: if a cell's outcome
// changes here, the fixture rewrites and the Rust byte-compare fails.
const FIXTURE = fileURLToPath(
  new URL('../../../../rust/crates/backend-server/tests/fixtures/coerce-number.parity.json', import.meta.url),
);

// The production coercion: identical shape to ReadHistoryOptionalSeqSchema (nonnegative
// is a SEPARATE domain gate the route applies; this signer covers the coerce+int+safe
// layer the Rust CoercedNumber owns, so negative-but-safe integers are `value` here).
const Schema = z.preprocess(
  value => (value === '' || value === undefined ? undefined : value),
  z.coerce
    .number()
    .int()
    .refine(Number.isSafeInteger, { message: 'must be a safe integer' })
    .optional(),
);

type Cell = { label: string; input: unknown; outcome: 'absent' | 'value' | 'invalid'; value?: number };

function signCell(input: unknown): { outcome: 'absent' | 'value' | 'invalid'; value?: number } {
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { outcome: 'invalid' };
  if (parsed.data === undefined) return { outcome: 'absent' };
  return { outcome: 'value', value: parsed.data };
}

describe('z.coerce.number() — Rust CoercedNumber parity fixture', () => {
  it('the committed fixture equals what the production Zod coercion produces', () => {
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cells: Cell[] };
    for (const cell of committed.cells) {
      const signed = signCell(cell.input);
      expect(signed.outcome, cell.label).toBe(cell.outcome);
      if (cell.outcome === 'value') {
        expect(signed.value, cell.label).toBe(cell.value);
      }
    }
  });
});
