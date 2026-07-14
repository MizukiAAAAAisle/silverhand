import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { COLLECTION_CARD_CLASS, CollectionItemCard } from './collection-item-card';

/**
 * Invariant: every side-panel "collection item" card — Search, Saved, Archived,
 * Activity, channel Threads, channel Attachments — renders through the ONE
 * `<CollectionItemCard>` shell, and the shell is the SOLE owner of the
 * `data-collection-card` theme-paint marker. Before this primitive, thread &
 * attachment rows forked their own hooks + copy-pasted shells and drifted from
 * the list-row family; the shell + this fence make that impossible.
 *
 * This locks SEMANTIC SCOPE, not sizes (standing rule: no source-fence on px /
 * spacing / icon dimensions — those are hand-verified). It guards: (1) the shell
 * cannot lose the marker to a consumer's passthrough props; (2) no consumer
 * hand-rolls the frame or a second marker; (3) the three retired parallel hooks
 * are gone from ALL live code — TSX and theme CSS alike.
 */

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

/** Strip `//` line comments and `/* *​/` block comments (covers JSX `{/* *​/}`
 *  and CSS comments) so a hook NAME mentioned in prose never trips the fences —
 *  only live code counts. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The bare shell marker as a JSX attribute / CSS selector — `-icon` and other
 *  suffixed hooks are excluded by the trailing `[-\w]` guard. */
const BARE_MARKER = /data-collection-card(?![-\w])/g;

/** The three forked hooks this refactor consolidated. The `(?![-\w])` guard
 *  exempts the legit survivors: `data-attachment-row-action` (attachment's
 *  inner action stamp) and `data-list-rows-skeleton`. */
const RETIRED_HOOK = /data-(?:list-row|thread-row|attachment-row)(?![-\w])/g;

const CONSUMERS = [
  'SearchPanel.tsx',
  'SavedListView.tsx',
  'ArchivedChannelsPanel.tsx',
  'ActivityView.tsx',
  'ChannelThreadsPanel.tsx',
  'ChannelAttachmentsPanel.tsx',
] as const;

const THEME_CSS = [
  '../../styles/themes/forza6-components.css',
  '../../styles/themes/slack-dark.css',
  '../../styles/themes/warm-script.css',
] as const;

describe('CollectionItemCard — the shell owns the theme-paint marker', () => {
  it('emits data-collection-card even when a consumer tries to override it', () => {
    // Hostile passthrough: a consumer spreads a prop that would strip/rewrite
    // the marker. The shell spreads the marker LAST, so it always wins.
    const html = renderToStaticMarkup(
      React.createElement(
        CollectionItemCard as unknown as React.FC<Record<string, unknown>>,
        { 'data-collection-card': 'HACKED', className: 'consumer-layout' },
        'body',
      ),
    );
    expect(html).toContain('data-collection-card');
    expect(html).not.toContain('HACKED');
    // frame + consumer class both present, children rendered
    expect(html).toContain('consumer-layout');
    expect(html).toContain('body');
  });

  it('honours `as` for the element type while still carrying the marker', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        CollectionItemCard as unknown as React.FC<Record<string, unknown>>,
        { as: 'button', type: 'button' },
        'x',
      ),
    );
    expect(html).toMatch(/^<button\b/);
    expect(html).toContain('data-collection-card');
  });
});

describe('collection-item-card — one shell, one marker, no drift', () => {
  it('frame SSOT never falls back to a hardcoded framework default', () => {
    // The frame must ride the theme token clusters, never raw `rounded-md` /
    // bare `border` (1px). Failure mode if this regresses: the shell splits
    // across themes — forza6 (radius 0) vs warm/slack (radius 6px) render
    // differently because a hardcoded default bypasses the semantic token layer.
    // We assert the NEGATIVE (no hardcoded default), not which exact token is
    // used — the token value itself is a visual concern.
    expect(COLLECTION_CARD_CLASS).not.toMatch(/\brounded-md\b/);
    expect(COLLECTION_CARD_CLASS).not.toMatch(/(?:^|\s)border(?=\s|$)/);
  });

  it('the shell is the SOLE hand-written source of the marker', () => {
    const shell = stripComments(readSource('./collection-item-card.tsx'));
    expect(shell.match(BARE_MARKER) ?? []).toHaveLength(1);
  });

  for (const file of CONSUMERS) {
    it(`${file} routes through <CollectionItemCard>, writes no marker, keeps no retired hook`, () => {
      const src = stripComments(readSource(`./${file}`));
      // routes through the shell
      expect(src).toMatch(/<CollectionItemCard\b/);
      // does NOT hand-roll a second marker (the shell owns it) — `-icon` is fine
      expect(src.match(BARE_MARKER) ?? []).toHaveLength(0);
      // no forked hook survives
      expect(src.match(RETIRED_HOOK) ?? []).toHaveLength(0);
    });
  }

  for (const css of THEME_CSS) {
    it(`${css.split('/').pop()} has no retired hook selector left`, () => {
      const src = stripComments(readSource(css));
      expect(src.match(RETIRED_HOOK) ?? []).toHaveLength(0);
    });
  }
});
