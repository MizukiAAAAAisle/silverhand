import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentDto } from '@silverhand/shared';

import { WorkspaceIcon } from './WorkspaceIcon';

// #task:1437: the workspace filter trigger rendered its icon at WorkspaceIcon's
// own default while every sibling trigger passed an explicit size, so that one
// trigger sat taller. The fix routes a numeric `size` through all three render
// branches (unowned / owner-unresolved / owner-resolved avatar). These lock that
// the caller's size reaches every branch — using an arbitrary sentinel so the test
// tracks passthrough, not a specific px value (icon sizes are visual, verified
// by dogfood).

// Arbitrary non-default sentinel: if any branch ignored `size` and fell back to
// its own constant, the box would not be SENTINEL px.
const SENTINEL = 23;

describe('WorkspaceIcon — size prop drives every branch (#task:1437)', () => {
  it('people-owned workspace W: passes size through to the box', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceIcon, {
        ownerAgentId: null,
        size: SENTINEL,
      }),
    );
    expect(html).toContain(`width:${SENTINEL}px`);
    expect(html).toContain(`height:${SENTINEL}px`);
  });

  it('owner unresolved: passes size through to the neutral glyph', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceIcon, {
        ownerAgentId: 'a-missing',
        size: SENTINEL,
      }),
    );
    expect(html).toContain(`width:${SENTINEL}px`);
    expect(html).toContain(`height:${SENTINEL}px`);
  });

  it('resolved owner avatar: passes size through to the AgentAvatar box', () => {
    // Guards the third branch: if AgentAvatar's `size` were ever pinned to a
    // constant, the agent-space trigger would drift while the other two
    // branches stayed correct — the earlier two cases would miss it.
    const agent = {
      id: 'a-1',
      name: 'alice',
      display_name: 'Alice',
      runtime: 'claude',
    } as AgentDto;
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceIcon, {
        ownerAgentId: 'a-1',
        agentsById: new Map([['a-1', agent]]),
        size: SENTINEL,
      }),
    );
    expect(html).toContain(`width:${SENTINEL}px`);
    expect(html).toContain(`height:${SENTINEL}px`);
  });
});
