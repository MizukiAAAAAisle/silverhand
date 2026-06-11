import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessageDto, TaskSummaryDto } from '@silverhand/shared';
import { SystemActivityCluster } from './SystemActivityCluster';
import { TaskRefContextProvider } from '@/features/tasks/TaskRefContext';
import { taskByNumberKey } from '@/features/tasks/useTaskByNumber';

/** Minimal MessageDto factory — same shape as Markdown.test's helper,
 *  duplicated locally so the cluster tests don't reach into another
 *  test file's private helpers. */
function makeSystemMessage(
  subtype: string,
  metadata: Record<string, unknown>,
  overrides: Partial<MessageDto> = {},
): MessageDto {
  return {
    id: 'sys-cluster-1',
    conversation_id: 'conv-1',
    from_kind: 'system',
    from_agent_id: null,
    from_user_id: null,
    content: '',
    metadata: { subtype, ...metadata },
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
    ...overrides,
  };
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
    closed_at: null,
    ...overrides,
  };
}

function renderCluster(messages: MessageDto[], seededTasks: TaskSummaryDto[] = []): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
          { value: { workspaceId: 'ws-1', onOpenTask: () => undefined } },
          React.createElement(SystemActivityCluster, {
            messages,
            channelsByName: new Map(),
            onOpenChannelRef: () => undefined,
          }),
        ),
      ),
    ),
  );
}

const fullTaskMeta = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  task_number: 42,
  task_status: 'todo',
  task_message_id: 'msg-task-42',
  task_title: 'wire registry',
  task_assignee: null,
  actor: { kind: 'agent', id: 'a-alice', name: 'Alice' },
  ...overrides,
});

describe('SystemActivityCluster (PR-10)', () => {
  it('wraps the run in `.system-activity-cluster` and exposes the row count via data attribute', () => {
    const a = makeSystemMessage('task_create', fullTaskMeta(), { id: 'a' });
    const b = makeSystemMessage(
      'task_status',
      fullTaskMeta({ task_status: 'in_review' }),
      { id: 'b' },
    );
    const html = renderCluster([a, b], [seededTask({ status: 'in_review' })]);
    // The cluster's outermost element is `.system-activity-cluster`.
    expect(html).toMatch(/^<div class="system-activity-cluster" data-system-activity-cluster="2">/);
  });

  it('renders one inner `.system-message-row` per cluster member, each tagged with `data-system-event-row="1"`', () => {
    // Drift guard: SystemActivityCluster delegates per-row rendering to
    // SystemMessage. The cluster CSS in `global.css` uses
    // `.system-activity-cluster [data-system-event-row="1"] > *` to
    // override the row body's chunky padding. If the SystemMessage
    // wrapper ever drops the `data-system-event-row` attribute (or the
    // class), the cluster CSS hook would silently break — the rows
    // would still render, just no longer in tight 2px stacking.
    const a = makeSystemMessage('task_claim', fullTaskMeta(), { id: 'a' });
    const b = makeSystemMessage(
      'task_status',
      fullTaskMeta({ task_status: 'in_review' }),
      { id: 'b' },
    );
    const c = makeSystemMessage('rename', { old_name: 'v2', new_name: 'v3' }, { id: 'c' });
    const html = renderCluster([a, b, c], [seededTask()]);
    // Three rows → three system-message-row wrappers, each with the
    // PR-10 data attribute.
    const matches = html.match(/<div class="system-message-row" data-system-event-row="1">/g) ?? [];
    expect(matches).toHaveLength(3);
  });

  it('mixes task event + session_cleared + rename rows in the same cluster (no subtype gating in renderer)', () => {
    // The grouping decision (which subtypes participate in clusters)
    // lives in `groupMessages.ts`. The renderer accepts whatever the
    // grouping pass put in and faithfully renders each subtype using
    // its standalone SystemMessage renderer. This test pins that
    // contract: the renderer doesn't second-guess grouping.
    const a = makeSystemMessage('task_claim', fullTaskMeta(), { id: 'a' });
    const b = makeSystemMessage(
      'session_cleared',
      {
        agent_id: 'a-bob',
        agent_name: 'Bob',
        actor_user_id: 'local',
        previous_cli_session_id_prefix: 'fbe21c8a',
        was_running: true,
      },
      { id: 'b' },
    );
    const c = makeSystemMessage(
      'rename',
      { old_name: 'version2', new_name: 'version3' },
      { id: 'c' },
    );
    const html = renderCluster([a, b, c], [seededTask()]);
    // task event signal
    expect(html).toContain('data-task-event-dot');
    expect(html).toContain('data-task-ref="42"');
    // session_cleared signal
    expect(html).toContain('data-session-cleared="1"');
    expect(html).toContain('lucide-rotate-ccw');
    // rename signal
    expect(html).toContain('data-rename-row="1"');
    expect(html).toContain('lucide-rotate-cw');
  });

  it('a 1-element cluster still uses the cluster wrapper (so even a lone audit row visually demotes)', () => {
    // Even a stray task event between two real messages should drop
    // below real-message visual weight. The grouping pass produces a
    // 1-element cluster for it; the renderer must not optimize that
    // away into a bare `<SystemMessage>` (which would re-attach the
    // standalone chunky `px-4 py-1.5` padding).
    const only = makeSystemMessage('task_claim', fullTaskMeta(), { id: 'only' });
    const html = renderCluster([only], [seededTask()]);
    expect(html).toMatch(/^<div class="system-activity-cluster" data-system-activity-cluster="1">/);
    expect(html).toContain('<div class="system-message-row" data-system-event-row="1">');
  });
});
