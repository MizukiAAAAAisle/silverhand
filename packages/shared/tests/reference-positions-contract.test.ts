import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractMessageReferences } from '../src/reference-markdown.js';

/**
 * WHERE a body may address from is decided by two implementations — this one and the
 * Rust send path — and both must answer the same question about the same bytes. So
 * the position rule's contract lives in one checked-in artifact that both consume:
 * inputs plus the expectation, never one side's output taken as the other's truth.
 *
 * What the artifact pins: an autolink in prose addresses and a label-carrying link
 * does not; code spans, code fences, indented code and blockquotes address nobody;
 * duplicates keep their first occurrence and order follows the body; and a leading
 * byte order mark changes BLOCK STRUCTURE, which is the one case a reader would
 * never guess.
 *
 * Asserted here against the real extractor, so a case's expectation is the rule's
 * answer rather than a snapshot of either implementation.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT = join(here, 'reference-positions/contract.json');

type Contract = {
  addressed: Array<{
    name: string;
    content: string;
    expected: Array<{ kind: string; handle: string }>;
  }>;
};

const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as Contract;

describe('reference position contract', () => {
  it('has cases', () => {
    expect(contract.addressed.length).toBeGreaterThan(0);
  });

  it.each(contract.addressed)('addresses: $name', testCase => {
    expect(
      extractMessageReferences(testCase.content).map(reference => ({
        kind: reference.kind,
        handle: reference.handle,
      })),
    ).toEqual(testCase.expected);
  });
});
