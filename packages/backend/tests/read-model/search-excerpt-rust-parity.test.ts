import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { searchExcerptFor } from '../../src/read-model/agent-read.js';

// The SIGNER for the Rust search_excerpt_for parity fixture (Cindy R4 #4). It runs the
// REAL production searchExcerptFor (pinned full fold + minimal-complete-original-scalar
// span map + scalar-safe window) over each cell and regenerates the committed fixture
// the Rust consumer replays. So the two fold-span implementations cannot diverge on the
// expanding (ß→ss), mid-expansion (ßa/sa), or astral (İ) cases -- a Rust-only unit case
// is no longer the sole cross-language evidence.
const FIXTURE = fileURLToPath(
  new URL('../../../../rust/crates/backend-core/tests/fixtures/search-excerpt.parity.json', import.meta.url),
);

type Cell = { label: string; content: string; query: string; excerpt: string; match_offset: number };

describe('search excerpt — Rust parity fixture', () => {
  it('the committed fixture equals the production searchExcerptFor output', () => {
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cells: Cell[] };
    for (const cell of committed.cells) {
      const produced = searchExcerptFor(cell.content, cell.query);
      expect(produced.excerpt, `${cell.label} excerpt`).toBe(cell.excerpt);
      expect(produced.match_offset, `${cell.label} offset`).toBe(cell.match_offset);
    }
  });
});
