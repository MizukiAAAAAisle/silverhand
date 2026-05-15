import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TaskSummaryDto } from '@silverhand/shared';
import { Markdown } from './Markdown';
import { SystemMessage } from './SystemMessage';
import type { ChannelReference } from './ChannelRef';
import type { ConversationReference } from './ConversationRef';
import { TaskRefContextProvider } from '@/features/tasks/TaskRefContext';
import { taskByNumberKey } from '@/features/tasks/useTaskByNumber';

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
    conversationRefsById?: Map<string, ConversationReference>,
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
            conversationRefsById,
            onOpenConversationRef: () => undefined,
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

  it('renders session_cleared full metadata as inline audit row (no toast styling)', () => {
    const msg = makeSystemMessage(
      'session_cleared',
      {
        agent_id: 'a-alice',
        agent_name: 'Alice',
        actor_user_id: 'local',
        previous_cli_session_id_prefix: 'fbe21c8a',
        was_running: true,
      },
      "@local cleared @alice's CLI session context",
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('data-session-cleared="1"');
    expect(html).toContain('lucide-rotate-ccw');
    // RotateCcw, not the destructive Eraser.
    expect(html).not.toContain('lucide-eraser');
    // No toast container colors.
    expect(html).not.toContain('border-error');
    expect(html).not.toContain('bg-error');
    // Structured pieces visible.
    expect(html).toContain('@you');
    expect(html).toContain('reset');
    expect(html).toContain('@Alice');
    expect(html).toContain('fbe21c8a');
    expect(html).toContain('was running');
  });

  it('session_cleared was_running=false renders "was idle"', () => {
    const msg = makeSystemMessage(
      'session_cleared',
      {
        agent_id: 'a-bob',
        agent_name: 'Bob',
        actor_user_id: 'local',
        previous_cli_session_id_prefix: null,
        was_running: false,
      },
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('data-session-cleared-running="0"');
    expect(html).toContain('was idle');
    // No `prev <hash>` chip when previous_cli_session_id_prefix is null.
    expect(html).not.toContain('prev ');
  });

  it('session_cleared with actor_user_id=null renders "a user", NOT @you', () => {
    // Schema docstring (`packages/shared/src/system-messages.ts`):
    // null = principal info wasn't recorded at insert time. This is the
    // OPPOSITE of the v1 message-row convention where null = current
    // viewer. Renderer must NOT route null through
    // `formatUserDisplayName` (which would produce `@you`) here.
    const msg = makeSystemMessage(
      'session_cleared',
      {
        agent_id: 'a-bob',
        agent_name: 'Bob',
        actor_user_id: null,
        previous_cli_session_id_prefix: 'aabbccdd',
        was_running: true,
      },
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('data-session-cleared="1"');
    expect(html).toContain('data-session-cleared-actor="unknown"');
    expect(html).toContain('a user');
    expect(html).not.toContain('@you');
  });

  it('session_cleared with no metadata falls back to legacy audit row + RotateCcw', () => {
    const msg = makeSystemMessage(
      'session_cleared',
      {},
      "@local cleared @alice's CLI session context (prev fbe21c8a)",
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('data-session-cleared-legacy="1"');
    expect(html).toContain('lucide-rotate-ccw');
    expect(html).not.toContain('border-error');
    expect(html).toContain("CLI session context");
  });

  it('renders schedule_fire as a flat banner with header + pills + body', () => {
    const now = Date.now();
    const planned = now - 2_000; // 2s ago: wake fired 2s late
    const next = now + 5 * 60_000; // 5m from now
    const msg = makeSystemMessage(
      'schedule_fire',
      {
        schedule_id: 's-1',
        spec_kind: 'cron',
        spec_summary: 'cron */5 9-18 * * 1-5 (Asia/Shanghai)',
        body: 'Reminder: review #task:294 status, ping @shiki if still in_review.',
        actual_fire_at: now,
        planned_fire_at: planned,
        missed_count: 0,
        next_fire_at: next,
      },
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('data-schedule-fire="1"');
    expect(html).toContain('lucide-clock');
    expect(html).toContain('border-l-warning');
    // Header spec summary surfaced.
    expect(html).toContain('cron */5 9-18 * * 1-5 (Asia/Shanghai)');
    // All four pills present, in order.
    expect(html).toContain('data-pill="fired"');
    expect(html).toContain('data-pill="planned"');
    expect(html).toContain('data-pill="missed"');
    expect(html).toContain('data-pill="next"');
    expect(html).toContain('data-missed-count="0"');
    // Body surfaced (not the producer scaffolding).
    expect(html).toContain('Reminder');
    expect(html).toContain('review');
  });

  it('schedule_fire missed_count > 0 highlights the missed pill', () => {
    const msg = makeSystemMessage(
      'schedule_fire',
      {
        schedule_id: 's-2',
        spec_kind: 'interval',
        spec_summary: 'interval 60s',
        body: 'Poll deploy status; alert if still pending.',
        actual_fire_at: Date.now(),
        planned_fire_at: Date.now() - 4 * 60_000,
        missed_count: 4,
        next_fire_at: Date.now() + 60_000,
      },
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('data-missed-count="4"');
    expect(html).toContain('bg-warning/10');
    expect(html).toContain('text-warning');
    expect(html).toContain('interval 60s');
  });

  it('schedule_fire one-shot keeps planned pill but suppresses next pill', () => {
    // The producer writes `planned_fire_at: dto.next_fire_at` on every
    // fire including one-shot, so the planned pill IS drawn (it carries
    // late/on-time info even for `once`). Only `next_fire_at` flips to
    // null after a one-shot's last fire — so only the `next` pill is
    // suppressed. Schema keeps `planned_fire_at` nullable just to absorb
    // pre-PR-4 legacy rows.
    const planned = Date.now() - 1_000;
    const msg = makeSystemMessage(
      'schedule_fire',
      {
        schedule_id: 's-3',
        spec_kind: 'once',
        spec_summary: 'once',
        body: 'Final reminder before deploy window closes.',
        actual_fire_at: Date.now(),
        planned_fire_at: planned,
        missed_count: 0,
        next_fire_at: null,
      },
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('data-pill="fired"');
    expect(html).toContain('data-pill="planned"');
    expect(html).toContain('data-pill="missed"');
    expect(html).not.toContain('data-pill="next"');
  });

  it('schedule_fire without metadata still renders the banner with raw content', () => {
    const msg = makeSystemMessage(
      'schedule_fire',
      {},
      'Schedule fired (kind: cron, planned 2026-05-15T...): legacy body text.',
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('data-schedule-fire="0"');
    expect(html).toContain('Scheduled wake');
    expect(html).toContain('legacy body text');
    // No pills when metadata is absent.
    expect(html).not.toContain('data-pill="fired"');
  });

  // PR-5: thread_anchor / child_context / channel_context unified
  // context-card series. Each renders with a left-accent border per
  // kind, an uppercase kind tag, a source chip, and a body that's
  // collapsible (default-expanded only for thread_anchor — the quote
  // body IS the point of the row).

  it('renders thread_anchor as a Quoted card with default-expanded blockquote', () => {
    const msg = makeSystemMessage('thread_anchor', {
      quoted_message_id: 'msg-orig',
      quoted_conversation_id: 'conv-parent',
      quoted_channel_name: 'version3',
      quoted_content: '我们的 system message 渲染太朴素了，能不能优化下 UI？',
      quoted_from_kind: 'user',
      quoted_from_agent_id: null,
      quoted_from_user_id: 'local',
      quoted_agent_name: null,
      quoted_created_at: Date.now() - 2 * 60_000,
    });
    const refs = new Map<string, ConversationReference>([
      ['conv-parent', { id: 'conv-parent', kind: 'channel', title: 'version3' }],
    ]);
    const html = renderSystem(msg, new Map(), refs);
    expect(html).toContain('data-context-card="quoted"');
    expect(html).toContain('border-l-accent');
    // Kind tag uppercase + colored bg.
    expect(html).toContain('Quoted');
    expect(html).toContain('bg-accent');
    // Source chip is a clickable ConversationRef pointing at the
    // parent conversation; the prop fast path resolves to the channel
    // title so the chip shows "version3" (the leading # is rendered
    // as a separate Hash icon).
    expect(html).toContain('data-conversation-ref="conv-parent"');
    expect(html).toContain('>version3<');
    // Default expanded → blockquote rendered, no toggle.
    expect(html).toContain('<blockquote');
    expect(html).toContain('我们的 system message');
    expect(html).not.toContain('data-context-toggle="expand"');
  });

  it('renders child_context as an Inherited card collapsed by default', () => {
    const msg = makeSystemMessage('child_context', {
      parent_conversation_id: 'conv-parent',
      parent_title: 'feature/cli design',
      summary:
        'PR-1 design discussed in 5 rounds; PR-A registry + drift guard is structural prelude.',
    });
    const refs = new Map<string, ConversationReference>([
      [
        'conv-parent',
        { id: 'conv-parent', kind: 'channel', title: 'feature/cli design' },
      ],
    ]);
    const html = renderSystem(msg, new Map(), refs);
    expect(html).toContain('data-context-card="inherited"');
    expect(html).toContain('border-l-success');
    expect(html).toContain('Inherited');
    expect(html).toContain('bg-success');
    // Source chip "from " prefix + clickable ConversationRef.
    expect(html).toContain('from ');
    expect(html).toContain('data-conversation-ref="conv-parent"');
    expect(html).toContain('>feature/cli design<');
    // Default collapsed → expand toggle present.
    expect(html).toContain('data-context-toggle="expand"');
    expect(html).not.toContain('<blockquote');
  });

  it('renders channel_context as a Spawned-from card with clickable source chip', () => {
    const msg = makeSystemMessage(
      'channel_context',
      {
        source_conversation_id: 'conv-source',
        source_conversation_title: 'version3',
        created_by_agent_id: 'a-cindy',
        created_by_agent_name: 'Cindy',
      },
      'Continue the system-message redesign discussion in a focused channel.',
    );
    const refs = new Map<string, ConversationReference>([
      ['conv-source', { id: 'conv-source', kind: 'channel', title: 'version3' }],
    ]);
    const html = renderSystem(msg, new Map(), refs);
    expect(html).toContain('data-context-card="spawned"');
    expect(html).toContain('border-l-warning');
    expect(html).toContain('Spawned-from');
    expect(html).toContain('bg-warning');
    expect(html).toContain('data-conversation-ref="conv-source"');
    expect(html).toContain('>version3<');
    expect(html).toContain('by @Cindy');
    expect(html).toContain('data-context-toggle="expand"');
  });

  it('channel_context falls back gracefully when source title / agent_name are absent', () => {
    // Pre-PR-5 producer rows only have id pairs (no snapshot title /
    // agent_name). The renderer still keeps the spawned card chrome:
    // ConversationRef itself handles title resolution via
    // useConversationById — under SSR with no map and no resolved
    // hook, it falls back to the `#conv:<short>` short label, so the
    // chip stays clickable. The agent suffix degrades to "by an agent".
    const msg = makeSystemMessage(
      'channel_context',
      {
        source_conversation_id: 'conv-source',
        created_by_agent_id: 'a-cindy',
      },
      'seed body',
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('data-context-card="spawned"');
    expect(html).toContain('Spawned-from');
    // Chip is still present + clickable, just shows the short id.
    expect(html).toContain('data-conversation-ref="conv-source"');
    expect(html).toContain('by an agent');
  });

  it('thread_anchor without enriched metadata falls back to legacy muted row', () => {
    const msg = makeSystemMessage(
      'thread_anchor',
      {},
      'Quoted from #version3 · @shiki: legacy quote body text.',
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('data-context-card-legacy="1"');
    expect(html).toContain('border-l-accent');
    expect(html).toContain('Quoted');
    expect(html).toContain('legacy quote body text');
    // No structured chip / blockquote.
    expect(html).not.toContain('<blockquote');
  });

  it('child_context without summary metadata falls back to legacy muted row', () => {
    const msg = makeSystemMessage(
      'child_context',
      {},
      "Inherited context from parent channel 'feature/cli design': legacy summary",
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('data-context-card-legacy="1"');
    expect(html).toContain('border-l-success');
    expect(html).toContain('Inherited');
    expect(html).toContain('legacy summary');
  });

  // PR-1 added three-state subtype resolution. Legacy DB-resident
  // subtypes (`join`, `session_context`, `child_summary`) and unknown
  // strings both fall through to generic narration — neither pretends
  // to be a current subtype's custom card.
  it('renders legacy `child_summary` rows as generic narration, not collapsible', () => {
    const msg = makeSystemMessage(
      'child_summary',
      {},
      'Sub-session 8c2a closed; transcript saved',
    );
    const html = renderSystem(msg, new Map());
    // The collapsible component renders a `<button>` with `aria-expanded`;
    // generic narration renders a centered italic `<div>` instead.
    expect(html).not.toContain('aria-expanded');
    expect(html).toContain('italic');
    expect(html).toContain('Sub-session 8c2a closed');
  });

  it('renders legacy `join` rows as generic narration', () => {
    const msg = makeSystemMessage('join', {}, '@old-agent joined #version3');
    const html = renderSystem(msg, new Map());
    expect(html).not.toContain('aria-expanded');
    expect(html).toContain('italic');
    expect(html).toContain('@old-agent');
    expect(html).toContain('joined');
  });

  // PR-1 dropped the `inferSubtype` content-prefix backfill. Old rows
  // whose metadata never carried `subtype` no longer get retroactively
  // mapped to `onboarding` based on their content prefix — they
  // resolve to `unknown` and render as generic narration instead.
  it('does NOT collapse pre-metadata onboarding rows by content prefix', () => {
    const msg = makeSystemMessage(
      // No subtype field at all in metadata.
      // @ts-expect-error: deliberately testing the missing-subtype path.
      undefined,
      {},
      'Onboarding task (system-triggered): you joined #foo. Send greeting.',
    );
    // Strip the test helper's auto-injected `subtype` since we want the
    // raw metadata to NOT have one. makeSystemMessage spreads {subtype, ...}
    // so we override here.
    msg.metadata = {};
    const html = renderSystem(msg, new Map());
    expect(html).not.toContain('aria-expanded');
    expect(html).toContain('italic');
  });

  // PR-6: onboarding gets an explicit "Onboarding" badge alongside
  // the chevron + first-line preview. Same collapsible affordance as
  // PR-1's `CollapsibleNarration`, but the row is now recognisable
  // as an onboarding instruction at a glance.

  it('renders onboarding with badge + chevron + first-line preview (collapsed)', () => {
    const msg = makeSystemMessage(
      'onboarding',
      {},
      'Onboarding task: you (@Alice) joined #version3.\n1) Send greeting.\n2) Stop.',
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('data-onboarding-row="1"');
    expect(html).toContain('data-onboarding-badge="1"');
    expect(html).toContain('Onboarding');
    expect(html).toContain('bg-accent-soft');
    // First-line preview only when collapsed (default state in SSR).
    expect(html).toContain('Onboarding task: you (@Alice) joined #version3.');
    expect(html).not.toContain('Send greeting');
    expect(html).toContain('aria-expanded="false"');
  });

  it('onboarding row uses items-start so chevron/badge stay top-aligned when expanded', () => {
    // Drift guard for PR-6 follow-up review by @Cindy: a previous
    // version used `items-center`, which floated the chevron and
    // badge into the vertical middle of the expanded multi-line
    // body. The button must use `items-start`, the chevron
    // `mt-[3px]`, and the badge `mt-0.5` so all three line up
    // against the first line of the body.
    const msg = makeSystemMessage(
      'onboarding',
      {},
      'Onboarding task: greet then stop.',
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('items-start');
    expect(html).not.toMatch(/data-onboarding-row="1"[^>]*items-center/);
    expect(html).toContain('mt-[3px]');
    // Badge gets a small top offset of its own for first-line baseline.
    // SSR emits class= before data-onboarding-badge=, so match the
    // element directly to lock the pairing without depending on attr
    // order.
    expect(html).toMatch(/<span class="[^"]*mt-0\.5[^"]*"[^>]*data-onboarding-badge="1"/);
  });

  // PR-6: rename reads `{old_name, new_name}` and draws a compact
  // audit row (`↻ workspace renamed #old → #new`) instead of relying
  // on the prose body. Legacy rows without metadata fall through to
  // generic italic narration.

  it('renders rename with ↻ icon + old → new code chips when metadata is present', () => {
    const msg = makeSystemMessage(
      'rename',
      { old_name: 'version2', new_name: 'version3' },
      'This workspace was renamed from #version2 to #version3.',
    );
    const html = renderSystem(msg, new Map());
    expect(html).toContain('data-rename-row="1"');
    expect(html).toContain('lucide-rotate-cw');
    expect(html).toContain('#version2');
    expect(html).toContain('#version3');
    expect(html).toContain('→');
    // Old-name and new-name both rendered as <code> chips.
    expect(html).toMatch(/<code[^>]*>#version2<\/code>/);
    expect(html).toMatch(/<code[^>]*>#version3<\/code>/);
  });

  it('renames without enriched metadata fall back to generic italic narration', () => {
    const msg = makeSystemMessage(
      'rename',
      {},
      'This workspace was renamed from #legacy-old to #legacy-new.',
    );
    const html = renderSystem(msg, new Map());
    expect(html).not.toContain('data-rename-row="1"');
    // Generic narration is centered italic muted text.
    expect(html).toContain('italic');
    expect(html).toContain('text-text-muted');
    expect(html).toContain('legacy-old');
    expect(html).toContain('legacy-new');
  });
});

describe('SystemMessage task event rows (PR-2)', () => {
  function makeSystemMessage(
    subtype: string,
    metadata: Record<string, unknown>,
    content = '',
  ): import('@silverhand/shared').MessageDto {
    return {
      id: 'sys-task-1',
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

  function renderTaskEvent(
    msg: import('@silverhand/shared').MessageDto,
    onOpenTask?: (n: number) => void,
    seededTasks: TaskSummaryDto[] = [],
  ): string {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Pre-seed the React Query cache so the embedded `<TaskRef>` chip
    // resolves to its clickable / inline-title state instead of staying
    // in the SSR `loading` branch. PR-7 collapsed the standalone
    // TaskEventChip onto TaskRef — title rendering is now driven by
    // TaskRef's own `useTaskByNumber` query, so tests must seed it.
    for (const t of seededTasks) {
      qc.setQueryData(taskByNumberKey(t.workspace_id, t.task_number), t);
    }
    return renderToStaticMarkup(
      React.createElement(
        StaticRouter,
        { location: '/' },
        React.createElement(
          QueryClientProvider,
          { client: qc },
          React.createElement(
            TaskRefContextProvider,
            { value: { workspaceId: 'ws-1', onOpenTask } },
            React.createElement(SystemMessage, {
              message: msg,
              channelsByName: new Map(),
              onOpenChannelRef: () => undefined,
            }),
          ),
        ),
      ),
    );
  }

  function seededTask(overrides: Partial<TaskSummaryDto> = {}): TaskSummaryDto {
    return {
      message_id: 'msg-task-x',
      task_number: 42,
      workspace_id: 'ws-1',
      workspace_name: 'silverhand',
      channel_id: 'chan-1',
      channel_name: 'general',
      thread_id: null,
      conversation: { id: 'chan-1', title: 'general' },
      status: 'todo',
      title: 'wire registry',
      assignee: null,
      creator: { type: 'agent', id: 'a-alice', name: 'Alice' },
      created_at: 0,
      ...overrides,
    };
  }

  const fullMeta = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    task_number: 42,
    task_status: 'todo',
    task_message_id: 'msg-task-42',
    task_title: 'wire registry',
    task_assignee: null,
    actor: { kind: 'agent', id: 'a-alice', name: 'Alice' },
    ...overrides,
  });

  it('task_create renders actor + verb + chip with title + todo dot', () => {
    const msg = makeSystemMessage('task_create', fullMeta({}));
    const html = renderTaskEvent(msg, () => undefined, [seededTask()]);
    expect(html).toContain('@Alice');
    expect(html).toContain('created');
    expect(html).toContain('data-task-event-dot="todo"');
    // PR-7: chip is now TaskRef. Resolved+handler state → label
    // `#42 · wire registry`, attribute `data-task-ref-state="resolved"`.
    expect(html).toContain('data-task-ref="42"');
    expect(html).toContain('data-task-ref-state="resolved"');
    expect(html).toContain('wire registry');
  });

  it('task_claim renders verb=claimed + chip + in_progress dot', () => {
    const msg = makeSystemMessage(
      'task_claim',
      fullMeta({
        task_status: 'in_progress',
        task_assignee: { type: 'agent', id: 'a-alice', name: 'Alice' },
      }),
    );
    const html = renderTaskEvent(msg, () => undefined, [
      seededTask({ status: 'in_progress' }),
    ]);
    expect(html).toContain('claimed');
    expect(html).toContain('data-task-event-dot="in_progress"');
    expect(html).toContain('data-task-ref="42"');
  });

  it('task_unclaim uses dashed-border dot (no fill)', () => {
    const msg = makeSystemMessage(
      'task_unclaim',
      fullMeta({ task_status: 'todo', task_assignee: null }),
    );
    const html = renderTaskEvent(msg, () => undefined, [seededTask()]);
    expect(html).toContain('unclaimed');
    expect(html).toContain('data-task-event-dot="unclaim"');
    expect(html).toContain('border-dashed');
    expect(html).toContain('data-task-ref="42"');
  });

  it('task_status renders @actor moved chip → status pill (PR-9 actor-first)', () => {
    const msg = makeSystemMessage('task_status', fullMeta({ task_status: 'in_review' }));
    const html = renderTaskEvent(msg, () => undefined, [
      seededTask({ status: 'in_review' }),
    ]);
    expect(html).toContain('@Alice');
    expect(html).toContain('moved');
    expect(html).toContain('data-task-ref="42"');
    expect(html).toContain('data-task-event-status="in_review"');
    expect(html).toContain('in review');
    // PR-9: actor is now the first text node, NOT a "by @actor"
    // suffix. Verify we don't accidentally re-introduce the old form.
    expect(html).not.toContain('by @Alice');
    // Reading order: @actor → moved → chip → pill.
    expect(html.indexOf('@Alice')).toBeLessThan(html.indexOf('moved'));
    expect(html.indexOf('moved')).toBeLessThan(html.indexOf('data-task-ref="42"'));
    expect(html.indexOf('data-task-ref="42"')).toBeLessThan(
      html.indexOf('data-task-event-status="in_review"'),
    );
  });

  it('user actor renders the viewer-friendly @you handle for current user', () => {
    const msg = makeSystemMessage(
      'task_status',
      fullMeta({
        task_status: 'done',
        actor: { kind: 'user', id: null, name: 'user' },
      }),
    );
    const html = renderTaskEvent(msg, () => undefined, [
      seededTask({ status: 'done' }),
    ]);
    expect(html).toContain('data-task-event-status="done"');
    // PR-9 actor-first: `@you moved ... → DONE`, not `... by @you`.
    expect(html).toContain('@you');
    expect(html).toContain('moved');
    expect(html).not.toContain('by @you');
  });

  it('chip is inert (no click handler) when no onOpenTask handler is supplied', () => {
    const msg = makeSystemMessage('task_create', fullMeta({}));
    const html = renderTaskEvent(msg, undefined, [seededTask()]);
    // PR-7: TaskRef now drives the chip. Without a handler in
    // TaskRefContext, the resolved chip falls into the
    // `resolved-no-handler` branch — no `role="button"`.
    expect(html).toContain('data-task-ref="42"');
    expect(html).toContain('data-task-ref-state="resolved-no-handler"');
    expect(html).not.toContain('data-task-ref-state="resolved"');
  });

  it('legacy row with partial metadata (subtype + task_number + task_status) renders degraded chip + pill', () => {
    // Pre-PR-2 task system message — only subtype + task_number + task_status
    // in metadata. Renderer must NOT throw on Zod (full) failure; mid-tier
    // degraded fallback surfaces a chip + status pill so the audit entry
    // is still self-identifying without re-parsing content.
    const msg = makeSystemMessage(
      'task_create',
      { task_number: 9, task_status: 'todo' },
      '@alice created task #9 "old format"',
    );
    const html = renderTaskEvent(msg, () => undefined);
    expect(html).toContain('data-task-event-degraded="1"');
    expect(html).toContain('data-task-event-dot="todo"');
    expect(html).toContain('#task:9');
    expect(html).toContain('created');
    // Title not in legacy metadata → chip has no inline title.
    expect(html).not.toContain('old format');
    expect(html).not.toContain('data-task-event-legacy');
  });

  it('legacy task_status row renders chip → pill in degraded form (no by-actor)', () => {
    const msg = makeSystemMessage('task_status', {
      task_number: 12,
      task_status: 'in_review',
    });
    const html = renderTaskEvent(msg, () => undefined);
    expect(html).toContain('data-task-event-degraded="1"');
    expect(html).toContain('data-task-event-status="in_review"');
    expect(html).toContain('#task:12');
    expect(html).not.toContain('by @');
  });

  it('legacy task_unclaim still uses dashed dot in degraded form', () => {
    const msg = makeSystemMessage('task_unclaim', {
      task_number: 4,
      task_status: 'todo',
    });
    const html = renderTaskEvent(msg, () => undefined);
    expect(html).toContain('data-task-event-degraded="1"');
    expect(html).toContain('data-task-event-dot="unclaim"');
    expect(html).toContain('unclaimed');
  });

  it('total fallback (metadata missing even task_number) → muted narration', () => {
    // Belt+suspenders: metadata so malformed even the partial schema
    // can't parse it. Renderer drops to italic-content narration.
    const msg = makeSystemMessage(
      'task_create',
      {
        // Force a schema mismatch — task_status omitted entirely.
      },
      'broken task row content',
    );
    const html = renderTaskEvent(msg, () => undefined);
    expect(html).toContain('data-task-event-legacy="1"');
    expect(html).toContain('italic');
    expect(html).toContain('broken task row content');
    expect(html).not.toContain('data-task-event-degraded');
  });

  it('PR-8: every system message renders inside `.system-message-row` so theme prose font/size cascade', () => {
    // Drift guard: the SystemMessage entry wraps every per-subtype
    // renderer in `<div class="system-message-row">`. global.css attaches
    // `font-family: var(--md-prose-font, ...)` + `font-size:
    // var(--md-prose-size, ...)` to that class so plain-text system rows
    // (task events, schedule banners, rename chips) follow the theme's
    // chosen prose font alongside Markdown bodies. Removing this wrapper
    // would silently strip system rows out of the theme font cascade.
    const enriched = makeSystemMessage('task_create', fullMeta({}));
    const enrichedHtml = renderTaskEvent(enriched, () => undefined, [seededTask()]);
    expect(enrichedHtml).toMatch(/^<div class="system-message-row" data-system-event-row="1">/);

    const legacy = makeSystemMessage(
      'task_create',
      { task_number: 9, task_status: 'todo' },
      '@alice created task #9',
    );
    const legacyHtml = renderTaskEvent(legacy, () => undefined);
    expect(legacyHtml).toMatch(/^<div class="system-message-row" data-system-event-row="1">/);
  });

  it('PR-8 follow-up: TaskStatusPill keeps leading-none + drops py-0.5; both pill and chip get height from `.system-message-row` scoped CSS (no inline h-[18px])', () => {
    // shiki PR-8 feedback: chip + pill ended up on visually different
    // baselines because pill had `py-0.5` (~20px outer) while chip
    // rendered at the row's natural inline-flex height (~16px).
    //
    // Cindy PR-8 review #2 (msg `0PEPg70b84bxYrlK`): locking `h-[18px]`
    // directly on TaskRef would (a) crop the chip when the user picks
    // a larger theme prose size and (b) leak into Markdown inline
    // `#task:N` chips that have no pill sibling.
    //
    // Cindy PR-8 follow-up review #3 (msg `VOGiR_K30xhSOswD`): a fixed
    // `h-[18px]` on the pill (or a fixed `height: 18px` CSS rule on
    // the chip) crops at large prose sizes too — the chrome must
    // grow with the prose size. Fix: both chip and pill get their
    // height from `.system-message-row { --system-message-control-height:
    // max(18px, calc(var(--md-prose-size, 12px) * 1.5)) }` applied via
    // attribute selectors. SSR can't resolve CSS variables, so this
    // test instead asserts the inline classes are absent — the
    // CSS-var path is what locks heights together.
    const msg = makeSystemMessage(
      'task_status',
      fullMeta({ task_status: 'in_review' }),
    );
    const html = renderTaskEvent(msg, () => undefined, [
      seededTask({ status: 'in_review' }),
    ]);
    // Pill keeps `leading-none` so the [10px] text stays vertically
    // centered inside the CSS-var-driven height regardless of the row's
    // 1.5 line-height.
    expect(html).toMatch(
      /data-task-event-status="in_review"[^>]*class="[^"]*leading-none[^"]*"|class="[^"]*leading-none[^"]*"[^>]*data-task-event-status="in_review"/,
    );
    // Pill must NOT carry py-0.5 anymore (would re-introduce the
    // height mismatch by adding extra vertical padding on top of the
    // CSS-var height).
    expect(html).not.toMatch(
      /data-task-event-status="in_review"[^>]*class="[^"]*py-0\.5/,
    );
    // Pill must NOT carry inline `h-[18px]` either — height is
    // CSS-var-driven via `.system-message-row [data-task-event-status]`
    // so chip + pill grow together at large prose sizes.
    expect(html).not.toMatch(
      /data-task-event-status="in_review"[^>]*class="[^"]*h-\[18px\]/,
    );
    // TaskRef chip likewise must NOT carry inline `h-[18px]` — the
    // height alignment lives in CSS scoped to `.system-message-row` so
    // (a) the markup stays small, (b) Markdown inline `#task:N` chips
    // (outside system rows) keep flowing with surrounding text size,
    // and (c) chip + pill share the same theme-aware height token.
    expect(html).not.toMatch(/data-task-ref="42"[^>]*class="[^"]*h-\[18px\]/);
    // The chip + pill must still be wrapped in `.system-message-row`
    // so the scoped CSS rule applies. PR-10 added `data-system-event-row="1"`
    // to the same wrapper so cluster CSS can hook to it; both the
    // class and the data attribute must be present in the prefix.
    expect(html).toMatch(/^<div class="system-message-row" data-system-event-row="1">/);
  });

  it('PR-8 follow-up: body containers no longer carry `text-xs`/`text-sm` so theme prose size cascades from `.system-message-row`', () => {
    // Cindy PR-8 review #1: the wrapper class set `font-size:
    // var(--md-prose-size)` but children with `text-xs` / `text-sm`
    // Tailwind utilities won via specificity, so a customized prose
    // size never reached the body text. Drift guard: the task event
    // row outer container (the body text wrapper, not chrome chips) is
    // free of those Tailwind size utilities. Chrome elements that
    // explicitly set `text-[10px]` / `text-[11px]` (status pill, mono
    // timestamp) are intentionally fixed and remain.
    const enriched = makeSystemMessage('task_create', fullMeta({}));
    const enrichedHtml = renderTaskEvent(enriched, () => undefined, [seededTask()]);
    // Outer body row of TaskEventRowEnriched — must NOT carry text-xs
    // (would override inherited `--md-prose-size`).
    expect(enrichedHtml).toMatch(
      /<div class="flex items-center gap-2\.5 px-4 py-1\.5 text-text-secondary"/,
    );
    expect(enrichedHtml).not.toMatch(
      /<div class="flex items-center gap-2\.5 px-4 py-1\.5 text-xs/,
    );

    const legacy = makeSystemMessage(
      'task_create',
      { task_number: 9, task_status: 'todo' },
      '@alice created task #9',
    );
    const legacyHtml = renderTaskEvent(legacy, () => undefined);
    // Same drift guard for the degraded row.
    expect(legacyHtml).not.toMatch(
      /<div class="flex items-center gap-2\.5 px-4 py-1\.5 text-xs/,
    );
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
