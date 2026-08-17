import { describe, expect, it } from 'vitest';
import {
  applyBoardScopeSelection,
  applyWorkspaceCascade,
  boardScopeGroups,
  channelAxisScope,
  DEFAULT_TASK_FILTERS,
  personFilterKey,
  taskFiltersEqual,
  type BoardScopeSelection,
  type TaskFilters,
} from './taskFilters';

describe('personFilterKey', () => {
  // The collision property the whole person axis rests on. It used to be
  // asserted through `applyTaskFilters`, which was retired with the fetch-all
  // list (#task:1892) — the property is not: agent and user ids share no
  // namespace guarantee, so a key built from the id ALONE would make an agent
  // and a user with the same id one selection here, in `taskFiltersEqual`, and
  // in the wire params derived from them.
  it('keys a person by {type,id} so agent/user ids do not collide', () => {
    expect(personFilterKey({ kind: 'person', person: { type: 'agent', id: 'shared' } })).not.toBe(
      personFilterKey({ kind: 'person', person: { type: 'user', id: 'shared' } }),
    );
  });

  it('gives the two non-person values their own keys', () => {
    expect(personFilterKey({ kind: 'any' })).toBe('any');
    expect(personFilterKey({ kind: 'unassigned' })).toBe('unassigned');
  });
});

describe('taskFiltersEqual (Clear / baseline comparison)', () => {
  it('treats a drawer baseline (current channel) as equal to itself', () => {
    const baseline: TaskFilters = { ...DEFAULT_TASK_FILTERS, channelId: 'ch1' };
    // drawer 初始 = baseline → 不应显示 Clear
    expect(taskFiltersEqual(baseline, baseline)).toBe(true);
    // 切到别的 channel → 与 baseline 不同
    expect(taskFiltersEqual(baseline, { ...baseline, channelId: 'ch2' })).toBe(false);
    // 切到 All → 与 baseline 不同（Clear 会回到 baseline 的 current channel）
    expect(taskFiltersEqual(baseline, { ...baseline, channelId: null })).toBe(false);
  });

  it('compares person filters by value', () => {
    expect(
      taskFiltersEqual(DEFAULT_TASK_FILTERS, {
        ...DEFAULT_TASK_FILTERS,
        assignee: { kind: 'person', person: { type: 'agent', id: 'a' } },
      }),
    ).toBe(false);
  });

  it('distinguishes the workspace dimension', () => {
    expect(
      taskFiltersEqual(DEFAULT_TASK_FILTERS, {
        ...DEFAULT_TASK_FILTERS,
        workspaceId: 'ws1',
      }),
    ).toBe(false);
  });
});

describe('applyWorkspaceCascade (#task:1387 workspace→channel)', () => {
  // channel c-eng belongs to ws-eng; c-design belongs to ws-design.
  const channelWorkspaceId = (id: string): string | null =>
    ({ 'c-eng': 'ws-eng', 'c-design': 'ws-design' })[id] ?? null;

  it('selecting a workspace drops a channel that belongs to another workspace', () => {
    const before: TaskFilters = {
      ...DEFAULT_TASK_FILTERS,
      workspaceId: null,
      channelId: 'c-design',
    };
    const after = applyWorkspaceCascade(before, 'ws-eng', channelWorkspaceId);
    expect(after.workspaceId).toBe('ws-eng');
    expect(after.channelId).toBeNull(); // orphan channel cleared
  });

  it('keeps a channel that belongs to the newly selected workspace', () => {
    const before: TaskFilters = {
      ...DEFAULT_TASK_FILTERS,
      channelId: 'c-eng',
    };
    const after = applyWorkspaceCascade(before, 'ws-eng', channelWorkspaceId);
    expect(after).toMatchObject({ workspaceId: 'ws-eng', channelId: 'c-eng' });
  });

  it('selecting "All workspaces" keeps any channel (channel filter unconstrained)', () => {
    const before: TaskFilters = {
      ...DEFAULT_TASK_FILTERS,
      workspaceId: 'ws-eng',
      channelId: 'c-eng',
    };
    const after = applyWorkspaceCascade(before, null, channelWorkspaceId);
    expect(after).toMatchObject({ workspaceId: null, channelId: 'c-eng' });
  });

  it('preserves the non-cascaded dimensions (assignee / creator)', () => {
    const before: TaskFilters = {
      ...DEFAULT_TASK_FILTERS,
      channelId: 'c-design',
      assignee: { kind: 'person', person: { type: 'agent', id: 'a1' } },
    };
    const after = applyWorkspaceCascade(before, 'ws-eng', channelWorkspaceId);
    expect(after.assignee).toEqual(before.assignee);
  });
});

/**
 * The container axis (#task:2041) as ONE falsifiable matrix: the channel axis
 * (`channelAxisScope`) and the board-scope SELECTION (`applyBoardScopeSelection`)
 * are the two faces of one model, proven together over the same fixture.
 * Selection collapses the old pick-container-then-object two-step into one
 * grouped-dropdown choice (shiki 2026-08-17), so every pick lands on a
 * fully-resolved scope and the cascade drops any coordinate the pick leaves
 * stranded.
 *
 *   channels:   c-reg  (workspace group), c-agent (dm group)
 *   workspaces: ws-reg (regular → `workspace`), ws-home (dm → `agent_space`)
 *   directPair: dp-1   (a viewer direct line → `direct_messages`)
 */
describe('container axis model (#task:2041)', () => {
  const channelOptions = [
    { id: 'c-reg', group: 'workspace' as const },
    { id: 'c-agent', group: 'dm' as const },
  ];

  describe('channelAxisScope — the channel picker under a container', () => {
    it('All (null): every channel, picker shown', () => {
      const s = channelAxisScope(null, channelOptions);
      expect(s.show).toBe(true);
      expect(s.channelOptions.map(o => o.id)).toEqual(['c-reg', 'c-agent']);
    });

    it('workspace: only workspace-group channels', () => {
      const s = channelAxisScope('workspace', channelOptions);
      expect(s.show).toBe(true);
      expect(s.channelOptions.map(o => o.id)).toEqual(['c-reg']);
    });

    it('agent_space: only dm-group channels', () => {
      const s = channelAxisScope('agent_space', channelOptions);
      expect(s.show).toBe(true);
      expect(s.channelOptions.map(o => o.id)).toEqual(['c-agent']);
    });

    it('direct_messages: picker HIDDEN (not fed empty), no channels', () => {
      const s = channelAxisScope('direct_messages', channelOptions);
      // Hidden, not an empty option set: an empty channel list would read as
      // "no channels", a different (false) claim than "this axis does not apply".
      expect(s.show).toBe(false);
      expect(s.channelOptions).toEqual([]);
    });
  });

  describe('applyBoardScopeSelection — one pick sets container + coordinate together', () => {
    // c-reg belongs to ws-reg; c-agent to ws-home. Same resolver shape the
    // workspace cascade takes, so a channel/pair id a pick strands is dropped.
    const channelWorkspaceId = (id: string): string | null =>
      ({ 'c-reg': 'ws-reg', 'c-agent': 'ws-home' })[id] ?? null;

    const sel = (
      selection: BoardScopeSelection,
      filters: TaskFilters = DEFAULT_TASK_FILTERS,
    ): TaskFilters => applyBoardScopeSelection(filters, selection, channelWorkspaceId);

    it('All clears the container and every coordinate', () => {
      const before: TaskFilters = {
        ...DEFAULT_TASK_FILTERS,
        container: 'workspace',
        workspaceId: 'ws-reg',
        channelId: 'c-reg',
      };
      expect(sel({ kind: 'all' }, before)).toMatchObject({
        container: null,
        workspaceId: null,
        channelId: null,
      });
    });

    it('a regular workspace pick stamps `workspace` + its id', () => {
      expect(
        sel({ kind: 'workspace', workspaceId: 'ws-reg', container: 'workspace' }),
      ).toMatchObject({ container: 'workspace', workspaceId: 'ws-reg', channelId: null });
    });

    it('an agent-home pick stamps `agent_space` + its id', () => {
      expect(
        sel({ kind: 'workspace', workspaceId: 'ws-home', container: 'agent_space' }),
      ).toMatchObject({ container: 'agent_space', workspaceId: 'ws-home' });
    });

    it('keeps a channel that belongs to the picked workspace (cascade)', () => {
      const before: TaskFilters = { ...DEFAULT_TASK_FILTERS, channelId: 'c-reg' };
      expect(
        sel({ kind: 'workspace', workspaceId: 'ws-reg', container: 'workspace' }, before),
      ).toMatchObject({ container: 'workspace', workspaceId: 'ws-reg', channelId: 'c-reg' });
    });

    it('drops a channel of another workspace when picking a workspace', () => {
      const before: TaskFilters = { ...DEFAULT_TASK_FILTERS, channelId: 'c-agent' };
      expect(
        sel({ kind: 'workspace', workspaceId: 'ws-reg', container: 'workspace' }, before),
      ).toMatchObject({ workspaceId: 'ws-reg', channelId: null });
    });

    it('switching from a DM to a workspace drops the stale pair id in channelId', () => {
      // Under `direct_messages` the pair conversation id lives in `channelId`; it
      // belongs to no workspace, so the cascade clears it rather than carry a dead
      // `channel_id` into a workspace board.
      const before: TaskFilters = {
        ...DEFAULT_TASK_FILTERS,
        container: 'direct_messages',
        channelId: 'dp-1',
      };
      expect(
        sel({ kind: 'workspace', workspaceId: 'ws-reg', container: 'workspace' }, before),
      ).toMatchObject({ container: 'workspace', workspaceId: 'ws-reg', channelId: null });
    });

    it('a direct-pair pick is `direct_messages` with the pair id and no workspace', () => {
      const before: TaskFilters = {
        ...DEFAULT_TASK_FILTERS,
        container: 'workspace',
        workspaceId: 'ws-reg',
        channelId: 'c-reg',
      };
      expect(sel({ kind: 'direct_pair', conversationId: 'dp-1' }, before)).toMatchObject({
        container: 'direct_messages',
        workspaceId: null,
        channelId: 'dp-1',
      });
    });
  });

  describe('boardScopeGroups — the dropdown sections (kind → section, show rule)', () => {
    const workspaces = [
      { id: 'ws-reg', kind: 'regular' as const, label: 'Engineering' },
      { id: 'ws-home', kind: 'dm' as const, label: 'Agent Home' },
    ];
    const pairs = [{ id: 'dp-1', label: 'alice' }];

    it('routes a regular workspace to Workspaces and an agent home to Agent Spaces', () => {
      const groups = boardScopeGroups({ workspaces, directPairs: [], directMessagesNote: null });
      // Order is fixed: Workspaces, then Agent Spaces (Direct Messages hidden — no
      // pairs, no note). The kind→section mapping must not be swapped.
      expect(groups.map(g => g.key)).toEqual(['workspaces', 'agent-spaces']);
      expect(groups.find(g => g.key === 'workspaces')?.workspaces.map(w => w.id)).toEqual(['ws-reg']);
      expect(groups.find(g => g.key === 'agent-spaces')?.workspaces.map(w => w.id)).toEqual([
        'ws-home',
      ]);
    });

    it('lists the pairs under Direct Messages, in order', () => {
      const groups = boardScopeGroups({ workspaces: [], directPairs: pairs, directMessagesNote: null });
      expect(groups.map(g => g.key)).toEqual(['direct-messages']);
      expect(groups.find(g => g.key === 'direct-messages')?.pairs.map(p => p.id)).toEqual(['dp-1']);
    });

    it('shows Direct Messages with its note even when the pair list is empty', () => {
      // A loading/failed read must not vanish — an empty section would read as
      // "no direct lines", a different (false) claim than "still loading".
      const groups = boardScopeGroups({
        workspaces: [],
        directPairs: [],
        directMessagesNote: 'Loading…',
      });
      expect(groups.map(g => g.key)).toEqual(['direct-messages']);
      const dm = groups.find(g => g.key === 'direct-messages');
      expect(dm?.note).toBe('Loading…');
      expect(dm?.pairs).toEqual([]);
    });

    it('drops an answered-empty section (no objects, no note)', () => {
      expect(
        boardScopeGroups({ workspaces: [], directPairs: [], directMessagesNote: null }),
      ).toEqual([]);
    });

    it('keeps all three sections in order when each has content', () => {
      const groups = boardScopeGroups({
        workspaces,
        directPairs: pairs,
        directMessagesNote: null,
      });
      expect(groups.map(g => g.key)).toEqual(['workspaces', 'agent-spaces', 'direct-messages']);
    });
  });
});
