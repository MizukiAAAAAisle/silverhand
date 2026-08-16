/**
 * #task:1145 / #task:1156 — the global Archived recovery index mixes regular
 * channels AND channels from agent spaces. An agent-space row's workspace
 * context must read the AGENT NAME — the same label the filter dropdown and the
 * rail use (label convergence #task:1156; `@<agent>` and the word "DM" now
 * belong to the direct pair, #task:2044) — while every row keeps the same `#`
 * channel glyph (an agent-space channel is channel-like, not a separate icon).
 *
 * The subtle part is that the SAME agent surfaces under two name shapes:
 *   - the `WorkspaceListItem` (filter dropdown) carries a UI `dm-` prefix
 *     (`workspaceToListItem`), e.g. `dm-Norman`;
 *   - the backend archived aggregate (`item.workspace.name`) returns the
 *     bare agent name (`insertAgentHome` sets `name = agent.name`), e.g.
 *     `Norman`.
 * Both must normalize to the identical `Norman` label. The prefix-stripping
 * convergence itself is pinned in `lib/workspace-name.test.ts`; here we pin the
 * archived row's kind → label wiring.
 */
import { describe, expect, it } from 'vitest';
import type { ArchivedChannelListItemDto } from '@silverhand/shared';
import type { WorkspaceListItem } from '@/features/workspaces/hooks';
import {
  archivedRowOpenTarget,
  archivedRowWorkspaceLabel,
  archivedWorkspaceRowLabel,
  archivedWorkspaceRows,
} from './ArchivedChannelsPanel';

describe('archivedRowWorkspaceLabel — kind drives the context label', () => {
  const baseChannel = {
    id: 'c1',
    workspace_id: 'w1',
    title: 'general',
    closed_at: null,
    archived_at: 1_000,
  };

  it('regular `channel` row shows the raw workspace name unchanged', () => {
    const item = {
      channel: { ...baseChannel, placement_kind: 'workspace', roster_policy: 'open' },
      workspace: { id: 'w1', name: 'Engineering', archived_at: null },
    } as unknown as ArchivedChannelListItemDto;
    expect(archivedRowWorkspaceLabel(item)).toBe('Engineering');
  });

  it('agent-space row renders the agent name from the bare aggregate name', () => {
    const item = {
      channel: { ...baseChannel, placement_kind: 'workspace', roster_policy: 'fixed' },
      workspace: { id: 'w2', name: 'Norman', archived_at: null },
    } as unknown as ArchivedChannelListItemDto;
    expect(archivedRowWorkspaceLabel(item)).toBe('Norman');
  });
});

describe('archivedRowOpenTarget — opens in the channel\'s OWN workspace', () => {
  const baseChannel = {
    id: 'c1',
    workspace_id: 'agent-home-ws',
    title: 'general',
    closed_at: null,
    archived_at: 1_000,
  };

  it('regular channel → its workspace id + channel id', () => {
    const item = {
      channel: { ...baseChannel, placement_kind: 'workspace', roster_policy: 'open' },
      workspace: { id: 'w1', name: 'Engineering', archived_at: null },
    } as unknown as ArchivedChannelListItemDto;
    expect(archivedRowOpenTarget(item)).toEqual({
      workspaceId: 'w1',
      channelId: 'c1',
    });
  });

  it('archived DM row → the agent_home workspace id + dm_channel id (not current context)', () => {
    // Pins the #task:1145 fix: clicking an archived DM must navigate to the
    // DM's agent_home workspace (the aggregate's `workspace.id`), so the
    // destination loads its archived channel-like list and the dm_channel
    // resolves — instead of staying in whatever workspace was selected.
    const item = {
      channel: { ...baseChannel, id: 'dm-c', placement_kind: 'workspace', roster_policy: 'fixed' },
      workspace: { id: 'agent-home-ws', name: 'Norman', archived_at: null },
    } as unknown as ArchivedChannelListItemDto;
    expect(archivedRowOpenTarget(item)).toEqual({
      workspaceId: 'agent-home-ws',
      channelId: 'dm-c',
    });
  });
});

/**
 * #task:1890 — the Archived view becomes the ONLY archive index, so its
 * workspace section decides whether an archived workspace is reachable at all
 * (the sidebar's `ARCHIVED` group, today's only selection entry, is retired by
 * #task:1889). Membership is therefore behavior, not painting: it must key off
 * `archived_at`, and it must answer to the same filter bar the channel section
 * uses.
 */
describe('archivedWorkspaceRows — membership + shared filters', () => {
  const ws = (over: Partial<WorkspaceListItem>): WorkspaceListItem => ({
    id: 'w1',
    name: 'Engineering',
    description: null,
    kind: 'regular',
    workspace_scope_ids: ['w1'],
    dm_agent_id: null,
    dm_channel_ids: [],
    archived_at: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  });
  const all = { workspaceId: null, since: null };

  it('keeps only workspaces with an archive stamp', () => {
    const rows = archivedWorkspaceRows(
      [
        ws({ id: 'live' }),
        ws({ id: 'gone', archived_at: 5_000 }),
      ],
      all,
    );
    expect(rows.map(w => w.id)).toEqual(['gone']);
  });

  it('scopes to the selected workspace filter', () => {
    const rows = archivedWorkspaceRows(
      [
        ws({ id: 'a', archived_at: 5_000 }),
        ws({ id: 'b', archived_at: 5_000 }),
      ],
      { workspaceId: 'b', since: null },
    );
    expect(rows.map(w => w.id)).toEqual(['b']);
  });

  it('applies the archived-date cutoff as a lower bound', () => {
    const rows = archivedWorkspaceRows(
      [
        ws({ id: 'old', archived_at: 1_000 }),
        ws({ id: 'recent', archived_at: 9_000 }),
      ],
      { workspaceId: null, since: 5_000 },
    );
    expect(rows.map(w => w.id)).toEqual(['recent']);
  });
});

describe('archivedWorkspaceRowLabel — one workspace, one label', () => {
  const ws = (over: Partial<WorkspaceListItem>): WorkspaceListItem => ({
    id: 'w1',
    name: 'Engineering',
    description: null,
    kind: 'regular',
    workspace_scope_ids: ['w1'],
    dm_agent_id: null,
    dm_channel_ids: [],
    archived_at: 5_000,
    created_at: 0,
    updated_at: 0,
    ...over,
  });

  it('regular workspace shows its bare name', () => {
    expect(archivedWorkspaceRowLabel(ws({}))).toBe('Engineering');
  });

  it('agent space converges on the same agent name the channel rows show', () => {
    // The list shape carries the `dm-` UI prefix (`workspaceToListItem`); the
    // channel rows' context line arrives bare. Both must read `Norman`.
    expect(archivedWorkspaceRowLabel(ws({ kind: 'dm', name: 'dm-Norman' }))).toBe(
      'Norman',
    );
  });
});
