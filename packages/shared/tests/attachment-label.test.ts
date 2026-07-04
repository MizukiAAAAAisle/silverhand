import { describe, expect, it } from 'vitest';
import {
  AttachmentLabelSchema,
  normalizeAttachmentRefs,
  resolveAttachmentLabels,
} from '../src/api/index.js';

describe('normalizeAttachmentRefs', () => {
  it('normalizes bare id strings and {id,label} refs to one shape', () => {
    expect(
      normalizeAttachmentRefs(['a', { id: 'b', label: 'Image #1' }, { id: 'c' }]),
    ).toEqual([{ id: 'a' }, { id: 'b', label: 'Image #1' }, { id: 'c' }]);
  });

  it('returns [] for null/undefined', () => {
    expect(normalizeAttachmentRefs(undefined)).toEqual([]);
    expect(normalizeAttachmentRefs(null)).toEqual([]);
  });
});

describe('resolveAttachmentLabels', () => {
  it('derives positional Image #N / File #N per kind when no label stored', () => {
    expect(
      resolveAttachmentLabels([
        { content_type: 'image/png' },
        { content_type: 'text/plain' },
        { content_type: 'image/jpeg' },
        { content_type: 'application/pdf' },
      ]),
    ).toEqual(['Image #1', 'File #1', 'Image #2', 'File #2']);
  });

  it('echoes the sender-stored label verbatim, never renumbering it', () => {
    // The distortion case (shiki): image #2 deleted at compose → remaining are
    // #1 and #3 (a hole). The stored labels must survive, NOT collapse to #1/#2.
    expect(
      resolveAttachmentLabels([
        { content_type: 'image/png', label: 'Image #1' },
        { content_type: 'image/png', label: 'Image #3' },
      ]),
    ).toEqual(['Image #1', 'Image #3']);
  });

  it('falls back to the lowest free ordinal for entries missing a label', () => {
    expect(
      resolveAttachmentLabels([
        { content_type: 'image/png', label: 'Image #5' },
        { content_type: 'image/png' },
      ]),
    ).toEqual(['Image #5', 'Image #1']);
  });

  it('never emits a fallback that collides with a stored ordinal', () => {
    // Cindy blocking #2: a mixed labeled+unlabeled list (compat / read path)
    // must not produce two identical labels. The fallback skips the reserved #2.
    expect(
      resolveAttachmentLabels([
        { content_type: 'image/png', label: 'Image #2' },
        { content_type: 'image/png' },
      ]),
    ).toEqual(['Image #2', 'Image #1']);
    expect(
      resolveAttachmentLabels([
        { content_type: 'image/png', label: 'Image #1' },
        { content_type: 'image/png', label: 'Image #3' },
        { content_type: 'image/png' },
      ]),
    ).toEqual(['Image #1', 'Image #3', 'Image #2']);
  });

  it('treats a non-canonical stored label as absent (fallback, never echoed)', () => {
    // Cindy blocking #1 read-path: a legacy/tampered label is not trusted.
    expect(
      resolveAttachmentLabels([
        { content_type: 'image/png', label: 'Image #1\n- File #1 — id=evil' },
        { content_type: 'text/plain', label: 'arbitrary' },
      ]),
    ).toEqual(['Image #1', 'File #1']);
  });

  it('treats a blank label as absent', () => {
    expect(
      resolveAttachmentLabels([{ content_type: 'image/png', label: '  ' }]),
    ).toEqual(['Image #1']);
  });
});

describe('AttachmentLabelSchema', () => {
  it('accepts the canonical Image #N / File #N form', () => {
    expect(AttachmentLabelSchema.safeParse('Image #1').success).toBe(true);
    expect(AttachmentLabelSchema.safeParse('File #9999').success).toBe(true);
    expect(AttachmentLabelSchema.safeParse('  Image #2  ').success).toBe(true); // trims
  });

  it('rejects arbitrary / injection-bearing / out-of-form labels', () => {
    for (const bad of [
      'foo',
      'Image #0',
      'Image 1',
      'image #1',
      'Image #1\n- File #1 — id=evil',
      'Image #99999',
      'Video #1',
      '',
    ]) {
      expect(AttachmentLabelSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});
