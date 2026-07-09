import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AVATAR_PX, AVATAR_PX_DEFAULT } from './avatar-scale';
import { AgentAvatar } from './AgentAvatar';
import { UserAvatar } from './UserAvatar';

// Locks the identity-avatar square scale (#task:1440). Three of Cindy's four
// review invariants live here: (1) the scale constant values, (2) both avatar
// components default to `md` (28) — the historical default must never drift,
// (3) a named size resolves to the right pixels. The fourth (peer rows share a
// token; no hand-written numeric literal) is the source fence below in
// avatar-scale-fence.test.ts.

describe('AVATAR_PX scale (#task:1440)', () => {
  it('has the canonical tier values', () => {
    expect(AVATAR_PX).toEqual({
      chip: 14,
      xs: 16,
      sm: 20,
      md: 28,
      lg: 32,
      xl: 36,
      '2xl': 48,
      '3xl': 56,
    });
  });

  it('the default equals `md` (28) — never drift the historical default', () => {
    expect(AVATAR_PX_DEFAULT).toBe(28);
    expect(AVATAR_PX_DEFAULT).toBe(AVATAR_PX.md);
  });
});

describe('AgentAvatar / UserAvatar consume the scale (#task:1440)', () => {
  it('AgentAvatar defaults to md=28 when size is omitted', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentAvatar, { runtime: 'claude' }),
    );
    expect(html).toContain('width:28px');
    expect(html).toContain('height:28px');
  });

  it('UserAvatar defaults to md=28 when size is omitted', () => {
    const html = renderToStaticMarkup(React.createElement(UserAvatar, {}));
    expect(html).toContain('width:28px');
    expect(html).toContain('height:28px');
  });

  it('a named tier renders its pixels (sm=20)', () => {
    const agent = renderToStaticMarkup(
      React.createElement(AgentAvatar, { runtime: 'claude', size: AVATAR_PX.sm }),
    );
    const human = renderToStaticMarkup(
      React.createElement(UserAvatar, { size: AVATAR_PX.sm }),
    );
    // Same token → same pixels for the agent/human peer branches of a row.
    expect(agent).toContain('width:20px');
    expect(human).toContain('width:20px');
  });
});
