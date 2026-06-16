/**
 * #task:1145 — the global Archived recovery index mixes regular channels
 * AND archived DMs (`dm_channel`). A DM row/scope must read "DM <agentName>"
 * so it's distinguishable from a regular workspace name while every row
 * keeps the same `#` channel glyph (DM is channel-like, not a separate icon).
 *
 * The subtle part is that the SAME agent surfaces under two name shapes:
 *   - the `WorkspaceListItem` (filter dropdown) carries a UI `dm-` prefix
 *     (`workspaceToListItem`), e.g. `dm-Norman`;
 *   - the backend archived aggregate (`item.workspace.name`) returns the
 *     bare agent name (`insertAgentHome` sets `name = agent.name`), e.g.
 *     `Norman`.
 * Both must normalize to the identical "DM Norman" label. This pins that
 * convergence so a future change to either name shape fails loud.
 */
import { describe, expect, it } from 'vitest';
import type { ArchivedChannelListItemDto } from '@silverhand/shared';
import {
  archivedRowOpenTarget,
  archivedRowWorkspaceLabel,
  dmScopeLabel,
} from './ArchivedChannelsPanel';

describe('dmScopeLabel — both name shapes converge to "DM <agentName>"', () => {
  it('strips the UI `dm-` prefix (WorkspaceListItem / dropdown shape)', () => {
    expect(dmScopeLabel('dm-Norman')).toBe('DM Norman');
  });

  it('passes a bare agent name through (backend aggregate shape)', () => {
    expect(dmScopeLabel('Norman')).toBe('DM Norman');
  });

  it('only strips a leading `dm-`, not an interior or partial match', () => {
    expect(dmScopeLabel('admin-bot')).toBe('DM admin-bot');
  });
});

describe('archivedRowWorkspaceLabel — kind drives the context label', () => {
  const baseChannel = {
    id: 'c1',
    workspace_id: 'w1',
    title: 'general',
    parent_conversation_id: null,
    closed_at: null,
    archived_at: 1_000,
  };

  it('regular `channel` row shows the raw workspace name unchanged', () => {
    const item = {
      channel: { ...baseChannel, kind: 'channel' },
      workspace: { id: 'w1', name: 'Engineering', archived_at: null },
      thread_count: 0,
    } as unknown as ArchivedChannelListItemDto;
    expect(archivedRowWorkspaceLabel(item)).toBe('Engineering');
  });

  it('`dm_channel` row renders "DM <agentName>" from the bare aggregate name', () => {
    const item = {
      channel: { ...baseChannel, kind: 'dm_channel' },
      workspace: { id: 'w2', name: 'Norman', archived_at: null },
      thread_count: 0,
    } as unknown as ArchivedChannelListItemDto;
    expect(archivedRowWorkspaceLabel(item)).toBe('DM Norman');
  });
});

describe('archivedRowOpenTarget — opens in the channel\'s OWN workspace', () => {
  const baseChannel = {
    id: 'c1',
    workspace_id: 'agent-home-ws',
    title: 'general',
    parent_conversation_id: null,
    closed_at: null,
    archived_at: 1_000,
  };

  it('regular channel → its workspace id + channel id', () => {
    const item = {
      channel: { ...baseChannel, kind: 'channel' },
      workspace: { id: 'w1', name: 'Engineering', archived_at: null },
      thread_count: 0,
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
      channel: { ...baseChannel, id: 'dm-c', kind: 'dm_channel' },
      workspace: { id: 'agent-home-ws', name: 'Norman', archived_at: null },
      thread_count: 2,
    } as unknown as ArchivedChannelListItemDto;
    expect(archivedRowOpenTarget(item)).toEqual({
      workspaceId: 'agent-home-ws',
      channelId: 'dm-c',
    });
  });
});
