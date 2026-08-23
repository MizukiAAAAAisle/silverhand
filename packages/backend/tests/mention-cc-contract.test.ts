import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractMessageReferences } from '@silverhand/shared/reference-markdown';
import { excerpt, renderMentionWrap } from '../src/application/mention-cc.js';

/**
 * The mention CC's durable text is produced by two implementations — this one and
 * the Rust write path — and both are read back from the same message row. So the
 * contract lives in one checked-in artifact that both consume: inputs plus the
 * expectation, never one side's output taken as the other's truth.
 *
 * What the artifact pins here: the escaping that stops a free-text label from
 * ending its line or closing its code span, the quoting that keeps every logical
 * line of the original inside the quote, and the excerpt's whitespace set and
 * character-counted cut. What it pins for BOTH sides is that the rendered body
 * addresses exactly its recipient — asked of the real extractor, so a reference in
 * the quoted original cannot address anyone a second time.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT = join(here, 'mention-cc/contract.json');

type Contract = {
  excerpt: Array<{ name: string; input: string; expected: string }>;
  body: Array<{
    name: string;
    agentHandle: string;
    sourceWorkspaceName: string;
    sourceConversationTitle: string;
    sourceContent: string;
    expectedBody: string;
    expectedAddressed: string[];
  }>;
};

const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as Contract;

describe('mention CC durable text contract', () => {
  it.each(contract.excerpt)('excerpt: $name', testCase => {
    expect(excerpt(testCase.input)).toBe(testCase.expected);
  });

  it.each(contract.body)('body: $name', testCase => {
    expect(renderMentionWrap(testCase)).toBe(testCase.expectedBody);
  });

  it.each(contract.body)('body addresses only its recipient: $name', testCase => {
    const addressed = extractMessageReferences(testCase.expectedBody).map(
      reference => `${reference.kind}/${reference.handle}`,
    );

    expect(addressed).toEqual(testCase.expectedAddressed);
    expect(addressed).toEqual([`agent/${testCase.agentHandle}`]);
  });

  /** The excerpt never leaves half a character behind, which is why the two
   *  implementations can agree at all: a lone surrogate is not text and cannot be
   *  reproduced by one that stores UTF-8. */
  it('cuts astral characters whole', () => {
    const cut = excerpt('\u{1d11e}'.repeat(200));

    expect(Array.from(cut)).toHaveLength(160);
    expect(cut.endsWith('…')).toBe(true);
    // A surrogate PAIR is how an astral character is stored; what must never
    // appear is a lone one, which is exactly what well-formedness asks.
    expect(cut.isWellFormed()).toBe(true);
  });
});
