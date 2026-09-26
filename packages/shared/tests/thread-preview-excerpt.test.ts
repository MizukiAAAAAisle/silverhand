import { describe, expect, it } from 'vitest';
import { normalizeThreadPreviewExcerpt } from '../src/api/index.js';

// SSOT for the ThreadReplyPreviewRow.preview normalization (#task:1746, Option
// A). Both the cold read-model producer and the live WS-merge producer route
// through this helper, so the field is byte-identical across reload vs merge.
describe('normalizeThreadPreviewExcerpt', () => {
  it('whitespace-compacts (\\s+→space) and trims but never strips Markdown syntax', () => {
    expect(
      normalizeThreadPreviewExcerpt('  **bold**\n\n`code`\t[link](http://x)   trailing  '),
    ).toBe('**bold** `code` [link](http://x) trailing');
  });

  it('caps the wire excerpt at 160 UTF-16 units', () => {
    expect(normalizeThreadPreviewExcerpt(`${'a'.repeat(160)}b`)).toBe('a'.repeat(160));
  });

  it('compacts before capping, so the cap counts normalized chars', () => {
    // 200 spaces then 10 x's → compacts to " xxxxxxxxxx" → trims → 10 chars.
    expect(normalizeThreadPreviewExcerpt(`${' '.repeat(200)}${'x'.repeat(10)}`)).toBe(
      'x'.repeat(10),
    );
  });

  it('returns empty string for whitespace-only content', () => {
    expect(normalizeThreadPreviewExcerpt('   \n\t  ')).toBe('');
  });
});
