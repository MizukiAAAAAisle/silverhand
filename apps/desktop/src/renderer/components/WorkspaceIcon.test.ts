import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentDto } from '@silverhand/shared';

import { WorkspaceIcon } from './WorkspaceIcon';

// The task filter-bar bug (#task:1437): the workspace filter trigger rendered
// its icon at WorkspaceIcon's 16px default while every sibling trigger uses a
// 14px (`size-3.5`) glyph, so that one trigger sat taller. The fix routes a
// numeric `size` through all three branches. These lock that contract so the
// workspace trigger can't silently drift from its siblings again.

describe('WorkspaceIcon — size prop drives every branch (#task:1437)', () => {
  it('regular workspace W: default box is 16px', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceIcon, { kind: 'regular', dmAgentId: null }),
    );
    expect(html).toContain('width:16px');
    expect(html).toContain('height:16px');
  });

  it('regular workspace W: honours a smaller size (filter-trigger box)', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceIcon, {
        kind: 'regular',
        dmAgentId: null,
        size: 14,
      }),
    );
    expect(html).toContain('width:14px');
    expect(html).toContain('height:14px');
    expect(html).not.toContain('width:16px');
  });

  it('DM fallback (agent unresolved): honours size on the neutral glyph', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceIcon, {
        kind: 'dm',
        dmAgentId: 'a-missing',
        size: 14,
      }),
    );
    expect(html).toContain('width:14px');
    expect(html).toContain('height:14px');
  });

  it('resolved DM avatar: honours size on the AgentAvatar box', () => {
    // Guards the third branch: if AgentAvatar's `size` were ever pinned back
    // to 16, the DM workspace trigger would re-inflate while the other two
    // branches stayed correct — the earlier two cases would miss it.
    const agent = {
      id: 'a-1',
      name: 'alice',
      display_name: 'Alice',
      runtime: 'claude',
    } as AgentDto;
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceIcon, {
        kind: 'dm',
        dmAgentId: 'a-1',
        agentsById: new Map([['a-1', agent]]),
        size: 14,
      }),
    );
    expect(html).toContain('width:14px');
    expect(html).toContain('height:14px');
    // The avatar box, not just the inner runtime glyph (0.6× = ~8px), sits at
    // the requested edge.
    expect(html).not.toContain('width:16px');
  });
});
