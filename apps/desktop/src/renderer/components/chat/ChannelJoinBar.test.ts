import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChannelJoinBar } from './ChannelJoinBar';

// The composer-slot affordance a non-member sees when browsing a public
// channel. These lock the contract that matters: a declarative status + a
// single Join action, and that the action is inert while a join is in flight
// (no double-submit). Deliberately NOT asserting sizes/spacing — those are
// visual-review concerns, not behavior.

describe('ChannelJoinBar', () => {
  it('idle: shows the not-joined status + an enabled Join action', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChannelJoinBar, { onJoin: () => {}, joining: false }),
    );
    expect(html).toContain('Not a member');
    expect(html).toContain('Join the channel');
    // The `disabled` ATTRIBUTE is absent when idle (Tailwind `disabled:` utility
    // classes always appear in the markup, so match the attribute precisely).
    expect(html).not.toContain('disabled=""');
  });

  it('joining: the action is disabled (no double-submit) and reflects progress', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChannelJoinBar, { onJoin: () => {}, joining: true }),
    );
    expect(html).toContain('Joining');
    expect(html).toContain('disabled=""');
  });
});
