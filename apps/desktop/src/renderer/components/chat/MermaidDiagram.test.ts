import { describe, expect, it } from 'vitest';
import {
  extractMermaidSources,
  mermaidScrollOwnerForZoom,
} from './MermaidDiagram';

// The export pre-render pass (#task:1322) scans message markdown for mermaid
// fences and keys the rendered SVGs by trimmed source. Markdown's `pre` override
// looks them up by `extractText(children).trim()`, so these keys must match.
describe('extractMermaidSources (#task:1322)', () => {
  it('extracts a single fence, trimmed to the diagram source', () => {
    const md = 'intro\n\n```mermaid\ngraph TD; A-->B;\n```\n\noutro';
    expect(extractMermaidSources(md)).toEqual(['graph TD; A-->B;']);
  });

  it('is case-insensitive on the info string (```Mermaid)', () => {
    expect(extractMermaidSources('```Mermaid\ngraph TD; A-->B;\n```')).toEqual([
      'graph TD; A-->B;',
    ]);
  });

  it('extracts every mermaid fence in order', () => {
    const md =
      '```mermaid\nflowchart TD\n  A-->B\n```\n' +
      'text\n' +
      '```mermaid\nsequenceDiagram\n  A->>B: hi\n```';
    expect(extractMermaidSources(md)).toEqual([
      'flowchart TD\n  A-->B',
      'sequenceDiagram\n  A->>B: hi',
    ]);
  });

  it('ignores non-mermaid fences and inline code', () => {
    const md = '```ts\nconst x = 1;\n```\n`mermaid`';
    expect(extractMermaidSources(md)).toEqual([]);
  });

  it('skips an empty mermaid fence', () => {
    expect(extractMermaidSources('```mermaid\n\n```')).toEqual([]);
  });
});

describe('Mermaid scroll ownership (#task:2129)', () => {
  it.each([0.5, 0.75, 1, 1.5, 2, 3])(
    'keeps inline zoom %s in the document scroll owner',
    zoom => {
      expect(mermaidScrollOwnerForZoom(zoom)).toBe('document');
    },
  );
});
