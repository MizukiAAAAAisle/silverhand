import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MessageDto } from '@silverhand/shared';
import { SystemMessage } from './SystemMessage';

/** Minimal rename system message. `RenameRow` reads the structured
 *  `RenameMetadata` (old_name / new_name / scope), so only the metadata
 *  shape matters here. */
function renameMessage(meta: Record<string, unknown>): MessageDto {
  return {
    id: 'sys-rename-1',
    conversation_id: 'conv-1',
    from_kind: 'system',
    from_agent_id: null,
    from_user_id: null,
    content: '',
    metadata: { subtype: 'rename', ...meta },
    attachments: null,
    seq: 1,
    created_at: 0,
    thread_root_id: null,
    task_number: null,
    task_status: null,
    task_title: null,
    task_workspace_id: null,
    task_closed_at: null,
    task_assignee: null,
    reactions: null,
  };
}

describe('RenameRow scope (#task:1109)', () => {
  it('defaults to a workspace rename with #-prefixed names (legacy rows have no scope)', () => {
    const html = renderToStaticMarkup(
      React.createElement(SystemMessage, {
        message: renameMessage({ old_name: 'alpha', new_name: 'beta' }),
      }),
    );
    expect(html).toContain('workspace renamed');
    expect(html).not.toContain('channel renamed');
    expect(html).toContain('#alpha');
    expect(html).toContain('#beta');
  });

  it('renders a channel rename without the # sigil for conversation scope', () => {
    const html = renderToStaticMarkup(
      React.createElement(SystemMessage, {
        message: renameMessage({
          old_name: 'old room',
          new_name: 'UI/UX 优化',
          scope: 'conversation',
        }),
      }),
    );
    expect(html).toContain('channel renamed');
    expect(html).not.toContain('workspace renamed');
    // Freeform titles (spaces / CJK) drop the name-addressable `#` sigil.
    expect(html).toContain('UI/UX 优化');
    expect(html).not.toContain('#UI/UX');
    expect(html).not.toContain('#old room');
  });
});
