import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Markdown } from './Markdown';
import { SystemMessage } from './SystemMessage';
import type { ChannelReference } from './ChannelRef';
import type { ConversationReference } from './ConversationRef';
import { TaskRefContextProvider } from '@/features/tasks/TaskRefContext';

function render(content: string, refs?: Map<string, ConversationReference>): string {
  // PR-4 commit 5 (Cindy review of `45fca42`): ConversationRef now
  // calls `useConversationById` so it can resolve cross-workspace
  // refs that the synchronous `conversationRefsById` map can't see.
  // That hook requires a QueryClient context — wrap every render
  // in one. SSR doesn't drive the query lifecycle so the prop path
  // (`conversationRefsById` resolved entries) still produces the
  // resolved markup the assertions check; missing entries land in
  // `loading` and the popover stays skeleton (caller asserts
  // chip-level data attributes only).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Markdown, {
        content,
        conversationRefsById: refs,
        onOpenConversationRef: () => undefined,
      }),
    ),
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

describe('SystemMessage channel refs', () => {
  // Construct a minimal MessageDto. Only the fields SystemMessage /
  // its inner cards read need realistic values; the rest are filled
  // with type-correct stubs.
  function makeSystemMessage(
    subtype: string,
    metadata: Record<string, unknown>,
    content = '',
  ): import('@silverhand/shared').MessageDto {
    return {
      id: 'sys-1',
      conversation_id: 'conv-1',
      from_kind: 'system',
      from_agent_id: null,
      from_user_id: null,
      content,
      metadata: { subtype, ...metadata },
      attachments: null,
      seq: 1,
      created_at: 0,
      task_number: null,
      task_status: null,
      task_title: null,
      task_workspace_id: null,
      task_assignee: null,
    };
  }

  function renderSystem(
    msg: import('@silverhand/shared').MessageDto,
    channelsByName: Map<string, ChannelReference | null>,
  ): string {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return renderToStaticMarkup(
      React.createElement(
        StaticRouter,
        { location: '/' },
        React.createElement(
          QueryClientProvider,
          { client: qc },
          React.createElement(SystemMessage, {
            message: msg,
            channelsByName,
            onOpenChannelRef: () => undefined,
          }),
        ),
      ),
    );
  }

  it('resolves #<channel_name> inside a thread_summary card body', () => {
    // thread_summary cards render `metadata.summary` through Markdown —
    // the previous gap was that `MessageList` only forwarded
    // `conversationRefsById`, so summaries that mention `#version3`
    // got the unresolved branch even when the title existed in the
    // workspace's channel map.
    const channels = new Map<string, ChannelReference | null>([
      ['version3', { id: 'ch-v3', title: 'version3' }],
    ]);
    const msg = makeSystemMessage('thread_summary', {
      thread_title: 't1',
      summary: 'see #version3 for context',
    });
    const html = renderSystem(msg, channels);
    expect(html).toContain('data-channel-ref-state="resolved"');
    expect(html).toContain('data-channel-ref-id="ch-v3"');
  });

  it('resolves #<channel_name> inside a non-collapsible system narration', () => {
    // join/leave / generic system messages render `message.content`
    // through Markdown directly. Use an unknown subtype to land in the
    // !collapsible branch.
    const channels = new Map<string, ChannelReference | null>([
      ['version3', { id: 'ch-v3', title: 'version3' }],
    ]);
    const msg = makeSystemMessage(
      'unknown',
      {},
      'broadcast — #version3 archived',
    );
    const html = renderSystem(msg, channels);
    expect(html).toContain('data-channel-ref-state="resolved"');
    expect(html).toContain('data-channel-ref-id="ch-v3"');
  });

  it('renders session_cleared as a destructive audit card', () => {
    const msg = makeSystemMessage(
      'session_cleared',
      { agent_name: 'alice' },
      "@local cleared @alice's CLI session context",
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('lucide-eraser');
    expect(html).toContain('border-error/25');
    expect(html).toContain('CLI session context');
  });
});

describe('Markdown channel refs', () => {
  function renderWithChannels(
    content: string,
    channelsByName: Map<string, ChannelReference | null>,
    onOpenChannelRef?: (channelId: string) => void,
  ): string {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Markdown, {
          content,
          channelsByName,
          onOpenChannelRef,
        }),
      ),
    );
  }

  it('renders #<channel_name> as a clickable accent pill when uniquely resolved', () => {
    const channels = new Map<string, ChannelReference | null>([
      ['version3', { id: 'ch-v3-id', title: 'version3' }],
    ]);
    const html = renderWithChannels('See #version3 for context.', channels, () => undefined);
    expect(html).toContain('data-channel-ref-state="resolved"');
    expect(html).toContain('data-channel-ref-id="ch-v3-id"');
    // The chip displays the channel title; the bare `#version3` literal
    // shouldn't survive (since the chip prefixes the icon, not text).
    expect(html).toContain('version3');
    expect(html).not.toContain('>#version3<');
  });

  it('renders ambiguous #<channel_name> as inert muted text', () => {
    // Sentinel `null` value = two channels in the workspace share this
    // title; the renderer must not silently pick one.
    const channels = new Map<string, ChannelReference | null>([
      ['general', null],
    ]);
    const html = renderWithChannels('See #general here.', channels, () => undefined);
    expect(html).toContain('data-channel-ref-state="ambiguous"');
    expect(html).toContain('#general');
    expect(html).not.toContain('data-channel-ref-id');
  });

  it('renders unresolved #<channel_name> as inert muted text', () => {
    // Empty map → no entry for `version3` → unresolved branch.
    const html = renderWithChannels('See #unknown here.', new Map(), () => undefined);
    expect(html).toContain('data-channel-ref-state="unresolved"');
    expect(html).toContain('#unknown');
    expect(html).not.toContain('data-channel-ref-id');
  });

  it('still renders inert (no role=button) when click handler is omitted', () => {
    const channels = new Map<string, ChannelReference | null>([
      ['version3', { id: 'ch-v3-id', title: 'version3' }],
    ]);
    const html = renderWithChannels('See #version3.', channels);
    expect(html).toContain('data-channel-ref-state="resolved-no-handler"');
    expect(html).not.toContain('role="button"');
  });
});

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

  it('resolves cross-workspace #conv: via useConversationById when prop is missing', () => {
    // Cindy review of commit 3 (`45fca42`): the original implementation
    // only used the synchronous `conversationRefsById` map, which is
    // workspace-scoped — any `#conv:<id>` pointing at a foreign
    // workspace would render permanently as `#conv:<short>` and the
    // popover would skeleton forever. ConversationRef now also calls
    // `useConversationById(id)` so cross-workspace refs resolve. We
    // pre-seed React Query's cache with the resolved payload so SSR
    // observes it as `resolved` without hitting the network.
    const id = 'CrossWsRef12345_';
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['conversation-ref', id], {
      ref: {
        id,
        kind: 'channel',
        title: 'foreign-channel',
        workspace_id: 'ws-foreign',
        workspace_kind: 'regular',
        workspace_path: '/tmp/ws-foreign',
        parent_channel_id: null,
        parent_title: null,
        closed_at: null,
        archived_at: null,
      },
    });
    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Markdown, {
          content: `See #conv:${id}.`,
          // Intentionally omit `conversationRefsById` so the hook is
          // the only resolution path — exercises the cross-workspace
          // case end-to-end.
          onOpenConversationRef: () => undefined,
        }),
      ),
    );
    expect(html).toContain(`data-conversation-ref="${id}"`);
    // Resolved title from the hook surfaces on the chip — proves the
    // hook→prop fallback chain works and the chip didn't get stuck
    // on the `#conv:<short>` placeholder.
    expect(html).toContain('foreign-channel');
    expect(html).not.toContain(`#conv:${id.slice(0, 6)}`);
  });
});

describe('Markdown task refs — loading-state hover popover', () => {
  it('wraps the loading chip in HoverPopover so 500ms hover reveals a skeleton', () => {
    // Cindy review of commit 3 (`45fca42`): the original loading
    // branch returned a bare `<span>` with no HoverPopover wrapper,
    // so a hover ≥500ms while the fetch was in flight produced
    // nothing — violating the "no spinner, but DO show a non-spinner
    // loading state after 500ms" spec.
    //
    // SSR can't drive HoverCard's open state but we CAN verify that
    // the chip carries the `loading` state attribute and that the
    // HoverCard.Root structure is in place around it (radix renders
    // a `data-state` on the trigger element). The key regression
    // is: chip-state="loading" must be present, distinguishing it
    // from the no-context / missing branches that stay tooltip-only.
    const html = renderWithTaskCtx('Working on #task:5 now.', 'w-eng', () => {});
    expect(html).toContain('data-task-ref="5"');
    expect(html).toContain('data-task-ref-state="loading"');
    // HoverCard.Trigger forwards `data-state="closed"` onto the
    // wrapped chip element so the radix popover styling can hook
    // into it. Its presence on the loading-state chip confirms the
    // chip went through HoverPopover (the no-context / missing
    // branches return a bare `<span>` without that attribute).
    expect(html).toMatch(
      /data-task-ref-state="loading"[^>]*data-state="closed"|data-state="closed"[^>]*data-task-ref-state="loading"/,
    );
  });

  it('keeps no-context and missing states tooltip-only (no HoverPopover wrap)', () => {
    // Inverse of the above: states with nothing meaningful to show
    // in a popover stay bare so a hover doesn't open an empty card.
    // No-context (no workspace anchor) is tested via `null` workspace.
    const html = renderWithTaskCtx('See #task:42.', null);
    expect(html).toContain('data-task-ref-state="no-context"');
    // No `data-state="closed"` adjacent to the no-context chip
    // because it never went through HoverCard.
    expect(html).not.toMatch(
      /data-task-ref-state="no-context"[^>]*data-state="closed"|data-state="closed"[^>]*data-task-ref-state="no-context"/,
    );
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

  it('rejects #task:0 / leading-zero / mixed-suffix forms (Cindy review of 80f544e)', () => {
    // The tokenizer regex tightened from `#task:(\d+)(?!\d)` to
    // `#task:([1-9]\d*)(?!\w)` so `#task:0` is silently demoted to
    // text and never reaches the renderer's `silverhand-task:0`
    // branch. Also asserts no internal scheme leaks into the rendered
    // HTML — previously the malformed path could fall through to a
    // plain `<a href="silverhand-task:0">`, which on click would call
    // `window.agentHub.openExternal` and shell out our internal URL.
    //
    // Note: `#task:1.5` is intentionally NOT tested here. By markdown
    // convention (matches `#conv:` behavior), the period terminates
    // the match — `#task:1` becomes a chip, `.5` is trailing text.
    // The decimal-rejection contract is enforced at the URL parser
    // (`?task=1.5` → null) where it actually matters; in prose
    // there's no way to *write* the user's intent unambiguously.
    const html = renderWithTaskCtx(
      ['#task:0', '#task:01', '#task:12abc'].join(' '),
      'w-eng',
      () => {},
    );
    expect(html).not.toContain('data-task-ref="0"');
    expect(html).not.toContain('data-task-ref="01"');
    expect(html).not.toContain('data-task-ref="12"');
    expect(html).not.toContain('silverhand-task:0');
    expect(html).not.toContain('silverhand-task:12');
    // The literal text should survive as prose.
    expect(html).toContain('#task:0');
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
