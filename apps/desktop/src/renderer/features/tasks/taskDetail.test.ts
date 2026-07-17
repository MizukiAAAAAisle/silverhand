import { describe, expect, it } from 'vitest';
import type { TaskDetailDto, TaskSummaryDto } from '@silverhand/shared';
import {
  buildTaskEditPayload,
  drawerShouldCloseOnEscape,
  resolveTaskJumpTarget,
} from './taskDetail';

function summary(overrides: Partial<TaskSummaryDto> = {}): TaskSummaryDto {
  return {
    id: 'task-1',
    task_number: 7,
    workspace_id: 'ws1',
    workspace_name: 'ws',
    channel_id: 'anchor-chan',
    channel_name: 'chan',
    thread_root_id: null,
    conversation: { id: 'anchor-chan', title: 'chan' },
    status: 'todo',
    title: 'a task',
    assignee: null,
    creator: { type: 'user', id: 'u1', name: 'Shiki' },
    created_at: 1000,
    closed_at: null,
    ...overrides,
  };
}

function detail(overrides: Partial<TaskDetailDto> = {}): TaskDetailDto {
  return {
    ...summary(),
    content: 'body',
    last_editor: null,
    last_edited_at: null,
    source_message_id: 'src-msg',
    nav: { kind: 'unavailable' },
    ...overrides,
  };
}

describe('resolveTaskJumpTarget', () => {
  it('navigates to the source ref when nav.kind is "source"', () => {
    const d = detail({
      nav: {
        kind: 'source',
        ref: {
          channel_id: 'src-chan',
          thread_root_id: 'src-thread',
          message_id: 'src-msg',
        },
      },
    });
    expect(resolveTaskJumpTarget(d)).toEqual({
      workspaceId: 'ws1',
      channelId: 'src-chan',
      threadRootId: 'src-thread',
      messageId: 'src-msg',
    });
  });

  it('navigates to the created-event ref when nav.kind is "created_event"', () => {
    const d = detail({
      source_message_id: null,
      nav: {
        kind: 'created_event',
        ref: {
          channel_id: 'evt-chan',
          thread_root_id: null,
          message_id: 'evt-msg',
        },
      },
    });
    expect(resolveTaskJumpTarget(d)).toEqual({
      workspaceId: 'ws1',
      channelId: 'evt-chan',
      threadRootId: null,
      messageId: 'evt-msg',
    });
  });

  it('returns null when nav.kind is "unavailable" (caller hides the affordance)', () => {
    const d = detail({ nav: { kind: 'unavailable' } });
    expect(resolveTaskJumpTarget(d)).toBeNull();
  });
});

describe('drawerShouldCloseOnEscape', () => {
  it('closes the drawer when no detail modal is open', () => {
    expect(drawerShouldCloseOnEscape(false)).toBe(true);
  });

  it('defers (does NOT close the drawer) while a detail modal is open', () => {
    // Escape belongs to the top layer: the modal closes, the drawer stays.
    expect(drawerShouldCloseOnEscape(true)).toBe(false);
  });
});

describe('buildTaskEditPayload', () => {
  const base = { title: 'Original', content: 'Original body' };

  it('sends nothing when neither field changed', () => {
    expect(
      buildTaskEditPayload(base, { title: 'Original', body: 'Original body' }),
    ).toEqual({});
  });

  it('omits an unchanged title on a body-only edit (legacy fallback stays independent)', () => {
    // A legacy null-title task shows firstLine(content) as `base.title`.
    // Editing only the body must NOT echo that fallback back as an explicit
    // title — the backend materializes it independently.
    expect(
      buildTaskEditPayload(base, { title: 'Original', body: 'New body' }),
    ).toEqual({ body: 'New body' });
  });

  it('sends only the trimmed title on a title-only edit', () => {
    expect(
      buildTaskEditPayload(base, { title: '  Renamed  ', body: 'Original body' }),
    ).toEqual({ title: 'Renamed' });
  });

  it('sends both fields when both changed', () => {
    expect(
      buildTaskEditPayload(base, { title: 'Renamed', body: 'New body' }),
    ).toEqual({ title: 'Renamed', body: 'New body' });
  });
});
