import { describe, expect, it } from 'vitest';
import {
  applyContainerSwitch,
  applyWorkspaceCascade,
  containerScope,
  DEFAULT_TASK_FILTERS,
  personFilterKey,
  taskFiltersEqual,
  type ContainerMembership,
  type TaskBoardContainerAxis,
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
 * The four-state container axis (#task:2041) as ONE falsifiable matrix: the
 * per-container OPTION DOMAIN (`containerScope`) and the container TRANSITION
 * (`applyContainerSwitch`) are the two faces of one model, so they are proven
 * together over the same fixture — not as separate "controls" and "params"
 * proofs. The fixture mixes both container kinds so every arm of the domain and
 * every drop rule of the transition is exercised.
 *
 *   workspaces: ws-reg (regular → `workspace`), ws-home (dm → `agent_space`)
 *   channels:   c-reg  (workspace group), c-agent (dm group)
 *   directPair: dp-1   (a viewer direct line → `direct_messages`)
 */
describe('container axis model (#task:2041)', () => {
  const workspaceOptions = [
    { id: 'ws-reg', kind: 'regular' as const },
    { id: 'ws-home', kind: 'dm' as const },
  ];
  const channelOptions = [
    { id: 'c-reg', group: 'workspace' as const },
    { id: 'c-agent', group: 'dm' as const },
  ];
  const directPairOptions = [{ id: 'dp-1' }];
  const source = { workspaceOptions, channelOptions, directPairOptions };

  const membership: ContainerMembership = {
    workspaceContainer: id =>
      id === 'ws-reg' ? 'workspace' : id === 'ws-home' ? 'agent_space' : null,
    channelContainer: id =>
      id === 'c-reg'
        ? 'workspace'
        : id === 'c-agent'
          ? 'agent_space'
          : id === 'dp-1'
            ? 'direct_messages'
            : null,
  };

  describe('containerScope — per-container option domain', () => {
    it('All (null): full union of ws + channels, no DM leaf', () => {
      const s = containerScope(null, source);
      expect(s).toMatchObject({
        showWorkspace: true,
        showChannel: true,
        showDirectPair: false,
      });
      expect(s.workspaceOptions.map(o => o.id)).toEqual(['ws-reg', 'ws-home']);
      expect(s.channelOptions.map(o => o.id)).toEqual(['c-reg', 'c-agent']);
      expect(s.directPairOptions).toEqual([]);
    });

    it('workspace: only regular ws + workspace-group channels', () => {
      const s = containerScope('workspace', source);
      expect(s).toMatchObject({
        showWorkspace: true,
        showChannel: true,
        showDirectPair: false,
      });
      expect(s.workspaceOptions.map(o => o.id)).toEqual(['ws-reg']);
      expect(s.channelOptions.map(o => o.id)).toEqual(['c-reg']);
    });

    it('agent_space: only dm ws (agent homes) + dm-group channels', () => {
      const s = containerScope('agent_space', source);
      expect(s.workspaceOptions.map(o => o.id)).toEqual(['ws-home']);
      expect(s.channelOptions.map(o => o.id)).toEqual(['c-agent']);
      expect(s.showDirectPair).toBe(false);
    });

    it('direct_messages: ws/channel HIDDEN (not fed empty), DM leaf shown', () => {
      const s = containerScope('direct_messages', source);
      // Hidden, not an empty option set: an empty channel list would read as
      // "no channels", a different (false) claim than "this axis does not apply".
      expect(s).toMatchObject({
        showWorkspace: false,
        showChannel: false,
        showDirectPair: true,
      });
      expect(s.workspaceOptions).toEqual([]);
      expect(s.channelOptions).toEqual([]);
      expect(s.directPairOptions.map(o => o.id)).toEqual(['dp-1']);
    });
  });

  describe('applyContainerSwitch — transition drops coordinates the target cannot hold', () => {
    const on = (
      container: TaskBoardContainerAxis | null,
      coords: Partial<Pick<TaskFilters, 'workspaceId' | 'channelId'>>,
    ): TaskFilters => ({ ...DEFAULT_TASK_FILTERS, container, ...coords });

    it('workspace → agent_space drops a regular-ws + workspace-channel selection', () => {
      const after = applyContainerSwitch(
        on('workspace', { workspaceId: 'ws-reg', channelId: 'c-reg' }),
        'agent_space',
        membership,
      );
      expect(after).toMatchObject({
        container: 'agent_space',
        workspaceId: null,
        channelId: null,
      });
    });

    it('agent_space → workspace keeps nothing agent-scoped', () => {
      const after = applyContainerSwitch(
        on('agent_space', { workspaceId: 'ws-home', channelId: 'c-agent' }),
        'workspace',
        membership,
      );
      expect(after).toMatchObject({ workspaceId: null, channelId: null });
    });

    it('→ direct_messages drops every ws/channel coordinate (a DM holds none)', () => {
      const after = applyContainerSwitch(
        on('workspace', { workspaceId: 'ws-reg', channelId: 'c-reg' }),
        'direct_messages',
        membership,
      );
      expect(after).toMatchObject({
        container: 'direct_messages',
        workspaceId: null,
        channelId: null,
      });
    });

    it('direct_messages → All DROPS the pair — All renders no control to show or clear it', () => {
      const after = applyContainerSwitch(
        on('direct_messages', { channelId: 'dp-1' }),
        null,
        membership,
      );
      // All holds a DirectPair semantically, but its UI has no control for one:
      // the channel picker lists workspace/agent_space channels and the DM leaf is
      // hidden (`containerScope(null).showDirectPair === false`). Keeping dp-1 would
      // show "All" while the request still carried `channel_id=dp-1` — an invisible
      // narrowing the user can neither see nor clear. So it is dropped.
      expect(containerScope(null, source).showDirectPair).toBe(false);
      expect(after).toMatchObject({ container: null, channelId: null });
    });

    it('→ All keeps a workspace/channel coordinate — All still renders those controls', () => {
      const after = applyContainerSwitch(
        on('workspace', { workspaceId: 'ws-reg', channelId: 'c-reg' }),
        null,
        membership,
      );
      // Both coordinates ARE visible+clearable under All (the workspace cascade
      // lists every workspace, the channel picker every workspace/agent_space
      // channel), so retaining them is honest — unlike a DM pair.
      expect(after).toMatchObject({
        container: null,
        workspaceId: 'ws-reg',
        channelId: 'c-reg',
      });
    });

    it('a concrete container KEEPS a coordinate of its own kind', () => {
      const after = applyContainerSwitch(
        on(null, { workspaceId: 'ws-reg', channelId: 'c-reg' }),
        'workspace',
        membership,
      );
      expect(after).toMatchObject({ workspaceId: 'ws-reg', channelId: 'c-reg' });
    });

    it('drops an unresolvable coordinate (membership → null) under EVERY target, All included', () => {
      // A coordinate the option source can no longer classify has no control that
      // shows it as selected anywhere — not under a concrete container, and not
      // under All. It is never retained.
      for (const target of [null, 'workspace', 'agent_space', 'direct_messages'] as const) {
        const after = applyContainerSwitch(
          on(null, { workspaceId: 'ws-gone', channelId: 'c-gone' }),
          target,
          membership,
        );
        expect(after).toMatchObject({ workspaceId: null, channelId: null });
      }
    });
  });
});
