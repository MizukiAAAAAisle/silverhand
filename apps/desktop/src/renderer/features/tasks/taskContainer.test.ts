import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_FILTERS } from '@/features/tasks/taskFilters';
import {
  taskContainerBaseline,
  taskContainerForPosition,
  taskContainerKey,
  taskContainerLabel,
} from '@/features/tasks/taskContainer';

const pair = { conversationId: 'c-pair', label: 'Cindy' };
const ws = { id: 'ws-1', name: 'silverhand' };

describe('taskContainerForPosition', () => {
  it('is the pair when a direct line is open', () => {
    expect(
      taskContainerForPosition({
        directPair: pair,
        workspace: null,
        conversationId: 'c-pair',
      }),
    ).toEqual({ kind: 'direct_pair', conversationId: 'c-pair', label: 'Cindy' });
  });

  it('is the pair even with a workspace still selected in app state', () => {
    // The bug this seam replaces: a pair route carries no workspace, so a
    // workspace left over from the previous selection is NOT this
    // conversation's container. Picking "whichever coordinate is non-null" is
    // how a DM would open a channel's board.
    expect(
      taskContainerForPosition({
        directPair: pair,
        workspace: ws,
        conversationId: 'c-pair',
      }),
    ).toEqual({ kind: 'direct_pair', conversationId: 'c-pair', label: 'Cindy' });
  });

  it('is the workspace + channel when a channel is open', () => {
    expect(
      taskContainerForPosition({
        directPair: null,
        workspace: ws,
        conversationId: 'c-chan',
      }),
    ).toEqual({
      kind: 'workspace_channel',
      workspaceId: 'ws-1',
      workspaceName: 'silverhand',
      conversationId: 'c-chan',
    });
  });

  it('is still the workspace with no channel selected', () => {
    // A missing channel is a narrowing question, not a missing container —
    // Activity's bare state must not lose the board.
    expect(
      taskContainerForPosition({
        directPair: null,
        workspace: ws,
        conversationId: null,
      }),
    ).toEqual({
      kind: 'workspace_channel',
      workspaceId: 'ws-1',
      workspaceName: 'silverhand',
      conversationId: null,
    });
  });

  it('carries an unresolved workspace name without invalidating the container', () => {
    const container = taskContainerForPosition({
      directPair: null,
      workspace: { id: 'ws-1', name: null },
      conversationId: 'c-chan',
    });
    expect(container).toEqual({
      kind: 'workspace_channel',
      workspaceId: 'ws-1',
      workspaceName: null,
      conversationId: 'c-chan',
    });
  });

  it('is null where there is no container at all', () => {
    // Bare /chat, a pre-mint draft, the non-conversation rails: no entry, and
    // nothing invented to give one.
    expect(
      taskContainerForPosition({
        directPair: null,
        workspace: null,
        conversationId: null,
      }),
    ).toBeNull();
  });
});

describe('taskContainerBaseline', () => {
  it('narrows a pair on the conversation axis alone, on the direct_messages container', () => {
    // No workspace coordinate is minted: `t.workspace_id = ?` never matches the
    // NULL a DM task carries, so a claimed workspace would exclude the very
    // tasks the board opened for. The `direct_messages` container axis is set so
    // the drawer opens on the DM 对端 leaf (this pair selected) rather than
    // showing the workspace/channel controls under an orphan channelId
    // (#task:2041).
    expect(
      taskContainerBaseline({
        kind: 'direct_pair',
        conversationId: 'c-pair',
        label: 'Cindy',
      }),
    ).toEqual({
      ...DEFAULT_TASK_FILTERS,
      container: 'direct_messages',
      channelId: 'c-pair',
    });
  });

  it('narrows a channel on workspace + conversation', () => {
    expect(
      taskContainerBaseline({
        kind: 'workspace_channel',
        workspaceId: 'ws-1',
        workspaceName: 'silverhand',
        conversationId: 'c-chan',
      }),
    ).toEqual({
      ...DEFAULT_TASK_FILTERS,
      workspaceId: 'ws-1',
      channelId: 'c-chan',
    });
  });

  it('keeps the workspace when no channel is focused', () => {
    expect(
      taskContainerBaseline({
        kind: 'workspace_channel',
        workspaceId: 'ws-1',
        workspaceName: null,
        conversationId: null,
      }),
    ).toEqual({ ...DEFAULT_TASK_FILTERS, workspaceId: 'ws-1', channelId: null });
  });
});

describe('taskContainerKey', () => {
  const position = {
    directPair: null,
    workspace: ws,
    conversationId: 'c-chan',
  };

  it('is equal for two assemblies of the same facts', () => {
    // The point of the key: a carrier refetch hands over fresh objects, and the
    // drawer's baseline must not re-apply (discarding the viewer's filters) just
    // because a list was re-read.
    const a = taskContainerForPosition(position)!;
    const b = taskContainerForPosition({ ...position, workspace: { ...ws } })!;
    expect(a).not.toBe(b);
    expect(taskContainerKey(a)).toBe(taskContainerKey(b));
  });

  it('changes when the focused channel changes', () => {
    expect(
      taskContainerKey(taskContainerForPosition(position)!),
    ).not.toBe(
      taskContainerKey(
        taskContainerForPosition({ ...position, conversationId: 'c-other' })!,
      ),
    );
  });

  it('changes when the presented label changes', () => {
    // The label is what the header prints, so a rename IS a change.
    expect(
      taskContainerKey({
        kind: 'direct_pair',
        conversationId: 'c-pair',
        label: 'Cindy',
      }),
    ).not.toBe(
      taskContainerKey({
        kind: 'direct_pair',
        conversationId: 'c-pair',
        label: 'Cindy (deleted)',
      }),
    );
  });

  it('never collides across the two arms on the same conversation id', () => {
    expect(
      taskContainerKey({
        kind: 'direct_pair',
        conversationId: 'c-x',
        label: 'x',
      }),
    ).not.toBe(
      taskContainerKey({
        kind: 'workspace_channel',
        workspaceId: 'c-x',
        workspaceName: 'x',
        conversationId: null,
      }),
    );
  });
});

describe('taskContainerLabel', () => {
  it('is the counterpart for a pair', () => {
    expect(
      taskContainerLabel({
        kind: 'direct_pair',
        conversationId: 'c-pair',
        label: 'Cindy',
      }),
    ).toBe('Cindy');
  });

  it('is the workspace name for a channel', () => {
    expect(
      taskContainerLabel({
        kind: 'workspace_channel',
        workspaceId: 'ws-1',
        workspaceName: 'silverhand',
        conversationId: 'c-chan',
      }),
    ).toBe('silverhand');
  });

  it('is null while the workspace name has not resolved', () => {
    // The header then reads plain "Tasks" rather than "Tasks ·" with nothing
    // after the separator.
    expect(
      taskContainerLabel({
        kind: 'workspace_channel',
        workspaceId: 'ws-1',
        workspaceName: null,
        conversationId: null,
      }),
    ).toBeNull();
  });
});
