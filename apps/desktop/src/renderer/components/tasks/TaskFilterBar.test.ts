import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  buildChannelFilterOptions,
  TaskFilterBar,
  type ChannelFilterCandidate,
  type ChannelOption,
  type WorkspaceOption,
} from './TaskFilterBar';
import { DEFAULT_TASK_FILTERS } from '@/features/tasks/taskFilters';
import { workspaceChannelCandidates } from '@/features/tasks/useTaskFilterOptions';

function candidate(
  over: Partial<ChannelFilterCandidate> & { id: string },
): ChannelFilterCandidate {
  return {
    workspaceId: 'ws-default',
    title: `title-${over.id}`,
    roster_policy: 'open',
    archived_at: null,
    ...over,
  };
}

describe('buildChannelFilterOptions', () => {
  it('maps a plain channel to a channel option (title is the label)', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1', title: 'General' }),
    ]);
    expect(out).toEqual([
      { id: 'c1', workspaceId: 'ws-default', label: 'General', group: 'workspace' },
    ]);
  });

  it('skips archived channels — this is the drawer leak being fixed', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1' }),
      candidate({ id: 'c2', archived_at: 1700000000000 }),
    ]);
    expect(out.map(o => o.id)).toEqual(['c1']);
  });

  it('dedups by id, first occurrence wins', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1', title: 'First', sublabel: 'ws-a' }),
      candidate({ id: 'c1', title: 'Second', sublabel: 'ws-b' }),
    ]);
    expect(out).toEqual([
      {
        id: 'c1',
        workspaceId: 'ws-default',
        label: 'First',
        group: 'workspace',
        sublabel: 'ws-a',
      },
    ]);
  });

  it('carries the owning workspaceId through for the cascade (#task:1387)', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1', workspaceId: 'ws-eng' }),
      candidate({ id: 'c2', workspaceId: 'ws-design' }),
    ]);
    expect(out.map(o => o.workspaceId)).toEqual(['ws-eng', 'ws-design']);
  });

  it('puts a dm_channel in the dm group', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1', roster_policy: 'fixed' }),
    ]);
    expect(out[0]?.group).toBe('dm');
  });

  it('puts a plain channel inside a dm workspace in the dm group', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'c1', roster_policy: 'open', fromDmWorkspace: true }),
    ]);
    expect(out[0]?.group).toBe('dm');
  });

  it('omits sublabel when none is provided (single-workspace surface)', () => {
    const out = buildChannelFilterOptions([candidate({ id: 'c1' })]);
    expect(out[0]).not.toHaveProperty('sublabel');
  });

  it('preserves input order so a pre-sorted caller keeps its order', () => {
    const out = buildChannelFilterOptions([
      candidate({ id: 'b' }),
      candidate({ id: 'a' }),
      candidate({ id: 'c' }),
    ]);
    expect(out.map(o => o.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('workspaceChannelCandidates — channel picker label/subtitle rule', () => {
  const ch = (id: string, title: string, over: Partial<{ roster_policy: 'open' | 'fixed'; archived_at: number | null }> = {}) => ({
    id,
    title,
    roster_policy: over.roster_policy ?? ('open' as const),
    archived_at: over.archived_at ?? null,
  });

  it('regular channel: title is the label, workspace name is the subtitle', () => {
    const out = workspaceChannelCandidates(
      { id: 'ws-eng', name: 'Engineering', kind: 'regular' },
      [ch('c1', 'general')],
    );
    expect(out[0]).toMatchObject({
      id: 'c1',
      workspaceId: 'ws-eng',
      title: 'general',
      sublabel: 'Engineering',
      fromDmWorkspace: false,
    });
  });

  it("an agent's multiple channels stay distinct: titles differ, subtitle shares the agent name (the #1165 bug)", () => {
    // Alice/Cindy/Norman each own `Mentions` + `Onboarding`; before the fix
    // both rendered as the same `Alice` label. Now the channel title is the
    // label, the agent name the subtitle — so the rows are distinguishable.
    const out = workspaceChannelCandidates({ id: 'ws-alice', name: 'dm-Alice', kind: 'dm' }, [
      ch('c1', 'Mentions', { roster_policy: 'fixed' }),
      ch('c2', 'Onboarding', { roster_policy: 'fixed' }),
    ]);
    expect(out.map(c => c.title)).toEqual(['Mentions', 'Onboarding']);
    expect(out.every(c => c.sublabel === 'Alice')).toBe(true);
    // No two rows collide on (label, subtitle).
    const built = buildChannelFilterOptions(out);
    const keys = built.map(o => `${o.label}::${o.sublabel}`);
    expect(new Set(keys).size).toBe(built.length);
    expect(built.map(o => o.label)).toEqual(['Mentions', 'Onboarding']);
  });

  it('a single-channel agent space still carries the agent-name subtitle', () => {
    const out = workspaceChannelCandidates({ id: 'ws-judy', name: 'dm-Judy', kind: 'dm' }, [
      ch('c1', 'Onboarding', { roster_policy: 'fixed' }),
    ]);
    expect(out[0]).toMatchObject({ title: 'Onboarding', sublabel: 'Judy' });
  });
});

describe('TaskFilterBar — trigger glyphs stay height-uniform (#task:1437)', () => {
  const workspaceOptions: WorkspaceOption[] = [
    { id: 'ws-1', label: 'Engineering', kind: 'regular', dmAgentId: null },
  ];
  const channelOptions: ChannelOption[] = [
    { id: 'c-1', workspaceId: 'ws-1', label: 'general', group: 'workspace' },
  ];

  function renderBar(): string {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(TaskFilterBar, {
          filters: DEFAULT_TASK_FILTERS,
          onChange: () => {},
          baselineFilters: DEFAULT_TASK_FILTERS,
          workspaceOptions,
          channelOptions,
          allChannelsLabel: 'All channels',
          people: {
            known: true,
            value: { assignees: [], creators: [], hasUnassigned: false },
          },
        }),
      ),
    );
  }

  it('channel trigger uses the sticker `#` identity hook (#task:1441)', () => {
    // #task:1437 originally kept the channel trigger on the UTILITY `#` (no
    // `data-channel-icon` hook) so the forza6 sticker recipe couldn't inflate
    // it past its 14px siblings. #task:1441 SUPERSEDES that: now that the
    // forza6 `#` sticker is FLAT at rest (no drop-shadow), shiki wants the
    // selected-label `#` to carry the same yellow poster identity as the
    // dropdown rows + the rest of the app — so the trigger DOES wear the hook.
    // (The slight forza6 border/padding inflation is CSS-only, out of SSR
    // scope, and an accepted trade-off for identity consistency.)
    const html = renderBar();
    expect(html).toContain('aria-label="Channel"');
    expect(html).toContain('data-channel-icon');
  });
});
