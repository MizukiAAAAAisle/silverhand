import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';
import type { ConversationReference } from './ConversationRef';

function render(content: string, refs?: Map<string, ConversationReference>): string {
  return renderToStaticMarkup(
    React.createElement(Markdown, {
      content,
      conversationRefsById: refs,
      onOpenConversationRef: () => undefined,
    }),
  );
}

describe('Markdown conversation refs', () => {
  it('renders #~<conversation_id> as a clickable conversation pill', () => {
    const id = 'AbC123_-xyZ789qR';
    const refs = new Map<string, ConversationReference>([
      [
        id,
        {
          id,
          title: 'version3',
          kind: 'channel',
        },
      ],
    ]);

    const html = render(`See #~${id} for details.`, refs);

    expect(html).toContain(`data-conversation-ref="${id}"`);
    expect(html).toContain('bg-accent-soft');
    expect(html).toContain('version3');
    expect(html).not.toContain('#version3');
    expect(html).not.toContain(`#~${id}`);
  });

  it('renders resolved thread refs with parent channel display name', () => {
    const id = 'ThC123_-xyZ789qR';
    const refs = new Map<string, ConversationReference>([
      [
        id,
        {
          id,
          kind: 'thread',
          title: 'thread 1',
          parent_channel_id: 'parent-channel',
          parent_title: 'debug',
        },
      ],
    ]);

    const html = render(`See #~${id}.`, refs);

    expect(html).toContain(`data-conversation-ref="${id}"`);
    expect(html).toContain('debug:thread 1');
    expect(html).not.toContain('#debug:thread 1');
  });

  it('keeps unresolved refs clickable by id', () => {
    const html = render('Open #~foreignRef123456.');

    expect(html).toContain('data-conversation-ref="foreignRef123456"');
    expect(html).toContain('#~foreignRef123456');
  });

  it('does not parse short refs, longer id-like tokens, code, or existing links', () => {
    const html = render(
      [
        'short #~foo',
        'long #~foreignRef12345678x',
        '`#~codeRef12345678`',
        '[#~linkedRef123456](https://example.com)',
        '#~realRef123456789.bar',
      ].join(' '),
    );

    expect(html).toContain('data-conversation-ref="realRef123456789"');
    expect(html).not.toContain('data-conversation-ref="foo"');
    expect(html).not.toContain('data-conversation-ref="foreignRef12345678"');
    expect(html).not.toContain('data-conversation-ref="codeRef12345678"');
    expect(html).not.toContain('data-conversation-ref="linkedRef123456"');
    expect(html).toContain('.bar');
  });
});
