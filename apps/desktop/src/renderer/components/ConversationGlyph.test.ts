import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ConversationGlyph } from './ConversationGlyph';

// Closes the last hand-written `data-channel-icon` hook (the AgentActivityPane
// #/@ roster). The hook is now owned by this primitive, not a call-site
// (#task:1438). Both kinds keep the roster's sticker treatment — dropping the
// DM `@`'s chip would be a forza6 visual change, out of scope.

describe('ConversationGlyph — roster #/@ owns the sticker hook (#task:1438)', () => {
  it('channel renders `#` with the canonical sticker hook', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConversationGlyph, { kind: 'channel' }),
    );
    expect(html).toContain('data-channel-icon');
  });

  it('dm renders `@` and KEEPS the sticker hook (forza6 roster unchanged)', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConversationGlyph, { kind: 'dm' }),
    );
    expect(html).toContain('data-channel-icon');
  });

  it('kind is required — omitting it fails loud, never a silent branch', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      renderToStaticMarkup(React.createElement(ConversationGlyph, {} as any)),
    ).toThrow(/kind/);
  });
});
