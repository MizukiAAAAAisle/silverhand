import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractAttachmentSnapshots } from '../../src/repos/message-repo.js';

// The SIGNER for the Rust attachment_snapshots parity fixture (Cindy R4 #3). It runs
// the REAL production extractor (extractAttachmentSnapshots -> parseAttachmentLabel +
// formatAttachmentLabel) over each cell's metadata and regenerates the committed
// fixture the Rust consumer replays. So the Rust extractor's contract -- canonical
// FORMATTED label (whitespace trimmed, e.g. '  Image #1  ' -> 'Image #1'), any-number
// size, malformed items dropped, empty -> null -- cannot silently drift from TS.
const FIXTURE = fileURLToPath(
  new URL('../../../../rust/crates/backend-sqlite/tests/fixtures/attachment-snapshots.parity.json', import.meta.url),
);

type Cell = {
  label: string;
  metadata: Record<string, unknown>;
  attachments: unknown;
};

describe('attachment snapshots — Rust parity fixture', () => {
  it('the committed fixture equals the production extractAttachmentSnapshots output', () => {
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cells: Cell[] };
    for (const cell of committed.cells) {
      const produced = extractAttachmentSnapshots(cell.metadata);
      expect(produced, cell.label).toEqual(cell.attachments);
    }
  });
});
