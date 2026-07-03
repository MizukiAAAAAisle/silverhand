import { describe, expect, it } from 'vitest';
import { decodeMessageSeq } from '@silverhand/shared';
import type { MessageUnreadPointerDto } from '@silverhand/shared';
import type { ChannelLayout } from '@/router';
import {
  resolveRestoreNavigation,
  type RestoreNavigationInputs,
} from './restore-navigation';

function pointer(
  overrides: Partial<Omit<MessageUnreadPointerDto, 'seq'>> & { seq?: number } = {},
): MessageUnreadPointerDto {
  const { seq, ...rest } = overrides;
  return {
    conversation_id: 'c-a',
    message_id: 'm-1',
    seq: decodeMessageSeq(seq ?? 100),
    thread_root_id: 'root-1',
    ...rest,
  };
}

function inputs(
  overrides: Partial<RestoreNavigationInputs> = {},
): RestoreNavigationInputs {
  return {
    workspaceId: 'w-1',
    selectedChannelId: null,
    channels: [{ id: 'c-1' }, { id: 'c-2' }, { id: 'c-3' }],
    activeTopLevel: [{ id: 'c-1' }, { id: 'c-2' }, { id: 'c-3' }],
    jumpTargetChannelId: null,
    excludeId: null,
    rememberedChannelId: null,
    rememberedUnreadPointer: undefined,
    rememberedCloseWatermark: null,
    rememberedLayout: null,
    ...overrides,
  };
}

describe('resolveRestoreNavigation — none guards', () => {
  it('none when no workspace', () => {
    expect(resolveRestoreNavigation(inputs({ workspaceId: null }))).toEqual({
      kind: 'none',
    });
  });

  it('none when a channel is already selected', () => {
    expect(
      resolveRestoreNavigation(inputs({ selectedChannelId: 'c-2' })),
    ).toEqual({ kind: 'none' });
  });

  it('none when the channel list is still empty (racing the placeholder)', () => {
    expect(
      resolveRestoreNavigation(inputs({ channels: [], activeTopLevel: [] })),
    ).toEqual({ kind: 'none' });
  });

  it('none when nothing to jump/remember and no active fallback exists', () => {
    expect(
      resolveRestoreNavigation(
        inputs({ channels: [{ id: 'c-1' }], activeTopLevel: [] }),
      ),
    ).toEqual({ kind: 'none' });
  });
});

describe('resolveRestoreNavigation — honored jump wins', () => {
  it('opens the jump target when it exists in the workspace', () => {
    expect(
      resolveRestoreNavigation(inputs({ jumpTargetChannelId: 'c-2' })),
    ).toEqual({ kind: 'open-channel', channelId: 'c-2', reason: 'jump' });
  });

  it('jump beats a valid remembered channel', () => {
    expect(
      resolveRestoreNavigation(
        inputs({ jumpTargetChannelId: 'c-3', rememberedChannelId: 'c-2' }),
      ),
    ).toEqual({ kind: 'open-channel', channelId: 'c-3', reason: 'jump' });
  });

  it('a jump target that no longer exists is ignored (falls through)', () => {
    expect(
      resolveRestoreNavigation(
        inputs({ jumpTargetChannelId: 'gone', rememberedChannelId: 'c-2' }),
      ),
    ).toEqual({ kind: 'open-remembered', channelId: 'c-2', layout: null });
  });
});

describe('resolveRestoreNavigation — remembered channel', () => {
  const layout: ChannelLayout = { kind: 'threads-list' };

  it('restores the remembered layout when no fresh unread', () => {
    expect(
      resolveRestoreNavigation(
        inputs({ rememberedChannelId: 'c-2', rememberedLayout: layout }),
      ),
    ).toEqual({ kind: 'open-remembered', channelId: 'c-2', layout });
  });

  it('surfaces a fresh unread thread over the remembered layout', () => {
    expect(
      resolveRestoreNavigation(
        inputs({
          rememberedChannelId: 'c-2',
          rememberedLayout: layout,
          rememberedUnreadPointer: pointer({ seq: 101 }),
          rememberedCloseWatermark: decodeMessageSeq(100),
        }),
      ),
    ).toEqual({
      kind: 'jump-unread',
      channelId: 'c-2',
      messageId: 'm-1',
      threadRootId: 'root-1',
    });
  });

  it('a just-closed unread (seq at watermark) degrades to layout memory', () => {
    expect(
      resolveRestoreNavigation(
        inputs({
          rememberedChannelId: 'c-2',
          rememberedLayout: layout,
          rememberedUnreadPointer: pointer({ seq: 100 }),
          rememberedCloseWatermark: decodeMessageSeq(100),
        }),
      ),
    ).toEqual({ kind: 'open-remembered', channelId: 'c-2', layout });
  });

  it('skips the remembered channel when it is the just-archived primary', () => {
    expect(
      resolveRestoreNavigation(
        inputs({ rememberedChannelId: 'c-2', excludeId: 'c-2' }),
      ),
    ).toEqual({ kind: 'open-channel', channelId: 'c-1', reason: 'fallback' });
  });

  it('skips a remembered channel that no longer exists', () => {
    expect(
      resolveRestoreNavigation(inputs({ rememberedChannelId: 'gone' })),
    ).toEqual({ kind: 'open-channel', channelId: 'c-1', reason: 'fallback' });
  });
});

describe('resolveRestoreNavigation — default fallback', () => {
  it('picks the first active top-level channel', () => {
    expect(resolveRestoreNavigation(inputs())).toEqual({
      kind: 'open-channel',
      channelId: 'c-1',
      reason: 'fallback',
    });
  });

  it('excludes a just-archived primary from the fallback', () => {
    expect(
      resolveRestoreNavigation(inputs({ excludeId: 'c-1' })),
    ).toEqual({ kind: 'open-channel', channelId: 'c-2', reason: 'fallback' });
  });
});
