import { describe, expect, it } from 'vitest';
import {
  buildQuoteBlock,
  clampToolbarCenterX,
  spliceQuoteIntoDraft,
} from './quote-to-composer';

describe('buildQuoteBlock', () => {
  it('prefixes a single line with "> "', () => {
    expect(buildQuoteBlock('hello world')).toBe('> hello world');
  });

  it('prefixes every line of a multi-line passage', () => {
    expect(buildQuoteBlock('line one\nline two')).toBe('> line one\n> line two');
  });

  it('keeps blank lines contiguous with a bare ">"', () => {
    // A blank interior line must stay part of the same quote block, not
    // split it into two blockquotes.
    expect(buildQuoteBlock('a\n\nb')).toBe('> a\n>\n> b');
  });

  it('normalizes CRLF so pasted Windows text quotes cleanly', () => {
    expect(buildQuoteBlock('a\r\nb')).toBe('> a\n> b');
  });
});

describe('spliceQuoteIntoDraft', () => {
  it('into an empty draft: no leading newline, trailing blank line, caret past the quote', () => {
    const { text, caret } = spliceQuoteIntoDraft('', 0, 'hi');
    expect(text).toBe('> hi\n\n');
    expect(caret).toBe(text.length);
  });

  it('at the end of existing text mid-line: adds a leading newline', () => {
    const { text, caret } = spliceQuoteIntoDraft('draft', 5, 'q');
    expect(text).toBe('draft\n> q\n\n');
    expect(caret).toBe(text.length);
  });

  it('when the caret already sits at line start: no extra leading newline', () => {
    const { text } = spliceQuoteIntoDraft('draft\n', 6, 'q');
    expect(text).toBe('draft\n> q\n\n');
  });

  it('splices at an interior caret, keeping following text', () => {
    // Caret between "ab" and "cd"; quote lands on its own line and the
    // trailing "cd" is separated by a single newline (it already leads
    // with none, so a blank line is inserted).
    const { text, caret } = spliceQuoteIntoDraft('abcd', 2, 'q');
    expect(text).toBe('ab\n> q\n\ncd');
    // Caret sits right after the inserted block, before "cd".
    expect(text.slice(caret)).toBe('cd');
  });

  it('uses a single trailing newline when the caret precedes a newline', () => {
    const { text } = spliceQuoteIntoDraft('a\nb', 1, 'q');
    // after = "\nb" already starts with a newline → only one trailing \n.
    expect(text).toBe('a\n> q\n\nb');
  });

  it('clamps an out-of-range caret to the draft length', () => {
    const { text } = spliceQuoteIntoDraft('ab', 99, 'q');
    expect(text).toBe('ab\n> q\n\n');
  });
});

describe('clampToolbarCenterX', () => {
  const WIDTH = 100;
  const VIEWPORT = 1000;
  const MARGIN = 8;

  it('leaves a centered anchor untouched', () => {
    expect(clampToolbarCenterX(500, WIDTH, VIEWPORT, MARGIN)).toBe(500);
  });

  it('pushes right when the anchor hugs the left edge', () => {
    // min center = margin + width/2 = 58.
    expect(clampToolbarCenterX(0, WIDTH, VIEWPORT, MARGIN)).toBe(58);
  });

  it('pushes left when the anchor hugs the right edge', () => {
    // max center = viewport - margin - width/2 = 942.
    expect(clampToolbarCenterX(1000, WIDTH, VIEWPORT, MARGIN)).toBe(942);
  });

  it('centers in the viewport when the toolbar is wider than the usable area', () => {
    expect(clampToolbarCenterX(10, 2000, VIEWPORT, MARGIN)).toBe(500);
  });
});
