import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Markdown } from './Markdown';
import type { ConversationReference } from './ConversationRef';
import { TaskRefContextProvider } from '@/features/tasks/TaskRefContext';

function render(content: string, refs?: Map<string, ConversationReference>): string {
  return renderToStaticMarkup(
    React.createElement(Markdown, {
      content,
      conversationRefsById: refs,
      onOpenConversationRef: () => undefined,
    }),
  );
}

/**
 * Render a Markdown subtree wrapped with the React Query provider plus
 * an optional `TaskRefContext`. SSR rendering does not actually run the
 * `useQuery` lifecycle (no fetch happens, isLoading stays true on first
 * render), so for the tokenizer-shape assertions we only need the
 * wrapper to satisfy the hook's required context. PR-4 commit 3 will
 * add a hook-level test that exercises resolved/missing/loading paths
 * via a query-cache pre-seed.
 */
function renderWithTaskCtx(
  content: string,
  workspaceId: string | null,
  onOpenTask?: (n: number) => void,
): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(
        TaskRefContextProvider,
        { value: { workspaceId, onOpenTask } },
        React.createElement(Markdown, { content }),
      ),
    ),
  );
}

describe('Markdown conversation refs', () => {
  it('renders #conv:<conversation_id> as a clickable conversation pill', () => {
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

    const html = render(`See #conv:${id} for details.`, refs);

    expect(html).toContain(`data-conversation-ref="${id}"`);
    expect(html).toContain('bg-accent-soft');
    expect(html).toContain('version3');
    expect(html).not.toContain('#version3');
    expect(html).not.toContain(`#conv:${id}`);
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

    const html = render(`See #conv:${id}.`, refs);

    expect(html).toContain(`data-conversation-ref="${id}"`);
    expect(html).toContain('debug:thread 1');
    expect(html).not.toContain('#debug:thread 1');
  });

  it('keeps unresolved refs clickable by id', () => {
    const html = render('Open #conv:foreignRef123456.');

    expect(html).toContain('data-conversation-ref="foreignRef123456"');
    expect(html).toContain('#conv:foreignRef123456');
  });

  it('does not parse short refs, longer id-like tokens, code, or existing links', () => {
    const html = render(
      [
        'short #conv:foo',
        'long #conv:foreignRef12345678x',
        '`#conv:codeRef12345678`',
        '[#conv:linkedRef123456](https://example.com)',
        '#conv:realRef123456789.bar',
      ].join(' '),
    );

    expect(html).toContain('data-conversation-ref="realRef123456789"');
    expect(html).not.toContain('data-conversation-ref="foo"');
    expect(html).not.toContain('data-conversation-ref="foreignRef12345678"');
    expect(html).not.toContain('data-conversation-ref="codeRef12345678"');
    expect(html).not.toContain('data-conversation-ref="linkedRef123456"');
    expect(html).toContain('.bar');
  });

  it('does not parse legacy `#~<id>` form (hard cutover, no alias)', () => {
    // Ensure the pre-cutover sigil shape is silently demoted to inert
    // text. Hard cutover per @shiki direction: legacy form had only a
    // few days of usage and no production references depend on it.
    const html = render('See #~AbC123_-xyZ789qR for details.');
    expect(html).not.toContain('data-conversation-ref="AbC123_-xyZ789qR"');
    expect(html).toContain('#~AbC123_-xyZ789qR');
  });
});

describe('Markdown task refs', () => {
  it('emits a TaskRef chip for `#task:<n>` with workspace context', () => {
    // Tokenizer shape only: SSR doesn't drive useQuery to resolved, so
    // the chip lands as an inert pill carrying `data-task-ref`. The
    // important guarantees are (a) the sigil produced a TaskRef node
    // (not a stray channel ref or plain text) and (b) the inert pill
    // shows the verbatim `#task:5` label.
    const html = renderWithTaskCtx('Working on #task:5 now.', 'w-eng', () => {});
    expect(html).toContain('data-task-ref="5"');
    expect(html).toContain('#task:5');
    // No collision with channel ref grammar — the `#task:` literal must
    // not be mis-tokenized as `#task` channel + `:5` trailing text.
    expect(html).not.toContain('silverhand-channel:task');
  });

  it('renders inert `#task:<n>` text outside any TaskRefContext', () => {
    // Saved/preview surfaces render Markdown without a workspace
    // anchor. The chip should still appear (so `#task:5` is visually
    // distinct from prose) but in a no-context state — no click
    // handler attached.
    const html = renderWithTaskCtx('See #task:42.', null);
    expect(html).toContain('data-task-ref="42"');
    expect(html).toContain('data-task-ref-state="no-context"');
  });

  it('does not match malformed task sigils', () => {
    // Word-boundary + digit-only validation. None of these should
    // produce a TaskRef.
    const html = renderWithTaskCtx(
      [
        'PR #123',          // bare # + number is *issue ref*, not task
        'see#1',             // attached to word — `?<![\\w/]` blocks
        '#task:abc',         // non-numeric value
        '#task:0',           // zero is not a valid task number (still emits chip — number itself is fine, allow rendering and the caller filters)
        '`#task:99`',        // inside inline code
        '[#task:7](https://example.com)', // inside existing link
      ].join(' '),
      'w-eng',
      () => {},
    );
    // None of the protected forms should yield a TaskRef chip.
    expect(html).not.toContain('data-task-ref="123"');
    expect(html).not.toContain('data-task-ref="1"');
    expect(html).not.toContain('data-task-ref="99"');
    expect(html).not.toContain('data-task-ref="7"');
    // `#task:abc` doesn't match the digit-only branch and the channel
    // fallback is excluded by `(?!conv:|task:)` lookahead → plain text.
    expect(html).not.toContain('silverhand-task:abc');
    expect(html).not.toContain('silverhand-channel:task');
  });

  it('mixes #task and #conv sigils in the same paragraph', () => {
    const html = renderWithTaskCtx(
      'Forwarded #task:7 from #conv:AbC123_-xyZ789qR — see thread.',
      'w-eng',
      () => {},
    );
    expect(html).toContain('data-task-ref="7"');
    expect(html).toContain('data-conversation-ref="AbC123_-xyZ789qR"');
    // Order of nodes preserved.
    expect(html.indexOf('data-task-ref="7"')).toBeLessThan(
      html.indexOf('data-conversation-ref="AbC123_-xyZ789qR"'),
    );
  });
});
