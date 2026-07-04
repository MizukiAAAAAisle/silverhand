import { describe, expect, it } from 'vitest';
import {
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

  it('falls back positionally only for the entries missing a label', () => {
    expect(
      resolveAttachmentLabels([
        { content_type: 'image/png', label: 'Image #5' },
        { content_type: 'image/png' },
      ]),
    ).toEqual(['Image #5', 'Image #2']);
  });

  it('treats a blank label as absent', () => {
    expect(
      resolveAttachmentLabels([{ content_type: 'image/png', label: '  ' }]),
    ).toEqual(['Image #1']);
  });
});
