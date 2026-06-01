import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentDto, MessageDto } from '@silverhand/shared';
import { MessageScreenshotView } from './MessageScreenshotView';

// Cindy review of 2f8a2ca (P1 blocker): export view was reusing the
// full interactive `Markdown` component, leaking copy/expand buttons,
// `<a onClick=...>`, and Mention/ChannelRef/ConversationRef/TaskRef
// components (which run their own hooks) into the offscreen
// screenshot tree. The fix is `interactive={false}` on Markdown plus
// these contract assertions:
//
//   - export DOM has zero `<button>` and zero `[role="button"]`
//   - no code-block chrome class names (`.code-block__copy`,
//     `.code-block__expand`)
//   - plain external links collapse to span — no `href`, no `onclick`
//   - internal refs render as static accent spans, not the live ref
//     components
//
// Tests SSR-render via renderToStaticMarkup so we assert on the HTML
// output directly (matching the Markdown.test.ts pattern for this
// repo's node-env vitest setup).

function agent(id: string, overrides: Partial<AgentDto> = {}): AgentDto {
  return {
    id,
    name: id,
    display_name: id,
    runtime: 'claude',
    home_dir: `/home/${id}`,
    role_summary: null,
    avatar_attachment_id: null,
    avatar_filename: null,
    avatar_size: null,
    avatar_content_type: null,
    avatar_blob_url_token: null,
    is_dm_agent: false,
    permissions: null,
    onboarded_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as AgentDto;
}

function msg(
  id: string,
  seq: number,
  content: string,
  partial: { from_kind?: 'user' | 'agent'; from_agent_id?: string | null } = {},
): MessageDto {
  return {
    id,
    conversation_id: 'c1',
    from_kind: partial.from_kind ?? 'agent',
    from_agent_id: partial.from_agent_id ?? 'a1',
    from_user_id: null,
    content,
    metadata: null,
    attachments: null,
    seq,
    created_at: 1_700_000_000_000 + seq * 1000,
    task_number: null,
    task_status: null,
    task_title: null,
    task_workspace_id: null,
    task_archived_at: null,
    task_assignee: null,
  };
}

function render(messages: MessageDto[]): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const agentsById = new Map([['a1', agent('a1', { display_name: 'Alice' })]]);
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(MessageScreenshotView, {
        messages,
        agentsById,
        agentsByName: agentsById,
        channelTitle: 'design',
        channelKind: 'channel' as const,
      }),
    ),
  );
}

describe('MessageScreenshotView — non-interactive contract', () => {
  it('renders zero <button> elements for fenced code blocks', () => {
    const html = render([
      msg(
        'm1',
        1,
        '```ts\nconst answer = 42;\nconsole.log(answer);\n```',
      ),
    ]);
    // Plain `<pre>` only; copy + expand buttons should be absent.
    expect(html).not.toMatch(/<button/);
    expect(html).not.toMatch(/role="button"/);
    expect(html).toContain('<pre');
    // hljs wraps tokens in spans, so `const answer` is split — assert
    // on individual tokens that survive highlighting.
    expect(html).toContain('answer');
    expect(html).toContain('42');
  });

  it('does not emit code-block chrome class names', () => {
    const html = render([
      msg('m1', 1, '```\necho hi\n```'),
    ]);
    expect(html).not.toContain('code-block__copy');
    expect(html).not.toContain('code-block__expand');
    expect(html).not.toContain('code-block__lang');
  });

  it('plain external links collapse to span without href / onclick', () => {
    const html = render([
      msg('m1', 1, 'see [the docs](https://example.com)'),
    ]);
    // No href on the rendered link branch; no anchor element at all
    // for the static-link path. Static span with the text content.
    expect(html).toContain('the docs');
    expect(html).not.toMatch(/<a[^>]*href="https:\/\/example\.com"/);
    expect(html).not.toContain('onclick');
    // `markdown-link-static` is the marker class the export branch
    // applies — pinning it lets future drift trip a test instead of
    // silently re-exposing real anchors.
    expect(html).toContain('markdown-link-static');
  });

  it('internal @mention refs collapse to static accent span (no Mention component)', () => {
    const html = render([msg('m1', 1, 'ping @bob about it')]);
    // `<Mention>` wraps a button + popover trigger; static path is a
    // bare span. So the dom should NOT contain any button-role
    // elements or the popover-content data attribute Radix injects.
    expect(html).toContain('@bob');
    expect(html).not.toMatch(/<button/);
    expect(html).not.toContain('data-radix');
  });

  it('#conv: refs render as static accent span (no ConversationRef hook)', () => {
    const html = render([msg('m1', 1, 'see #conv:abcdefghijklmnop for details')]);
    expect(html).toContain('#conv:abcdefghijklmnop');
    expect(html).not.toMatch(/<button/);
  });

  it('#task: refs render as static accent span (no TaskRef hook)', () => {
    const html = render([msg('m1', 1, 'fixed in #task:42')]);
    expect(html).toContain('#task:42');
    expect(html).not.toMatch(/<button/);
  });

  it('#<channel> refs render as static accent span (no ChannelRef component)', () => {
    const html = render([msg('m1', 1, 'discuss in #design please')]);
    expect(html).toContain('#design');
    expect(html).not.toMatch(/<button/);
  });

  it('aggregate sanity — no interactive surfaces in a content with all ref types', () => {
    const html = render([
      msg(
        'm1',
        1,
        'recap @alice see #conv:abcdefghijklmnop and #task:7 in #general\n\n```sh\necho ok\n```\n\nDocs: [link](https://example.com)',
      ),
    ]);
    expect(html).not.toMatch(/<button/);
    expect(html).not.toMatch(/role="button"/);
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('code-block__copy');
    expect(html).not.toContain('code-block__expand');
    // All identifiable text fragments are still present — the export
    // visual is intact, just stripped of every clickable surface.
    expect(html).toContain('@alice');
    expect(html).toContain('#conv:abcdefghijklmnop');
    expect(html).toContain('#task:7');
    expect(html).toContain('#general');
    // hljs splits the bash content; assert on a surviving token.
    expect(html).toContain('echo');
    expect(html).toContain('link');
  });
});
