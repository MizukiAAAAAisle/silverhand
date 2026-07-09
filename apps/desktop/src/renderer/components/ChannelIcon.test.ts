import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChannelIcon, CHANNEL_ICON_PX } from './ChannelIcon';

// The channel `#` glyph must be sticker-or-utility BY CONSTRUCTION: the
// `data-channel-icon` theme hook (whose forza6 sticker chrome inflates the box)
// may ride identity surfaces but never a compact/utility control. #task:1437
// was that hook on a filter trigger (14px → 18px); #task:1438 moves the
// decision into this primitive so a call-site can't re-introduce the drift.

describe('ChannelIcon — sticker vs utility is enforced (#task:1438)', () => {
  it('utility variant renders a plain `#` with NO sticker hook', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChannelIcon, { variant: 'utility' }),
    );
    expect(html).not.toContain('data-channel-icon');
  });

  it('sticker variant carries the canonical `data-channel-icon` hook', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChannelIcon, { variant: 'sticker' }),
    );
    expect(html).toContain('data-channel-icon');
  });

  it('variant is required — omitting it fails loud, never a silent branch', () => {
    // A missing variant must throw, NOT quietly render as utility (which would
    // strip the hook off an identity surface). TS makes this a compile error;
    // this proves the runtime guard for untyped/JS callers.
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      renderToStaticMarkup(React.createElement(ChannelIcon, {} as any)),
    ).toThrow(/variant/);
  });

  it('density maps to the named scale (sm 12 / md 14 / lg 24)', () => {
    const px = (density: 'sm' | 'md' | 'lg') =>
      renderToStaticMarkup(
        React.createElement(ChannelIcon, { variant: 'utility', density }),
      );
    expect(px('sm')).toContain('width="12"');
    expect(px('md')).toContain('width="14"');
    expect(px('lg')).toContain('width="24"');
    // Default density is md (14px).
    expect(
      renderToStaticMarkup(
        React.createElement(ChannelIcon, { variant: 'utility' }),
      ),
    ).toContain('width="14"');
  });

  it('exposes the density scale for consumers that need the raw px', () => {
    expect(CHANNEL_ICON_PX).toEqual({ sm: 12, md: 14, lg: 24 });
  });
});
