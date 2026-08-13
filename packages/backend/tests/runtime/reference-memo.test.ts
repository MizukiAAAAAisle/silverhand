import { describe, expect, it, vi } from 'vitest';
import { extractMessageReferences } from '@silverhand/shared/reference-markdown';
import {
  REFERENCE_MEMO_CAPACITY,
  createReferenceMemo,
} from '../../src/runtime/reference-memo.js';

// Wraps the REAL parser so every assertion below is about how often the memo
// calls it, never about a stand-in's behaviour: the memo must return exactly
// what `extractMessageReferences` returns for that body.
vi.mock('@silverhand/shared/reference-markdown', async importOriginal => {
  const actual = await importOriginal<
    typeof import('@silverhand/shared/reference-markdown')
  >();
  return {
    ...actual,
    extractMessageReferences: vi.fn(actual.extractMessageReferences),
  };
});

const parser = vi.mocked(extractMessageReferences);

const ADDRESSED = 'please look <silverhand://agent/Alice> and <silverhand://human/shiki>';

describe('reference memo (#task:2000 option B)', () => {
  it('parses one message body once however many recipients ask for it', () => {
    parser.mockClear();
    const memo = createReferenceMemo();
    const message = { id: 'm-1', content: ADDRESSED };

    const answers = ['Alice', 'Norman', 'Cindy', 'Alice'].map(() =>
      memo.referencesOf(message),
    );

    expect(parser.mock.calls).toEqual([[ADDRESSED]]);
    // Every recipient's framing sees the same answer, and it is the parser's.
    expect(answers[0]).toEqual([
      { kind: 'agent', handle: 'Alice' },
      { kind: 'human', handle: 'shiki' },
    ]);
    for (const answer of answers) expect(answer).toBe(answers[0]);
  });

  it('keys by message id, so distinct bodies in one batch each parse once', () => {
    parser.mockClear();
    const memo = createReferenceMemo();
    const batch = [
      { id: 'm-1', content: ADDRESSED },
      { id: 'm-2', content: 'no handles here' },
    ];

    for (let recipient = 0; recipient < 3; recipient += 1) {
      for (const message of batch) memo.referencesOf(message);
    }

    expect(parser.mock.calls).toEqual([[ADDRESSED], ['no handles here']]);
    expect(memo.referencesOf(batch[1]!)).toEqual([]);
  });

  it('never answers from a stale key: a different id with the same content is its own entry', () => {
    parser.mockClear();
    const memo = createReferenceMemo();

    memo.referencesOf({ id: 'm-1', content: ADDRESSED });
    memo.referencesOf({ id: 'm-2', content: ADDRESSED });

    expect(parser.mock.calls).toEqual([[ADDRESSED], [ADDRESSED]]);
    expect(memo.size).toBe(2);
  });

  it('stays bounded and evicts the oldest entry first', () => {
    parser.mockClear();
    const memo = createReferenceMemo(3);

    for (const id of ['a', 'b', 'c', 'd']) {
      memo.referencesOf({ id, content: ADDRESSED });
    }
    expect(memo.size).toBe(3);

    parser.mockClear();
    // 'a' was evicted (oldest), 'd' is still resident.
    memo.referencesOf({ id: 'd', content: ADDRESSED });
    expect(parser.mock.calls).toEqual([]);
    memo.referencesOf({ id: 'a', content: ADDRESSED });
    expect(parser.mock.calls).toEqual([[ADDRESSED]]);
  });

  it('bounds a long-lived process by entry count, not by message history', () => {
    parser.mockClear();
    const memo = createReferenceMemo();

    for (let i = 0; i < REFERENCE_MEMO_CAPACITY * 3; i += 1) {
      memo.referencesOf({ id: `m-${i}`, content: ADDRESSED });
    }

    expect(memo.size).toBe(REFERENCE_MEMO_CAPACITY);
  });
});
